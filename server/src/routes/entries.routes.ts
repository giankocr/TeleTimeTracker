import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../db/prisma';
import { PERMISSIONS } from '../../../shared/types';
import { authenticate, hasPermission, requirePermission, visibleUserIds } from '../middleware/auth';
import { serializeEntries, serializeEntry } from '../services/entries.service';
import { listEntries } from '../services/report.service';
import { startTimer, pauseTimer, resumeTimer, stopTimer, cancelActive, getActiveEntry, liveSeconds } from '../services/timer.service';
import { resolveRange } from '../utils/time';
import { SETTING_KEYS, getSettingBool } from '../services/settings.service';
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
        taskId: z.string().optional(),
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
      taskId: f.taskId,
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
        taskId: z.string().optional(),
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

    // Cronometrar SOBRE una tarea concreta: el tramo queda enlazado a ella, que
    // es lo que permite ver el acumulado por tarea y borrar tarea + tramos.
    if (d.taskId) {
      const tarea = await prisma.task.findUnique({ where: { id: d.taskId }, select: { id: true } });
      if (!tarea) return reply.code(400).send({ error: 'La tarea indicada no existe', code: 'TASK_NOT_FOUND' });
    }

    const res = await startTimer({
      userId: targetUserId,
      roleKey: target.role.key,
      rawText: d.description ?? d.title ?? d.projectName ?? '',
      project: project
        ? { id: project.id, name: project.name, clientId: project.client.id, clientName: project.client.name, githubRepos: project.githubRepos }
        : null,
      projectName: d.projectName,
      clientName: d.clientName,
      taskId: d.taskId ?? null,
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
        taskId: z.string().nullable().optional(),
        /** Si se indica, se crea (o reutiliza) una tarea con ese título. */
        newTaskTitle: z.string().min(2).max(200).optional(),
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

    let project: { id: string; clientId: string } | null = null;
    if (d.projectId) {
      project = await prisma.clientProject.findUnique({
        where: { id: d.projectId },
        select: { id: true, clientId: true },
      });
      if (!project) return reply.code(400).send({ error: 'El proyecto indicado no existe', code: 'PROJECT_NOT_FOUND' });
    }

    // El registro manual también pertenece a una TAREA: si se indica una, se usa;
    // si no, se busca por título en el proyecto y se crea. Así el tiempo queda
    // agrupado por tarea igual que cuando se registra con el cronómetro.
    const { findOrCreateTask, recalcTaskTotals } = await import('../services/task.service');
    let taskId: string | null = null;
    if (d.taskId) {
      const tarea = await prisma.task.findUnique({ where: { id: d.taskId }, select: { id: true } });
      if (!tarea) return reply.code(400).send({ error: 'La tarea indicada no existe', code: 'TASK_NOT_FOUND' });
      taskId = tarea.id;
    } else if (d.newTaskTitle) {
      // Tarea nueva escrita a mano desde el panel: se crea dentro del proyecto
      // elegido (o sin proyecto) y el registro queda enlazado a ella.
      const tarea = await findOrCreateTask({
        userId,
        title: d.newTaskTitle,
        projectId: project?.id ?? null,
        clientId: project?.clientId ?? null,
        taskTypeId: d.taskTypeId ?? null,
        description: d.description ?? null,
      });
      taskId = tarea?.id ?? null;
    } else {
      const tarea = await findOrCreateTask({
        userId,
        title: d.title,
        projectId: project?.id ?? null,
        clientId: project?.clientId ?? null,
        taskTypeId: d.taskTypeId ?? null,
        description: d.description ?? null,
      });
      taskId = tarea?.id ?? null;
    }
    if (d.taskTypeId) {
      const tipo = await prisma.taskType.findUnique({ where: { id: d.taskTypeId }, select: { id: true } });
      if (!tipo) return reply.code(400).send({ error: 'El tipo de tarea indicado no existe', code: 'TASKTYPE_NOT_FOUND' });
    }

    const entry = await prisma.timeEntry.create({
      data: {
        userId,
        taskId,
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
      include: { user: { select: { fullName: true } }, task: { select: { id: true, title: true, status: true } }, project: { include: { client: true } }, client: true, taskType: true, tags: true },
    });
    if (taskId) {
      // Registrar tiempo implica que se trabajo en la tarea: pasa a EN CURSO.
      const { markTaskStatus } = await import('../services/task.service');
      await markTaskStatus(taskId, 'IN_PROGRESS');
      await recalcTaskTotals(taskId);
    }

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
        taskId: z.string().nullable().optional(),
        /** Si se indica, se crea (o reutiliza) una tarea con ese título. */
        newTaskTitle: z.string().min(2).max(200).optional(),
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

    // El proyecto y el tipo deben existir: antes, un id inexistente dejaba el
    // registro sin proyecto (y sin cliente) en silencio, devolviendo 200.
    let project: { id: string; clientId: string } | null | undefined;
    if (d.projectId !== undefined) {
      if (d.projectId) {
        const encontrado = await prisma.clientProject.findUnique({
          where: { id: d.projectId },
          select: { id: true, clientId: true },
        });
        if (!encontrado) return reply.code(400).send({ error: 'El proyecto indicado no existe', code: 'PROJECT_NOT_FOUND' });
        project = encontrado;
      } else {
        project = null;
      }
    }

    if (d.taskTypeId) {
      const tipo = await prisma.taskType.findUnique({ where: { id: d.taskTypeId }, select: { id: true } });
      if (!tipo) return reply.code(400).send({ error: 'El tipo de tarea indicado no existe', code: 'TASKTYPE_NOT_FOUND' });
    }

    // La tarea a la que pertenece el registro: se puede mover a otra existente,
    // crear una nueva por título, o dejarlo sin tarea (`taskId: null`). Un id
    // inexistente da 400 en lugar de dejar el registro apuntando al vacío.
    const projectIdFinal = project !== undefined ? (project?.id ?? null) : existing.projectId;
    const clientIdFinal = project !== undefined ? (project?.clientId ?? null) : existing.clientId;
    let taskId: string | null | undefined;
    if (d.newTaskTitle) {
      const { findOrCreateTask } = await import('../services/task.service');
      const tarea = await findOrCreateTask({
        userId: existing.userId,
        title: d.newTaskTitle,
        projectId: projectIdFinal,
        clientId: clientIdFinal,
        taskTypeId: d.taskTypeId ?? existing.taskTypeId,
        description: d.description ?? existing.description,
      });
      taskId = tarea?.id ?? null;
    } else if (d.taskId !== undefined) {
      if (d.taskId) {
        const tarea = await prisma.task.findUnique({ where: { id: d.taskId }, select: { id: true } });
        if (!tarea) return reply.code(400).send({ error: 'La tarea indicada no existe', code: 'TASK_NOT_FOUND' });
        taskId = tarea.id;
      } else {
        taskId = null;
      }
    }

    const durationSec = endedAt
      ? Math.max(0, Math.floor((endedAt.getTime() - startedAt.getTime()) / 1000))
      : existing.durationSec;

    const entry = await prisma.timeEntry.update({
      where: { id },
      data: {
        ...(d.title !== undefined ? { title: d.title } : {}),
        ...(d.description !== undefined ? { description: d.description } : {}),
        ...(project !== undefined ? { projectId: project?.id ?? null, clientId: project?.clientId ?? null } : {}),
        ...(taskId !== undefined ? { taskId } : {}),
        ...(d.taskTypeId !== undefined ? { taskTypeId: d.taskTypeId } : {}),
        ...(d.startedAt !== undefined ? { startedAt } : {}),
        ...(d.endedAt !== undefined ? { endedAt } : {}),
        ...(d.billable !== undefined ? { billable: d.billable } : {}),
        ...(d.status !== undefined ? { status: d.status } : {}),
        ...(endedAt ? { durationSec } : {}),
        editedById: auth.userId,
      },
      include: { user: { select: { fullName: true } }, task: { select: { id: true, title: true, status: true } }, project: { include: { client: true } }, client: true, taskType: true, tags: true },
    });
    // Los acumulados de las tareas afectadas se recalculan desde sus tramos.
    const { recalcTaskTotals } = await import('../services/task.service');
    if (existing.taskId) await recalcTaskTotals(existing.taskId);
    if (entry.taskId && entry.taskId !== existing.taskId) await recalcTaskTotals(entry.taskId);

    await audit(request, { action: 'entry.update', entity: 'timeEntry', entityId: id, metadata: d });
    return reply.send({ entry: serializeEntry(entry as any) });
  });

  // -------------------------------------------------------------------------
  // DELETE /api/entries/:id
  //
  // Dos modos, ambos con el permiso `entries:delete` (que solo tiene ADMIN):
  //   - por defecto      -> anula: status CANCELLED, se conserva el rastro y se
  //                         puede restaurar. Excluido de horas y reportes.
  //   - ?hard=1          -> ELIMINA el registro de la base (irreversible).
  //                         Requiere que el ajuste entries.allow_hard_delete
  //                         siga activo (lo esta por defecto).
  // -------------------------------------------------------------------------
  app.delete('/:id', { preHandler: [requirePermission(PERMISSIONS.ENTRIES_DELETE)] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const { hard } = request.query as { hard?: string };
    const auth = request.auth!;

    const existing = await prisma.timeEntry.findUnique({
      where: { id },
      include: { project: { select: { name: true } } },
    });
    if (!existing) return reply.code(404).send({ error: 'Registro no encontrado' });

    const visible = await visibleUserIds(auth);
    if (!visible.all && !visible.ids.includes(existing.userId)) {
      return reply.code(403).send({ error: 'Sin acceso a este registro' });
    }

    if (hard === '1') {
      if (!getSettingBool(SETTING_KEYS.ENTRIES_ALLOW_HARD_DELETE, true)) {
        return reply.code(403).send({
          error: 'El borrado definitivo está desactivado en la configuración. Usa «Anular».',
          code: 'HARD_DELETE_DISABLED',
        });
      }

      // Resumen para la auditoría: despues del borrado no queda el registro.
      const resumen = {
        userId: existing.userId,
        title: existing.title,
        project: existing.project?.name ?? null,
        durationSec: existing.durationSec,
        startedAt: existing.startedAt.toISOString(),
        status: existing.status,
      };

      // Las pausas y las etiquetas se eliminan en cascada (onDelete: Cascade).
      await prisma.timeEntry.delete({ where: { id } });

      // Los acumulados de la tarea se recalculan: al borrar un tramo cambian.
      if (existing.taskId) {
        const { recalcTaskTotals } = await import('../services/task.service');
        await recalcTaskTotals(existing.taskId);
      }
      await audit(request, {
        action: 'entry.delete_hard',
        entity: 'timeEntry',
        entityId: id,
        metadata: resumen,
      });
      return reply.send({ ok: true, deleted: true, summary: resumen });
    }

    // IMPORTANTE: se conserva la marca de fin ORIGINAL para poder restaurar el
    // registro con su duracion real (sobrescribirla la inflaba). Si estaba en
    // curso, se guarda su tiempo computado en `description`-like: aqui se cierra
    // con la duracion de los segmentos y se anota el fin real.
    const estabaEnCurso = existing.status === 'RUNNING' || existing.status === 'PAUSED';
    const duracionAlAnular = estabaEnCurso
      ? existing.durationSec + Math.max(0, Math.floor((Date.now() - existing.startedAt.getTime()) / 1000))
      : existing.durationSec;

    await prisma.timeEntry.update({
      where: { id },
      data: {
        status: 'CANCELLED',
        // A cero: es lo que lo excluye de horas y reportes.
        durationSec: 0,
        // Para un registro en curso, el fin es "ahora" (no hay marca previa).
        endedAt: existing.endedAt ?? new Date(),
        closeReason: 'MANUAL_WEB',
        editedById: auth.userId,
        // Se conserva el tiempo que tenia para poder restaurarlo tal cual.
        ...(estabaEnCurso ? { githubData: existing.githubData ?? null } : {}),
        description: estabaEnCurso
          ? [existing.description, `[anulado con ${duracionAlAnular}s]`].filter(Boolean).join('\n')
          : existing.description,
      },
    });
    if (existing.taskId) {
      const { recalcTaskTotals } = await import('../services/task.service');
      await recalcTaskTotals(existing.taskId);
    }

    await audit(request, { action: 'entry.cancel', entity: 'timeEntry', entityId: id });
    return reply.send({ ok: true, cancelled: true });
  });

  // -------------------------------------------------------------------------
  // POST /api/entries/:id/restore — deshace una anulación (no un borrado)
  // -------------------------------------------------------------------------
  app.post('/:id/restore', { preHandler: [requirePermission(PERMISSIONS.ENTRIES_DELETE)] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const auth = request.auth!;

    const existing = await prisma.timeEntry.findUnique({ where: { id } });
    if (!existing) return reply.code(404).send({ error: 'Registro no encontrado (¿se eliminó definitivamente?)' });
    if (existing.status !== 'CANCELLED') {
      return reply.code(400).send({ error: 'Ese registro no está anulado' });
    }

    const visible = await visibleUserIds(auth);
    if (!visible.all && !visible.ids.includes(existing.userId)) {
      return reply.code(403).send({ error: 'Sin acceso a este registro' });
    }

    // Se recalcula la duración desde las marcas ORIGINALES (que la anulación
    // conserva) descontando las pausas. Si no hubiera `endedAt`, el registro
    // estaba en curso y se cierra ahora.
    const endedAt = existing.endedAt ?? new Date();
    const pauses = await prisma.pause.findMany({ where: { entryId: id } });
    const pausasSeg = pauses.reduce((acc, p) => acc + (p.durationSec || 0), 0);
    // Si se anulo estando en curso, la duracion real quedo anotada al anular.
    const anotado = Number((existing.description ?? '').match(/\[anulado con (\d+)s\]/)?.[1] ?? NaN);
    const bruto = Math.floor((endedAt.getTime() - existing.startedAt.getTime()) / 1000);
    const totalSeg = Number.isFinite(anotado) ? anotado : Math.max(0, bruto - pausasSeg);

    const restored = await prisma.timeEntry.update({
      where: { id },
      data: { status: 'FINISHED', durationSec: totalSeg, closeReason: null, editedById: auth.userId },
      include: {
        user: { select: { fullName: true } },
        project: { include: { client: true } },
        client: true,
        taskType: true,
        tags: true,
      },
    });
    if (restored.taskId) {
      const { recalcTaskTotals } = await import('../services/task.service');
      await recalcTaskTotals(restored.taskId);
    }

    await audit(request, { action: 'entry.restore', entity: 'timeEntry', entityId: id, metadata: { durationSec: totalSeg } });
    return reply.send({ entry: serializeEntry(restored as any) });
  });
}
