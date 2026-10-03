import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../db/prisma';
import { PERMISSIONS } from '../../../shared/types';
import { authenticate, hasPermission, requirePermission, visibleUserIds } from '../middleware/auth';
import { serializeEntries, serializeEntry } from '../services/entries.service';
import { listEntries } from '../services/report.service';
import { startTimer, pauseTimer, resumeTimer, stopTimer, cancelActive, getActiveEntry, liveSeconds } from '../services/timer.service';
import { resolveRange } from '../utils/time';
import { audit } from '../utils/audit';

/**
 * Registros de tiempo.
 *  - Lectura con alcance por rol (own / team / all).
 *  - Escritura manual (correccion de horas) y control remoto del cronometro.
 */
export default async function entryRoutes(app: FastifyInstance): Promise<void> {
  const timezoneOf = async (userId: string): Promise<string> => {
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { timezone: true } });
    return user?.timezone ?? 'UTC';
  };

  // -------------------------------------------------------------------------
  // GET /api/entries
  // -------------------------------------------------------------------------
  app.get('/', { preHandler: [authenticate] }, async (request, reply) => {
    const auth = request.auth!;
    const canSeeOthers = hasPermission(auth, PERMISSIONS.ENTRIES_READ_ALL) || hasPermission(auth, PERMISSIONS.REPORTS_ALL);
    const q = z
      .object({
        preset: z.enum(['today', 'yesterday', 'last7', 'last30', 'thisMonth', 'lastMonth', 'custom']).optional(),
        from: z.string().optional(),
        to: z.string().optional(),
        userId: z.string().optional(),
        clientId: z.string().optional(),
        projectId: z.string().optional(),
        status: z.enum(['RUNNING', 'PAUSED', 'FINISHED', 'CANCELLED']).optional(),
        search: z.string().max(120).optional(),
        take: z.coerce.number().int().min(1).max(500).optional(),
        skip: z.coerce.number().int().min(0).optional(),
      })
      .safeParse(request.query);
    if (!q.success) return reply.code(400).send({ error: q.error.issues[0]?.message ?? 'Filtros invalidos' });
    const f = q.data;

    const tz = await timezoneOf(auth.userId);
    let from: Date;
    let to: Date;
    if (f.preset === 'custom' && f.from && f.to) {
      from = new Date(f.from);
      to = new Date(f.to);
    } else {
      const range = resolveRange(f.preset ?? 'last7', tz);
      from = range.from;
      to = range.to;
    }

    // Alcance de usuarios
    let userIds: string[] | undefined;
    if (f.userId) {
      const visible = await visibleUserIds(auth);
      if (!canSeeOthers && f.userId !== auth.userId) return reply.code(403).send({ error: 'Sin acceso a ese usuario' });
      if (!visible.all && !visible.ids.includes(f.userId) && f.userId !== auth.userId) {
        return reply.code(403).send({ error: 'Ese usuario no esta en tu equipo' });
      }
      userIds = [f.userId];
    } else {
      const visible = await visibleUserIds(auth);
      userIds = visible.all ? undefined : visible.ids;
    }

    const { rows, total } = await listEntries({
      from,
      to,
      userIds,
      clientId: f.clientId,
      projectId: f.projectId,
      status: f.status,
      search: f.search,
      take: f.take ?? 100,
      skip: f.skip ?? 0,
    });

    const entries = serializeEntries(rows as any[]);
    const totalSeconds = entries
      .filter((e) => e.status !== 'CANCELLED')
      .reduce((acc, e) => {
        const row = rows.find((r) => r.id === e.id)! as any;
        return acc + liveSeconds({ durationSec: row.durationSec, status: row.status, startedAt: row.startedAt });
      }, 0);

    return reply.send({
      entries,
      total,
      range: { from: from.toISOString(), to: to.toISOString() },
      totals: {
        seconds: totalSeconds,
        hours: Math.round((totalSeconds / 3600) * 100) / 100,
      },
    });
  });

  // -------------------------------------------------------------------------
  // GET /api/entries/active — cronometro actual del usuario autenticado
  // -------------------------------------------------------------------------
  app.get('/active', { preHandler: [authenticate] }, async (request, reply) => {
    const entry = await getActiveEntry(request.auth!.userId);
    return reply.send({ entry: entry ? serializeEntry(entry as any) : null });
  });

  // -------------------------------------------------------------------------
  // POST /api/entries/start | /pause | /resume | /stop  (control remoto del panel)
  // -------------------------------------------------------------------------
  app.post('/start', { preHandler: [authenticate] }, async (request, reply) => {
    const parsed = z
      .object({
        projectId: z.string().optional(),
        projectName: z.string().max(120).optional(),
        clientName: z.string().max(120).optional(),
        taskTypeId: z.string().optional(),
        title: z.string().max(180).optional(),
        description: z.string().max(2000).optional(),
        tag: z.string().max(60).optional(),
        billable: z.boolean().optional(),
        userId: z.string().optional(),
      })
      .safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'Datos invalidos' });
    const auth = request.auth!;
    const d = parsed.data;

    const targetUserId = d.userId ?? auth.userId;
    if (targetUserId !== auth.userId && !hasPermission(auth, PERMISSIONS.ENTRIES_READ_ALL)) {
      return reply.code(403).send({ error: 'No puedes iniciar el cronometro de otro usuario' });
    }
    const target = await prisma.user.findUnique({ where: { id: targetUserId }, include: { role: true } });
    if (!target) return reply.code(404).send({ error: 'Usuario no encontrado' });

    const project = d.projectId
      ? await prisma.clientProject.findUnique({ where: { id: d.projectId }, include: { client: true } })
      : null;
    const taskType = d.taskTypeId ? await prisma.taskType.findUnique({ where: { id: d.taskTypeId } }) : null;

    const res = await startTimer({
      userId: targetUserId,
      roleKey: target.role.key,
      rawText: d.description ?? d.title ?? d.projectName ?? '',
      project: project
        ? { id: project.id, name: project.name, clientId: project.client.id, clientName: project.client.name, githubRepos: project.githubRepos }
        : null,
      projectName: d.projectName,
      clientName: d.clientName,
      title: d.title,
      description: d.description,
      taskTypeName: taskType?.name,
      tag: d.tag,
      billable: d.billable,
      source: 'WEB',
    });
    await audit(request, { action: 'entry.start', entity: 'timeEntry', entityId: res.entry?.id ?? undefined });
    return reply.send({ entry: serializeEntry(res.entry as any), previous: res.previous ? serializeEntry(res.previous as any) : null, needsProject: res.needsProject, available: res.available ?? [] });
  });

  app.post('/pause', { preHandler: [authenticate] }, async (request, reply) => {
    const body = z.object({ reason: z.string().max(240).optional() }).safeParse(request.body ?? {});
    const res = await pauseTimer(request.auth!.userId, body.success ? body.data.reason : undefined, 'WEB');
    if (!res.ok) return reply.code(400).send({ error: res.message ?? 'No hay tarea activa' });
    return reply.send({ entry: res.entry ? serializeEntry(res.entry as any) : null });
  });

  app.post('/resume', { preHandler: [authenticate] }, async (request, reply) => {
    const res = await resumeTimer(request.auth!.userId, 'WEB');
    if (!res.ok) return reply.code(400).send({ error: res.message ?? 'No hay tarea activa' });
    return reply.send({ entry: res.entry ? serializeEntry(res.entry as any) : null });
  });

  app.post('/stop', { preHandler: [authenticate] }, async (request, reply) => {
    const body = z
      .object({ description: z.string().max(2000).optional(), enrichGithub: z.boolean().optional() })
      .safeParse(request.body ?? {});
    const res = await stopTimer({
      userId: request.auth!.userId,
      description: body.success ? body.data.description : undefined,
      enrichGithub: body.success ? body.data.enrichGithub : true,
      source: 'WEB',
    });
    if (!res.ok) return reply.code(400).send({ error: res.message ?? 'No hay tarea activa' });
    await audit(request, { action: 'entry.stop', entity: 'timeEntry', entityId: res.entry?.id });
    return reply.send({ entry: serializeEntry(res.entry as any) });
  });

  app.post('/cancel', { preHandler: [authenticate] }, async (request, reply) => {
    const res = await cancelActive(request.auth!.userId);
    return reply.send({ ok: res.ok, entry: res.entry ? serializeEntry(res.entry as any) : null });
  });

  // -------------------------------------------------------------------------
  // POST /api/entries — creacion manual (correccion de horas)
  // -------------------------------------------------------------------------
  app.post('/', { preHandler: [requirePermission(PERMISSIONS.ENTRIES_WRITE)] }, async (request, reply) => {
    const parsed = z
      .object({
        userId: z.string().optional(),
        projectId: z.string().nullable().optional(),
        taskTypeId: z.string().nullable().optional(),
        title: z.string().min(1).max(180),
        description: z.string().max(4000).nullable().optional(),
        startedAt: z.string(),
        endedAt: z.string(),
        billable: z.boolean().optional(),
        status: z.enum(['FINISHED', 'PAUSED', 'RUNNING']).optional(),
      })
      .safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'Datos invalidos' });
    const d = parsed.data;
    const auth = request.auth!;
    const userId = d.userId ?? auth.userId;

    if (userId !== auth.userId && !hasPermission(auth, PERMISSIONS.ENTRIES_READ_ALL)) {
      return reply.code(403).send({ error: 'No puedes registrar tiempo a nombre de otro usuario' });
    }

    const startedAt = new Date(d.startedAt);
    const endedAt = new Date(d.endedAt);
    if (Number.isNaN(startedAt.getTime()) || Number.isNaN(endedAt.getTime())) {
      return reply.code(400).send({ error: 'Fechas invalidas' });
    }
    if (endedAt <= startedAt) return reply.code(400).send({ error: 'La fecha de fin debe ser posterior al inicio' });

    const project = d.projectId
      ? await prisma.clientProject.findUnique({ where: { id: d.projectId }, select: { id: true, clientId: true } })
      : null;

    const entry = await prisma.timeEntry.create({
      data: {
        userId,
        projectId: project?.id ?? null,
        clientId: project?.clientId ?? null,
        taskTypeId: d.taskTypeId ?? null,
        title: d.title,
        description: d.description ?? null,
        startedAt,
        endedAt,
        durationSec: Math.floor((endedAt.getTime() - startedAt.getTime()) / 1000),
        status: 'FINISHED',
        billable: d.billable ?? true,
        source: 'WEB',
        closeReason: 'MANUAL_WEB',
        editedById: auth.userId,
      },
      include: { user: { select: { fullName: true } }, project: { include: { client: true } }, client: true, taskType: true, tags: true },
    });
    await audit(request, { action: 'entry.create_manual', entity: 'timeEntry', entityId: entry.id });
    return reply.code(201).send({ entry: serializeEntry(entry as any) });
  });

  // -------------------------------------------------------------------------
  // PATCH /api/entries/:id — corregir un registro
  // -------------------------------------------------------------------------
  app.patch('/:id', { preHandler: [requirePermission(PERMISSIONS.ENTRIES_WRITE)] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = z
      .object({
        title: z.string().min(1).max(180).optional(),
        description: z.string().max(4000).nullable().optional(),
        projectId: z.string().nullable().optional(),
        taskTypeId: z.string().nullable().optional(),
        startedAt: z.string().optional(),
        endedAt: z.string().nullable().optional(),
        billable: z.boolean().optional(),
        status: z.enum(['RUNNING', 'PAUSED', 'FINISHED', 'CANCELLED']).optional(),
      })
      .safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'Datos invalidos' });
    const d = parsed.data;
    const auth = request.auth!;

    const existing = await prisma.timeEntry.findUnique({ where: { id } });
    if (!existing) return reply.code(404).send({ error: 'Registro no encontrado' });

    const visible = await visibleUserIds(auth);
    if (!visible.all && !visible.ids.includes(existing.userId)) {
      return reply.code(403).send({ error: 'Sin acceso a este registro' });
    }

    const startedAt = d.startedAt ? new Date(d.startedAt) : existing.startedAt;
    const endedAt = d.endedAt !== undefined ? (d.endedAt ? new Date(d.endedAt) : null) : existing.endedAt;
    if (Number.isNaN(startedAt.getTime())) return reply.code(400).send({ error: 'Fecha de inicio invalida' });
    if (endedAt && Number.isNaN(endedAt.getTime())) return reply.code(400).send({ error: 'Fecha de fin invalida' });
    if (endedAt && endedAt <= startedAt) return reply.code(400).send({ error: 'La fecha de fin debe ser posterior al inicio' });

    const project =
      d.projectId !== undefined
        ? d.projectId
          ? await prisma.clientProject.findUnique({ where: { id: d.projectId }, select: { id: true, clientId: true } })
          : null
        : undefined;

    const durationSec = endedAt
      ? Math.max(0, Math.floor((endedAt.getTime() - startedAt.getTime()) / 1000))
      : existing.durationSec;

    const entry = await prisma.timeEntry.update({
      where: { id },
      data: {
        ...(d.title !== undefined ? { title: d.title } : {}),
        ...(d.description !== undefined ? { description: d.description } : {}),
        ...(project !== undefined ? { projectId: project?.id ?? null, clientId: project?.clientId ?? null } : {}),
        ...(d.taskTypeId !== undefined ? { taskTypeId: d.taskTypeId } : {}),
        ...(d.startedAt !== undefined ? { startedAt } : {}),
        ...(d.endedAt !== undefined ? { endedAt } : {}),
        ...(d.billable !== undefined ? { billable: d.billable } : {}),
        ...(d.status !== undefined ? { status: d.status } : {}),
        ...(endedAt ? { durationSec } : {}),
        editedById: auth.userId,
      },
      include: { user: { select: { fullName: true } }, project: { include: { client: true } }, client: true, taskType: true, tags: true },
    });
    await audit(request, { action: 'entry.update', entity: 'timeEntry', entityId: id, metadata: d });
    return reply.send({ entry: serializeEntry(entry as any) });
  });

  // -------------------------------------------------------------------------
  // DELETE /api/entries/:id
  // -------------------------------------------------------------------------
  app.delete('/:id', { preHandler: [requirePermission(PERMISSIONS.ENTRIES_DELETE)] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const existing = await prisma.timeEntry.findUnique({ where: { id } });
    if (!existing) return reply.code(404).send({ error: 'Registro no encontrado' });

    const visible = await visibleUserIds(request.auth!);
    if (!visible.all && !visible.ids.includes(existing.userId)) {
      return reply.code(403).send({ error: 'Sin acceso a este registro' });
    }

    await prisma.timeEntry.update({ where: { id }, data: { status: 'CANCELLED', durationSec: 0, endedAt: new Date(), closeReason: 'MANUAL_WEB' } });
    await audit(request, { action: 'entry.cancel', entity: 'timeEntry', entityId: id });
    return reply.send({ ok: true });
  });
}
