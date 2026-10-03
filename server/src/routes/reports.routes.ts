import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../db/prisma';
import { PERMISSIONS } from '../../../shared/types';
import { authenticate, hasPermission, visibleUserIds } from '../middleware/auth';
import { buildReport } from '../services/report.service';
import { serializeEntries } from '../services/entries.service';
import { resolveRange, formatLocal } from '../utils/time';
import { humanDuration } from '../utils/format';

/** Reportes y dashboard: metricas agregadas, ranking de equipo y export CSV. */
export default async function reportRoutes(app: FastifyInstance): Promise<void> {
  const filterSchema = z.object({
    preset: z.enum(['today', 'yesterday', 'last7', 'last30', 'thisMonth', 'lastMonth', 'custom']).optional(),
    from: z.string().optional(),
    to: z.string().optional(),
    userId: z.string().optional(),
    clientId: z.string().optional(),
    projectId: z.string().optional(),
    taskTypeId: z.string().optional(),
    onlyBillable: z.enum(['true', 'false']).optional(),
    scope: z.enum(['me', 'team', 'all']).optional(),
  });

  // -------------------------------------------------------------------------
  // GET /api/reports/dashboard
  // -------------------------------------------------------------------------
  app.get('/dashboard', { preHandler: [authenticate] }, async (request, reply) => {
    const auth = request.auth!;
    const q = filterSchema.safeParse(request.query);
    if (!q.success) return reply.code(400).send({ error: q.error.issues[0]?.message ?? 'Filtros invalidos' });
    const f = q.data;

    const me = await prisma.user.findUnique({ where: { id: auth.userId }, select: { timezone: true } });
    const tz = me?.timezone ?? 'UTC';

    let from: Date;
    let to: Date;
    if (f.preset === 'custom' && f.from && f.to) {
      from = new Date(f.from);
      to = new Date(f.to);
    } else {
      const range = resolveRange(f.preset ?? 'last30', tz);
      from = range.from;
      to = range.to;
    }

    // Alcance
    const visible = await visibleUserIds(auth);
    const scope = f.scope ?? (visible.all ? 'all' : hasPermission(auth, PERMISSIONS.REPORTS_TEAM) ? 'team' : 'me');
    let userIds: string[] | undefined;
    if (scope === 'me') userIds = [auth.userId];
    else if (scope === 'team') userIds = visible.all ? undefined : visible.ids;
    else userIds = undefined;
    if (f.userId) {
      if (!visible.all && !visible.ids.includes(f.userId)) return reply.code(403).send({ error: 'Usuario fuera de tu alcance' });
      userIds = [f.userId];
    }

    const report = await buildReport(
      {
        from,
        to,
        userIds,
        clientId: f.clientId,
        projectId: f.projectId,
        taskTypeId: f.taskTypeId,
        onlyBillable: f.onlyBillable === 'true',
      },
      tz,
    );

    // Contexto en vivo para el widget "ahora mismo"
    const activeEntries = await prisma.timeEntry.findMany({
      where: { status: { in: ['RUNNING', 'PAUSED'] }, ...(userIds ? { userId: { in: userIds } } : {}) },
      include: {
        user: { select: { id: true, fullName: true } },
        project: { include: { client: true } },
        client: true,
        taskType: true,
        tags: true,
        pauses: true,
      },
      orderBy: { startedAt: 'desc' },
      take: 25,
    });

    const [clients, projects, users, pending] = await Promise.all([
      prisma.client.count({ where: { isActive: true } }),
      prisma.clientProject.count({ where: { isActive: true } }),
      prisma.user.count({ where: { isActive: true } }),
      prisma.pendingTask.count({ where: { isDone: false, ...(userIds ? { userId: { in: userIds } } : {}) } }),
    ]);

    return reply.send({
      ...report,
      scope,
      active: serializeEntries(activeEntries as any[]),
      counters: { clients, projects, users, pendingTasks: pending },
    });
  });

  // -------------------------------------------------------------------------
  // GET /api/reports/team — ranking del equipo dentro del periodo
  // -------------------------------------------------------------------------
  app.get('/team', { preHandler: [authenticate] }, async (request, reply) => {
    const auth = request.auth!;
    if (!hasPermission(auth, PERMISSIONS.REPORTS_TEAM)) {
      return reply.code(403).send({ error: 'Se requiere permiso reports:team' });
    }
    const q = filterSchema.safeParse(request.query);
    const f = q.success ? q.data : {};

    const me = await prisma.user.findUnique({ where: { id: auth.userId }, select: { timezone: true } });
    const tz = me?.timezone ?? 'UTC';
    const range = resolveRange(f.preset ?? 'last7', tz);
    const visible = await visibleUserIds(auth);

    const report = await buildReport(
      {
        from: range.from,
        to: range.to,
        userIds: visible.all ? undefined : visible.ids,
        clientId: f.clientId,
        projectId: f.projectId,
      },
      tz,
    );

    const members = await prisma.user.findMany({
      where: { isActive: true, ...(visible.all ? {} : { id: { in: visible.ids } }) },
      select: { id: true, fullName: true, email: true, timezone: true, role: { select: { key: true, name: true } } },
      orderBy: { fullName: 'asc' },
    });

    const byUserId = new Map(report.byUser.map((b) => [b.key, b]));
    return reply.send({
      range: { from: range.from.toISOString(), to: range.to.toISOString(), label: range.label },
      members: members.map((m) => ({
        ...m,
        hours: byUserId.get(m.id)?.hours ?? 0,
        billableHours: byUserId.get(m.id)?.billableHours ?? 0,
        entries: byUserId.get(m.id)?.entries ?? 0,
      })),
      totals: report.totals,
    });
  });

  // -------------------------------------------------------------------------
  // GET /api/reports/export.csv
  // -------------------------------------------------------------------------
  app.get('/export.csv', { preHandler: [authenticate] }, async (request, reply) => {
    const auth = request.auth!;
    const q = filterSchema.safeParse(request.query);
    const f = q.success ? q.data : {};

    const me = await prisma.user.findUnique({ where: { id: auth.userId }, select: { timezone: true } });
    const tz = me?.timezone ?? 'UTC';
    const range = f.preset === 'custom' && f.from && f.to
      ? { from: new Date(f.from), to: new Date(f.to), label: 'Personalizado' }
      : resolveRange(f.preset ?? 'thisMonth', tz);

    const visible = await visibleUserIds(auth);
    const entries = await prisma.timeEntry.findMany({
      where: {
        startedAt: { gte: range.from, lt: range.to },
        status: { not: 'CANCELLED' },
        ...(visible.all ? {} : { userId: { in: visible.ids } }),
        ...(f.userId ? { userId: f.userId } : {}),
        ...(f.clientId ? { clientId: f.clientId } : {}),
        ...(f.projectId ? { projectId: f.projectId } : {}),
      },
      include: { user: { select: { fullName: true, email: true } }, project: { include: { client: true } }, client: true, taskType: true, tags: true },
      orderBy: { startedAt: 'asc' },
    });

    const header = [
      'fecha_inicio', 'hora_inicio', 'fecha_fin', 'hora_fin', 'duracion_hhmm',
      'horas_decimal', 'usuario', 'email', 'cliente', 'proyecto', 'tipo_tarea',
      'titulo', 'descripcion', 'facturable', 'estado', 'etiquetas',
    ];

    const rows = entries.map((e) => {
      const live = e.status === 'RUNNING' ? e.durationSec + Math.floor((Date.now() - e.startedAt.getTime()) / 1000) : e.durationSec;
      return [
        formatLocal(e.startedAt, tz, false),
        formatLocal(e.startedAt, tz, true),
        e.endedAt ? formatLocal(e.endedAt, tz, false) : '',
        e.endedAt ? formatLocal(e.endedAt, tz, true) : '',
        humanDuration(live),
        (live / 3600).toFixed(2),
        e.user.fullName,
        e.user.email,
        e.client?.name ?? e.project?.client?.name ?? '',
        e.project?.name ?? '',
        e.taskType?.name ?? '',
        e.title ?? '',
        (e.description ?? '').replace(/\s+/g, ' '),
        e.billable ? 'si' : 'no',
        e.status,
        (e.tags ?? []).map((t) => t.tag).join('|'),
      ];
    });

    const csv = [header, ...rows]
      .map((cols) => cols.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(','))
      .join('\n');

    reply
      .header('Content-Type', 'text/csv; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="tiempos_${new Date().toISOString().slice(0, 10)}.csv"`);
    return reply.send(`\uFEFF${csv}`); // BOM para Excel
  });

  // -------------------------------------------------------------------------
  // GET /api/reports/activity — feed para el dashboard
  // -------------------------------------------------------------------------
  app.get('/activity', { preHandler: [authenticate] }, async (request, reply) => {
    const auth = request.auth!;
    const visible = await visibleUserIds(auth);
    const entries = await prisma.timeEntry.findMany({
      where: { ...(visible.all ? {} : { userId: { in: visible.ids } }) },
      include: {
        user: { select: { fullName: true } },
        project: { include: { client: true } },
        client: true,
        taskType: true,
        tags: true,
        pauses: true,
      },
      orderBy: { updatedAt: 'desc' },
      take: 30,
    });
    return reply.send({ activity: serializeEntries(entries as any[]) });
  });
}
