import { prisma } from '../db/prisma';
import { hoursFromSeconds } from '../utils/format';
import { zonedDateString } from '../utils/time';
import type { DashboardReport, ReportBucket } from '../../../shared/types';

/**
 * Motor de reportes. Trabaja sobre TimeEntry aplicando la duracion "viva"
 * (segmentos RUNNING todavia sin cerrar) para que el dashboard nunca se vea atrasado.
 */

export interface ReportFilters {
  from: Date;
  to: Date;
  /** null/undefined => todos los usuarios visibles para el solicitante. */
  userIds?: string[];
  clientId?: string;
  projectId?: string;
  taskTypeId?: string;
  onlyBillable?: boolean;
  groupBy?: 'client' | 'project' | 'user' | 'taskType';
}

interface RawEntry {
  id: string;
  userId: string;
  durationSec: number;
  status: string;
  startedAt: Date;
  billable: boolean;
  clientId: string | null;
  projectId: string | null;
  taskTypeId: string | null;
  client: { name: string } | null;
  project: { name: string; client: { name: string } | null } | null;
  task: { id: string; title: string; status: string } | null;
  taskType: { name: string } | null;
  user: { fullName: string };
}

const liveOf = (e: RawEntry): number =>
  e.status === 'RUNNING'
    ? e.durationSec + Math.max(0, Math.floor((Date.now() - e.startedAt.getTime()) / 1000))
    : e.durationSec;

/** Acumulador interno: guarda segundos crudos para no perder precision con redondeos. */
interface BucketAcc {
  key: string;
  label: string;
  seconds: number;
  billableSeconds: number;
  entries: number;
}

function emptyBucket(key: string, label: string): BucketAcc {
  return { key, label, seconds: 0, billableSeconds: 0, entries: 0 };
}

function accumulate(map: Map<string, BucketAcc>, key: string, label: string, seconds: number, billable: boolean): void {
  const bucket = map.get(key) ?? emptyBucket(key, label);
  bucket.seconds += seconds;
  if (billable) bucket.billableSeconds += seconds;
  bucket.entries += 1;
  map.set(key, bucket);
}

const sortBuckets = (map: Map<string, BucketAcc>, limit?: number): ReportBucket[] => {
  const list = [...map.values()]
    .map<ReportBucket>((b) => ({
      key: b.key,
      label: b.label,
      hours: hoursFromSeconds(b.seconds),
      seconds: b.seconds,
      billableHours: hoursFromSeconds(b.billableSeconds),
      billableSeconds: b.billableSeconds,
      entries: b.entries,
    }))
    .sort((a, b) => b.hours - a.hours);
  return limit ? list.slice(0, limit) : list;
};

export async function buildReport(filters: ReportFilters, timezone: string): Promise<DashboardReport> {
  const entries = (await prisma.timeEntry.findMany({
    where: {
      status: { not: 'CANCELLED' },
      startedAt: { gte: filters.from, lt: filters.to },
      ...(filters.userIds && filters.userIds.length ? { userId: { in: filters.userIds } } : {}),
      ...(filters.clientId ? { clientId: filters.clientId } : {}),
      ...(filters.projectId ? { projectId: filters.projectId } : {}),
      ...(filters.taskTypeId ? { taskTypeId: filters.taskTypeId } : {}),
      ...(filters.onlyBillable ? { billable: true } : {}),
    },
    include: {
      client: { select: { name: true } },
      project: { select: { name: true, client: { select: { name: true } } } },
      taskType: { select: { name: true } },
      user: { select: { fullName: true } },
    },
  })) as unknown as RawEntry[];

  const byClient = new Map<string, BucketAcc>();
  const byProject = new Map<string, BucketAcc>();
  const byUser = new Map<string, BucketAcc>();
  const byTaskType = new Map<string, BucketAcc>();
  const daily = new Map<string, { seconds: number; billableSeconds: number }>();

  let totalSeconds = 0;
  let billableSeconds = 0;
  const users = new Set<string>();

  for (const entry of entries) {
    const seconds = liveOf(entry);
    totalSeconds += seconds;
    if (entry.billable) billableSeconds += seconds;
    users.add(entry.userId);

    accumulate(
      byClient,
      entry.clientId ?? 'none',
      entry.client?.name ?? entry.project?.client?.name ?? 'Sin cliente',
      seconds,
      entry.billable,
    );
    accumulate(byProject, entry.projectId ?? 'none', entry.project?.name ?? 'Sin proyecto', seconds, entry.billable);
    accumulate(byUser, entry.userId, entry.user.fullName, seconds, entry.billable);
    accumulate(byTaskType, entry.taskTypeId ?? 'none', entry.taskType?.name ?? 'Sin tipo', seconds, entry.billable);

    const day = zonedDateString(entry.startedAt, timezone);
    const bucket = daily.get(day) ?? { seconds: 0, billableSeconds: 0 };
    bucket.seconds += seconds;
    if (entry.billable) bucket.billableSeconds += seconds;
    daily.set(day, bucket);
  }

  const runningNow = await prisma.timeEntry.count({
    where: {
      status: 'RUNNING',
      ...(filters.userIds && filters.userIds.length ? { userId: { in: filters.userIds } } : {}),
    },
  });

  const dailyList = [...daily.entries()]
    .map(([date, v]) => ({
      date,
      hours: hoursFromSeconds(v.seconds),
      billableHours: hoursFromSeconds(v.billableSeconds),
    }))
    .sort((a, b) => a.date.localeCompare(b.date));

  return {
    range: { from: filters.from.toISOString(), to: filters.to.toISOString() },
    totals: {
      totalHours: hoursFromSeconds(totalSeconds),
      // Se conservan los segundos crudos: el bot los muestra sin redondeos.
      totalSeconds,
      billableHours: hoursFromSeconds(billableSeconds),
      entries: entries.length,
      users: users.size,
      runningNow,
      avgHoursPerUser: users.size ? hoursFromSeconds(Math.round(totalSeconds / users.size)) : 0,
    },
    byClient: sortBuckets(byClient, 20),
    byProject: sortBuckets(byProject, 20),
    byUser: sortBuckets(byUser, 50),
    byTaskType: sortBuckets(byTaskType, 20),
    daily: dailyList,
  };
}

/** Detalle de registros para la tabla del panel. */
export async function listEntries(params: {
  from: Date;
  to: Date;
  userIds?: string[];
  clientId?: string;
  projectId?: string;
  taskId?: string;
  status?: string;
  search?: string;
  take?: number;
  skip?: number;
}) {
  const where = {
    startedAt: { gte: params.from, lt: params.to },
    ...(params.userIds && params.userIds.length ? { userId: { in: params.userIds } } : {}),
    ...(params.clientId ? { clientId: params.clientId } : {}),
    ...(params.projectId ? { projectId: params.projectId } : {}),
    ...(params.taskId ? { taskId: params.taskId } : {}),
    ...(params.status ? { status: params.status } : {}),
    ...(params.search
      ? { OR: [{ title: { contains: params.search } }, { description: { contains: params.search } }] }
      : {}),
  };

  const [rows, total] = await Promise.all([
    prisma.timeEntry.findMany({
      where,
      include: {
        user: { select: { fullName: true } },
        task: { select: { id: true, title: true, status: true } },
        project: { include: { client: true } },
        client: true,
        taskType: true,
        tags: true,
      },
      orderBy: { startedAt: 'desc' },
      take: params.take ?? 50,
      skip: params.skip ?? 0,
    }),
    prisma.timeEntry.count({ where }),
  ]);

  return { rows, total };
}
