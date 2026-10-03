import { prisma } from '../db/prisma';
import { normalize } from './resolve.service';
import type { Prisma } from '@prisma/client';

/**
 * TAREAS
 *
 * Una tarea es la unidad de trabajo y **puede tener varios registros de tiempo**:
 * cada vez que se empieza, se pausa para otra cosa y se retoma, se crea un tramo
 * nuevo. Los acumulados (`totalSeconds`, `entryCount`, primera y ultima vez
 * trabajada) se mantienen aqui, en un unico sitio, para que no haya dos formas
 * de calcular lo mismo.
 *
 * Jerarquia: Cliente -> Proyecto -> Tarea -> Registro de tiempo
 */

export const TASK_STATUS = ['OPEN', 'IN_PROGRESS', 'DONE', 'CANCELLED'] as const;
export type TaskStatus = (typeof TASK_STATUS)[number];

export const TASK_STATUS_LABEL: Record<string, string> = {
  OPEN: 'Pendiente',
  IN_PROGRESS: 'En curso',
  DONE: 'Completada',
  CANCELLED: 'Cancelada',
};

/**
 * Recalcula los acumulados de una tarea a partir de sus tramos reales.
 *
 * IMPORTANTE: los acumulados se DERIVAN de los datos (no se incrementan a mano),
 * pero el ESTADO no se deduce automaticamente de ellos. Antes se hacia y era un
 * error: registrar un tramo ya pasado marcaba la tarea como COMPLETADA, y el
 * siguiente tramo de la misma tarea creaba OTRA tarea en lugar de agruparse.
 *
 * El estado lo decide quien corresponde:
 *  - el motor de tiempo marca EN CURSO al empezar a trabajar y COMPLETADA al
 *    cerrar la tarea (o cuando la cierra el usuario);
 *  - `recalcTaskTotals` solo mantiene aqui el invariante "hay un tramo abierto
 *    -> la tarea no puede estar completada".
 */
export async function recalcTaskTotals(taskId: string): Promise<void> {
  const entries = await prisma.timeEntry.findMany({
    where: { taskId, status: { not: 'CANCELLED' } },
    select: { durationSec: true, status: true, startedAt: true, endedAt: true },
  });

  const total = entries.reduce((acc, e) => acc + (e.durationSec ?? 0), 0);
  const hayTramoAbierto = entries.some((e) => e.status === 'RUNNING' || e.status === 'PAUSED');

  const fechas = entries.map((e) => e.startedAt.getTime());
  const fines = entries.map((e) => (e.endedAt ?? e.startedAt).getTime());

  const tarea = await prisma.task.findUnique({
    where: { id: taskId },
    select: { status: true, completedAt: true },
  });
  if (!tarea) return;

  const patch: Prisma.TaskUpdateInput = {
    totalSeconds: total,
    entryCount: entries.length,
    firstWorkedAt: fechas.length ? new Date(Math.min(...fechas)) : null,
    lastWorkedAt: fines.length ? new Date(Math.max(...fines)) : null,
  };

  // Un tramo abierto siempre implica tarea en curso; el resto de transiciones
  // de estado son explicitas (accion del usuario o del motor de tiempo).
  if (hayTramoAbierto && tarea.status !== 'IN_PROGRESS') {
    patch.status = 'IN_PROGRESS';
    patch.completedAt = null;
  }

  await prisma.task.update({ where: { id: taskId }, data: patch });
}

/** Marca la tarea como completada o en curso (accion explicita). */
export async function markTaskStatus(taskId: string, status: 'OPEN' | 'IN_PROGRESS' | 'DONE'): Promise<void> {
  await prisma.task.update({
    where: { id: taskId },
    data: { status, completedAt: status === 'DONE' ? new Date() : null },
  });
}

export interface ResolveTaskInput {
  userId: string;
  title: string;
  projectId?: string | null;
  clientId?: string | null;
  taskTypeId?: string | null;
  description?: string | null;
  /** Si es false y no existe, devuelve null en lugar de crearla. */
  createIfMissing?: boolean;
}

export interface ResolvedTask {
  id: string;
  title: string;
  status: string;
  created: boolean;
  totalSeconds: number;
  entryCount: number;
  /** Contexto heredable por el registro de tiempo. */
  projectId: string | null;
  clientId: string | null;
  taskTypeId: string | null;
}

/**
 * Encuentra la tarea del usuario con ese titulo en el mismo proyecto, o la crea.
 *
 * La comparacion es tolerante (minusculas, acentos y espacios) porque el titulo
 * llega de una nota de voz transcrita, donde la puntuacion varia.
 * Solo se reutilizan tareas NO cerradas: si la anterior se completo, empezar de
 * nuevo el mismo trabajo merece una tarea nueva.
 */
export async function findOrCreateTask(input: ResolveTaskInput): Promise<ResolvedTask | null> {
  const title = (input.title ?? '').trim().replace(/\s+/g, ' ').slice(0, 200);
  if (title.length < 2) return null;

  const candidatas = await prisma.task.findMany({
    where: {
      assigneeId: input.userId,
      status: { in: ['OPEN', 'IN_PROGRESS'] },
      ...(input.projectId ? { projectId: input.projectId } : {}),
    },
    select: { id: true, title: true, status: true, totalSeconds: true, entryCount: true, projectId: true, clientId: true, taskTypeId: true },
  });

  const buscado = normalize(title);
  const existente = candidatas.find((t) => normalize(t.title) === buscado);
  if (existente) {
    // Si llega informacion nueva (tipo, descripcion), se completa la tarea.
    const patch: Prisma.TaskUpdateInput = {};
    if (input.taskTypeId) patch.taskType = { connect: { id: input.taskTypeId } };
    if (input.description) patch.description = input.description;
    if (Object.keys(patch).length) await prisma.task.update({ where: { id: existente.id }, data: patch });

    return { ...existente, created: false };
  }

  if (input.createIfMissing === false) return null;

  const creada = await prisma.task.create({
    data: {
      title,
      description: input.description ?? null,
      status: 'OPEN',
      projectId: input.projectId ?? null,
      clientId: input.clientId ?? null,
      taskTypeId: input.taskTypeId ?? null,
      assigneeId: input.userId,
      createdById: input.userId,
    },
    select: { id: true, title: true, status: true, totalSeconds: true, entryCount: true, projectId: true, clientId: true, taskTypeId: true },
  });

  return { ...creada, created: true };
}

/** Tarea vinculada a un registro (para heredar proyecto/cliente/tipo). */
export async function taskContext(taskId: string) {
  return prisma.task.findUnique({
    where: { id: taskId },
    include: {
      project: { include: { client: true } },
      client: true,
      taskType: true,
      assignee: { select: { id: true, fullName: true, email: true } },
    },
  });
}

/** Marca una tarea como completada (o la reabre). */
export async function setTaskStatus(taskId: string, status: TaskStatus): Promise<void> {
  await prisma.task.update({
    where: { id: taskId },
    data: {
      status,
      completedAt: status === 'DONE' ? new Date() : null,
    },
  });
}

export interface TaskSummary {
  id: string;
  title: string;
  status: string;
  statusLabel: string;
  projectName: string | null;
  clientName: string | null;
  taskTypeName: string | null;
  assigneeName: string | null;
  totalSeconds: number;
  entryCount: number;
  firstWorkedAt: string | null;
  lastWorkedAt: string | null;
  estimatedHours: number | null;
  priority: string;
  dueDate: string | null;
}

/** Resumen de tareas para el panel y el bot. */
export async function listTasks(params: {
  userIds?: string[];
  projectId?: string;
  clientId?: string;
  status?: string;
  search?: string;
  take?: number;
  skip?: number;
}): Promise<{ tasks: TaskSummary[]; total: number }> {
  const where: Prisma.TaskWhereInput = {
    ...(params.userIds?.length ? { assigneeId: { in: params.userIds } } : {}),
    ...(params.projectId ? { projectId: params.projectId } : {}),
    ...(params.clientId ? { clientId: params.clientId } : {}),
    ...(params.status ? { status: params.status } : {}),
    ...(params.search
      ? { OR: [{ title: { contains: params.search } }, { description: { contains: params.search } }] }
      : {}),
  };

  const [rows, total] = await Promise.all([
    prisma.task.findMany({
      where,
      include: {
        project: { include: { client: { select: { name: true } } } },
        client: { select: { name: true } },
        taskType: { select: { name: true } },
        assignee: { select: { fullName: true } },
      },
      orderBy: [{ lastWorkedAt: 'desc' }, { createdAt: 'desc' }],
      take: params.take ?? 100,
      skip: params.skip ?? 0,
    }),
    prisma.task.count({ where }),
  ]);

  return {
    total,
    tasks: rows.map((t) => ({
      id: t.id,
      title: t.title,
      status: t.status,
      statusLabel: TASK_STATUS_LABEL[t.status] ?? t.status,
      projectName: t.project?.name ?? null,
      clientName: t.client?.name ?? t.project?.client?.name ?? null,
      taskTypeName: t.taskType?.name ?? null,
      assigneeName: t.assignee?.fullName ?? null,
      totalSeconds: t.totalSeconds,
      entryCount: t.entryCount,
      firstWorkedAt: t.firstWorkedAt?.toISOString() ?? null,
      lastWorkedAt: t.lastWorkedAt?.toISOString() ?? null,
      estimatedHours: t.estimatedHours,
      priority: t.priority,
      dueDate: t.dueDate?.toISOString() ?? null,
    })),
  };
}

/** Tareas abiertas de un usuario, para el listado del bot. */
export async function openTasksFor(userId: string, limit = 10) {
  return prisma.task.findMany({
    where: { assigneeId: userId, status: { in: ['OPEN', 'IN_PROGRESS'] } },
    include: { project: true, client: true },
    orderBy: [{ lastWorkedAt: 'desc' }, { createdAt: 'desc' }],
    take: limit,
  });
}
