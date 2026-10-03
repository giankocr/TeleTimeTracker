import { prisma } from '../db/prisma';
import { inferTaskType, resolveProject, resolveTaskType, type ResolvedProject } from './resolve.service';
import { cleanTitle } from './nlu.service';
import { resolveGithubRepos } from './github.service';
import { isoSecondsSince } from '../utils/format';
import { Prisma } from '@prisma/client';
import { findOrCreateTask, markTaskStatus, recalcTaskTotals } from './task.service';

/**
 * MOTOR DE TIEMPO (state machine).
 *
 * Reglas:
 *  - Un usuario puede tener como maximo 1 TimeEntry en estado RUNNING o PAUSED.
 *  - "start" cierra el segmento anterior (closeReason=SWITCH) y abre uno nuevo.
 *  - "pause" detiene el cronometro del segmento activo (status=PAUSED) y abre una Pause.
 *  - "resume" cierra la Pause y vuelve a RUNNING.
 *  - "stop" cierra el segmento, calcula durationSec (descontando pausas) y enriquece con GitHub.
 */

export type EntryWithRelations = Prisma.TimeEntryGetPayload<{ include: typeof entryInclude }>;

const entryInclude = {
  task: true,
  project: { include: { client: true } },
  client: true,
  taskType: true,
  pauses: true,
  tags: true,
  user: { select: { id: true, fullName: true, email: true, timezone: true, githubUsername: true, githubToken: true } },
} as const;

export const getEntry = (id: string) =>
  prisma.timeEntry.findUnique({ where: { id }, include: entryInclude });

/** Segmento activo (RUNNING o PAUSED) del usuario. */
export const getActiveEntry = (userId: string) =>
  prisma.timeEntry.findFirst({
    where: { userId, status: { in: ['RUNNING', 'PAUSED'] } },
    orderBy: { startedAt: 'desc' },
    include: entryInclude,
  });

/** Segundos vividos de un segmento (incluye el tramo en curso). */
export function liveSeconds(entry: { durationSec: number; status: string; startedAt: Date }, at = new Date()): number {
  if (entry.status === 'RUNNING') return entry.durationSec + isoSecondsSince(entry.startedAt, at);
  return entry.durationSec;
}

/** Segundos de pausa acumulados (incluye pausa abierta). */
export function pauseSeconds(pauses: Array<{ durationSec: number; startedAt: Date; endedAt: Date | null }>, at = new Date()): number {
  return pauses.reduce(
    (acc, p) => acc + (p.endedAt ? p.durationSec : isoSecondsSince(p.startedAt, at)),
    0,
  );
}

function accumulate(entry: { startedAt: Date; durationSec: number; status: string }, at = new Date()): number {
  if (entry.status !== 'RUNNING') return entry.durationSec;
  return entry.durationSec + isoSecondsSince(entry.startedAt, at);
}

export interface StartOptions {
  userId: string;
  roleKey: string;
  rawText: string;
  /** Tarea existente a la que pertenece este tramo. */
  taskId?: string | null;
  project?: ResolvedProject | null;
  projectName?: string;
  clientName?: string;
  taskTypeName?: string;
  title?: string;
  description?: string;
  tag?: string;
  source?: string;
  billable?: boolean;
  /** Si es true, el segmento anterior se descarta en lugar de cerrarse como SWITCH. */
  discardPrevious?: boolean;
}

export interface TimerResult {
  ok: boolean;
  action: 'start' | 'switch' | 'pause' | 'resume' | 'stop' | 'noop';
  entry?: EntryWithRelations;
  previous?: EntryWithRelations | null;
  message?: string;
  needsProject?: boolean;
  available?: ResolvedProject[];
}

/** Cierra un segmento abierto calculando duracion y enriqueciendo con GitHub. */
async function closeEntry(
  entryId: string,
  closeReason: 'SWITCH' | 'FINISH' | 'PAUSE' | 'IDLE_TIMEOUT' | 'MANUAL_WEB',
  at = new Date(),
): Promise<void> {
  const entry = await prisma.timeEntry.findUnique({ where: { id: entryId }, include: { pauses: true } });
  if (!entry) return;

  // Cierra pausas abiertas para no dejar huerfanos.
  const openPause = entry.pauses.find((p) => !p.endedAt);
  if (openPause) {
    await prisma.pause.update({
      where: { id: openPause.id },
      data: { endedAt: at, durationSec: isoSecondsSince(openPause.startedAt, at) },
    });
  }

  const durationSec = accumulate(entry, at);
  await prisma.timeEntry.update({
    where: { id: entryId },
    data: { endedAt: at, status: 'FINISHED', durationSec, closeReason },
  });
  // Los acumulados de la tarea se recalculan SIEMPRE desde sus tramos.
  if (entry.taskId) await recalcTaskTotals(entry.taskId);
}

/** Enriquecimiento GitHub en segundo plano (no bloquea la respuesta al usuario). */
function enrichInBackground(entryId: string, userId: string, projectId: string | null, from: Date, to: Date): void {
  if (!projectId) return;
  void resolveGithubRepos({ userId, projectId, from, to })
    .then(async (data) => {
      if (!data || (!data.commits.length && !data.pullRequests.length)) return;
      await prisma.timeEntry.update({
        where: { id: entryId },
        data: { githubData: JSON.stringify(data), githubSyncedAt: new Date() },
      });
    })
    .catch((err) => console.warn('[github] enriquecimiento fallido:', err.message));
}

// ---------------------------------------------------------------------------
// Acciones
// ---------------------------------------------------------------------------
export async function startTimer(options: StartOptions): Promise<TimerResult> {
  const { userId, roleKey, rawText } = options;

  // Resolver proyecto
  let project = options.project ?? null;
  let available: ResolvedProject[] = [];
  if (!project && (options.projectName || options.clientName || rawText)) {
    const res = await resolveProject(userId, roleKey, {
      projectName: options.projectName,
      clientName: options.clientName,
      rawText,
    });
    project = res.project;
    available = res.available;
  }

  // Resolver tipo de tarea (explicito o inferido)
  const titleText = options.title || rawText;
  let taskType = options.taskTypeName ? await resolveTaskType(options.taskTypeName) : null;
  if (!taskType) taskType = await inferTaskType(`${options.taskTypeName ?? ''} ${titleText}`);

  const previous = await getActiveEntry(userId);
  const now = new Date();

  if (previous) {
    if (options.discardPrevious) {
      await prisma.timeEntry.update({
        where: { id: previous.id },
        data: { status: 'CANCELLED', endedAt: now, durationSec: accumulate(previous, now), closeReason: 'MANUAL_WEB' },
      });
    } else {
      await closeEntry(previous.id, 'SWITCH', now);
      enrichInBackground(previous.id, userId, previous.projectId, previous.startedAt, now);
    }
  }

  // La tarea es la entidad de trabajo; el registro es un tramo de esa tarea.
  // Si el usuario ya eligio una tarea, se reutiliza; si no, se busca por titulo
  // en el mismo proyecto y, si no existe, se crea.
  const tituloTarea = options.title?.trim() || cleanTitle(titleText) || 'Tarea sin titulo';
  const tareaExistente = options.taskId
    ? await prisma.task.findUnique({
        where: { id: options.taskId },
        select: { id: true, title: true, projectId: true, clientId: true, taskTypeId: true },
      })
    : await findOrCreateTask({
        userId,
        title: tituloTarea,
        projectId: project?.id ?? null,
        clientId: project?.clientId ?? null,
        taskTypeId: taskType?.id ?? null,
        description: options.description ?? null,
      });

  const entry = await prisma.timeEntry.create({
    data: {
      userId,
      taskId: tareaExistente?.id ?? null,
      projectId: project?.id ?? tareaExistente?.projectId ?? null,
      clientId: project?.clientId ?? tareaExistente?.clientId ?? null,
      taskTypeId: taskType?.id ?? tareaExistente?.taskTypeId ?? null,
      // Si el NLU no aporta un titulo, se limpia la frase original para el historial.
      title: tareaExistente?.title ?? tituloTarea,
      description: options.description ?? null,
      status: 'RUNNING',
      source: options.source ?? 'TELEGRAM_TEXT',
      billable: options.billable ?? true,
      startedAt: now,
      tags: options.tag ? { create: [{ tag: options.tag }] } : undefined,
    },
    include: entryInclude,
  });

  // Al empezar a trabajar, la tarea pasa a EN CURSO; luego se recalculan los
  // acumulados desde sus tramos.
  if (entry.taskId) {
    await markTaskStatus(entry.taskId, 'IN_PROGRESS');
    await recalcTaskTotals(entry.taskId);
  }

  return {
    ok: true,
    action: previous ? 'switch' : 'start',
    entry,
    previous: previous ?? null,
    needsProject: !project,
    available,
  };
}

export async function pauseTimer(userId: string, reason?: string, source = 'TELEGRAM_TEXT'): Promise<TimerResult> {
  const entry = await getActiveEntry(userId);
  if (!entry) return { ok: false, action: 'noop', message: 'No tienes ninguna tarea en curso.' };
  if (entry.status === 'PAUSED') return { ok: true, action: 'noop', entry, message: 'La tarea ya estaba en pausa.' };

  const now = new Date();
  const durationSec = accumulate(entry, now);
  await prisma.pause.create({ data: { entryId: entry.id, startedAt: now, reason: reason ?? null } });
  const updated = await prisma.timeEntry.update({
    where: { id: entry.id },
    data: { status: 'PAUSED', durationSec },
    include: entryInclude,
  });
  if (updated.taskId) await recalcTaskTotals(updated.taskId);
  void source;
  return { ok: true, action: 'pause', entry: updated };
}

export async function resumeTimer(userId: string, source = 'TELEGRAM_TEXT'): Promise<TimerResult> {
  const entry = await getActiveEntry(userId);
  if (!entry) return { ok: false, action: 'noop', message: 'No tienes ninguna tarea en curso.' };
  if (entry.status === 'RUNNING') return { ok: true, action: 'noop', entry, message: 'La tarea ya estaba corriendo.' };

  const now = new Date();
  const openPause = entry.pauses.find((p) => !p.endedAt);
  if (openPause) {
    await prisma.pause.update({
      where: { id: openPause.id },
      data: { endedAt: now, durationSec: isoSecondsSince(openPause.startedAt, now) },
    });
  }
  const updated = await prisma.timeEntry.update({
    where: { id: entry.id },
    data: { status: 'RUNNING', startedAt: now },
    include: entryInclude,
  });
  if (updated.taskId) await recalcTaskTotals(updated.taskId);
  void source;
  return { ok: true, action: 'resume', entry: updated };
}

export interface StopOptions {
  userId: string;
  description?: string;
  taskTypeName?: string;
  tag?: string;
  source?: string;
  /** Enriquecer con commits/PRs de GitHub de la ventana trabajada. */
  enrichGithub?: boolean;
}

export async function stopTimer(options: StopOptions): Promise<TimerResult> {
  const { userId } = options;
  const entry = await getActiveEntry(userId);
  if (!entry) return { ok: false, action: 'noop', message: 'No tienes ninguna tarea en curso.' };

  const now = new Date();
  const openPause = entry.pauses.find((p) => !p.endedAt);
  if (openPause) {
    await prisma.pause.update({
      where: { id: openPause.id },
      data: { endedAt: now, durationSec: isoSecondsSince(openPause.startedAt, now) },
    });
  }

  const durationSec = accumulate(entry, now);
  const extraType = options.taskTypeName ? await resolveTaskType(options.taskTypeName) : null;

  const updated = await prisma.timeEntry.update({
    where: { id: entry.id },
    data: {
      endedAt: now,
      status: 'FINISHED',
      closeReason: 'FINISH',
      durationSec,
      description: options.description ? [entry.description, options.description].filter(Boolean).join('\n') : entry.description,
      taskTypeId: extraType?.id ?? entry.taskTypeId,
      tags: options.tag ? { create: [{ tag: options.tag }] } : undefined,
    },
    include: entryInclude,
  });

  if (updated.taskId) await recalcTaskTotals(updated.taskId);

  if (options.enrichGithub !== false) {
    await resolveGithubRepos({ userId, projectId: updated.projectId, from: updated.startedAt, to: now })
      .then(async (data) => {
        if (!data || (!data.commits.length && !data.pullRequests.length)) return;
        return prisma.timeEntry.update({
          where: { id: updated.id },
          data: { githubData: JSON.stringify(data), githubSyncedAt: new Date() },
        });
      })
      .catch((err) => console.warn('[github] enriquecimiento fallido:', err.message));
  }

  const final = await getEntry(updated.id);
  return { ok: true, action: 'stop', entry: final ?? updated };
}

export async function switchTask(options: StartOptions): Promise<TimerResult> {
  const res = await startTimer(options);
  return { ...res, action: 'switch' };
}

/** Cancela el segmento activo sin contabilizarlo. */
export async function cancelActive(userId: string): Promise<TimerResult> {
  const entry = await getActiveEntry(userId);
  if (!entry) return { ok: false, action: 'noop', message: 'No hay tarea activa.' };
  const now = new Date();
  await prisma.timeEntry.update({
    where: { id: entry.id },
    data: { status: 'CANCELLED', endedAt: now, durationSec: accumulate(entry, now), closeReason: 'MANUAL_WEB' },
  });
  if (entry.taskId) await recalcTaskTotals(entry.taskId);
  return { ok: true, action: 'stop', entry };
}

/** Cierra automaticamente segmentos abiertos de dias anteriores (higiene de datos). */
export async function autoCloseStaleEntries(): Promise<number> {
  const limit = new Date(Date.now() - 16 * 3600 * 1000);
  const stale = await prisma.timeEntry.findMany({
    where: { status: { in: ['RUNNING', 'PAUSED'] }, startedAt: { lt: limit } },
    include: { pauses: true },
  });
  for (const entry of stale) {
    const now = new Date();
    const openPause = entry.pauses.find((p) => !p.endedAt);
    if (openPause) {
      await prisma.pause.update({
        where: { id: openPause.id },
        data: { endedAt: now, durationSec: isoSecondsSince(openPause.startedAt, now) },
      });
    }
    await prisma.timeEntry.update({
      where: { id: entry.id },
      data: { status: 'FINISHED', endedAt: now, durationSec: accumulate(entry, now), closeReason: 'IDLE_TIMEOUT' },
    });
  }
  return stale.length;
}
