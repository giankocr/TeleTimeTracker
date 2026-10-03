import type { TimeEntry, Pause, EntryTag, Prisma } from '@prisma/client';
import type { ApiTimeEntry } from '../../../shared/types';
import { liveSeconds, pauseSeconds } from './timer.service';

/** Tipo con relaciones para serializar. */
export type EntryForApi = TimeEntry & {
  pauses?: Pause[];
  tags?: EntryTag[];
  task?: { id: string; title: string; status: string } | null;
  user?: { fullName: string } | null;
  project?: ({ id: string; name: string; client?: { name: string } | null }) | null;
  client?: { name: string } | null;
  taskType?: { name: string } | null;
};

/** Normaliza un registro (con duracion "viva") para el panel y la API. */
export function serializeEntry(entry: EntryForApi): ApiTimeEntry & { liveSeconds: number; pauseSeconds: number } {
  const live = liveSeconds({ durationSec: entry.durationSec, status: entry.status, startedAt: entry.startedAt });
  const paused = pauseSeconds(
    (entry.pauses ?? []).map((p) => ({ durationSec: p.durationSec, startedAt: p.startedAt, endedAt: p.endedAt })),
  );
  return {
    id: entry.id,
    userId: entry.userId,
    userName: entry.user?.fullName,
    taskId: entry.taskId ?? null,
    taskTitle: entry.task?.title ?? null,
    taskStatus: entry.task?.status ?? null,
    clientId: entry.clientId,
    clientName: entry.client?.name ?? entry.project?.client?.name ?? null,
    projectId: entry.projectId,
    projectName: entry.project?.name ?? null,
    taskTypeId: entry.taskTypeId,
    taskTypeName: entry.taskType?.name ?? null,
    title: entry.title,
    description: entry.description,
    startedAt: entry.startedAt.toISOString(),
    endedAt: entry.endedAt ? entry.endedAt.toISOString() : null,
    durationSec: entry.durationSec,
    status: entry.status as ApiTimeEntry['status'],
    billable: entry.billable,
    source: entry.source,
    closeReason: entry.closeReason,
    tags: (entry.tags ?? []).map((t) => t.tag),
    liveSeconds: live,
    pauseSeconds: paused,
  };
}

export const serializeEntries = (entries: EntryForApi[]) => entries.map(serializeEntry);

/** Fragmento de where reutilizable (por si otro modulo lo necesita). */
export type EntryWhere = Prisma.TimeEntryWhereInput;
