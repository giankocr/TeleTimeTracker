import { prisma } from '../db/prisma';
import { hoursFromSeconds } from '../utils/format';
import { zonedDateString } from '../utils/time';
import { getSetting, SETTING_KEYS } from './settings.service';
import { billingStatusText, normalizeLocale, tr, type ReportLocale } from '../../../shared/i18n';
import { TASK_STATUS_LABEL } from './task.service';
import {
  DEFAULT_CURRENCY,
  roundMoney,
  type BillingOverview,
  type BillingStatus,
  type BillingTicketRow,
  type ClientStatement,
  type InvoiceGroup,
  type RateSource,
  type StatementTicket,
  type StatementTotals,
} from '../../../shared/types';

/**
 * FACTURACIÓN Y REPORTE PARA EL CLIENTE
 *
 * Modelo (ver schema.prisma → model Task):
 *   · El estado de facturación vive en la TAREA (el tiquete): se factura trabajo
 *     entregado, y un tiquete puede acumular varios tramos de tiempo.
 *   · `invoiceRef` (nº de factura) es lo que agrupa varias tareas en una misma
 *     factura. No hay entidad "Factura": la factura es el conjunto de tiquetes
 *     que comparten ese número.
 *   · `billedAmount` se congela al facturar. Así, si después se registran más
 *     horas en ese tiquete, el importe ya cobrado no cambia.
 *
 * Hay dos vistas, con dos preguntas distintas:
 *   · `billingOverview`    → "¿qué tengo pendiente de cobrar?" Lista TIQUEtes y
 *                            se puede acotar a un periodo (o ver todo).
 *   · `buildClientStatement` → "¿qué le entrego al cliente?" Lista HORAS del
 *                            periodo, agrupadas por tiquete, para imprimir.
 */

// ---------------------------------------------------------------------------
// Moneda y tarifas
// ---------------------------------------------------------------------------

/** Moneda configurada en Ajustes (código ISO). */
export const billingCurrency = (): string =>
  (getSetting(SETTING_KEYS.BILLING_CURRENCY, DEFAULT_CURRENCY) || DEFAULT_CURRENCY).toUpperCase();

interface RateContext {
  /** Tarifa propia del tiquete (manda sobre las demás). */
  taskRate: number | null;
  projectRate: number | null;
  clientRate: number | null;
}

/**
 * Tarifa por hora aplicada, en cascada: tiquete -> proyecto -> cliente.
 * Se resuelve en cascada porque lo habitual es fijar la tarifa en el proyecto,
 * pero un cliente puede tener una tarifa marco y un tiquete puntual otra.
 */
export function resolveRate(ctx: RateContext): { rate: number | null; source: RateSource | null } {
  if (typeof ctx.taskRate === 'number' && ctx.taskRate >= 0) return { rate: ctx.taskRate, source: 'TASK' };
  if (typeof ctx.projectRate === 'number' && ctx.projectRate >= 0) return { rate: ctx.projectRate, source: 'PROJECT' };
  if (typeof ctx.clientRate === 'number' && ctx.clientRate >= 0) return { rate: ctx.clientRate, source: 'CLIENT' };
  return { rate: null, source: null };
}

/** Importe de unas horas a una tarifa, redondeado según la moneda. */
export const amountFor = (seconds: number, rate: number | null, currency: string): number | null =>
  rate === null ? null : roundMoney((seconds / 3600) * rate, currency);

/** Segundos "vivos": un tramo en curso todavía no tiene su duración cerrada. */
interface LiveEntry {
  status: string;
  durationSec: number;
  startedAt: Date;
}

const liveSeconds = (e: LiveEntry): number =>
  e.status === 'RUNNING'
    ? e.durationSec + Math.max(0, Math.floor((Date.now() - e.startedAt.getTime()) / 1000))
    : e.durationSec;

const totalsOf = (seconds: number, amount: number): StatementTotals => ({
  seconds,
  hours: hoursFromSeconds(seconds),
  amount,
});

// ---------------------------------------------------------------------------
// Marcado de facturación (una tarea o un grupo)
// ---------------------------------------------------------------------------

export interface MarkBillingInput {
  /** Tiquetes a marcar. */
  taskIds?: string[];
  /** Alternativa: marca TODOS los tiquetes de esa factura. */
  invoiceRef?: string;
  status: BillingStatus;
  /** Nº de factura a asignar (si se omite, se conserva el que tuviera). */
  invoiceRefNew?: string | null;
  billedAt?: Date | null;
  paidAt?: Date | null;
  /**
   * Importe POR TIQUETE. Si se omite, se calcula horas x tarifa. Útil para
   * tarifas planas o ajustes negociados.
   */
  amount?: number | null;
}

export interface MarkBillingResult {
  updated: number;
  status: BillingStatus;
  invoiceRef: string | null;
  taskIds: string[];
}

/**
 * Marca tiquetes como facturados / pagados / pendientes.
 *
 * Transiciones:
 *   BILLED  → fija billedAt (ahora o la fecha dada) y CONGELA billedAmount.
 *   PAID    → fija paidAt y conserva billedAt (si nunca se facturó, lo fija).
 *   PENDING → deshace el cobro: limpia fechas, nº de factura e importe.
 *             El rastro de que estuvo facturado queda en la auditoría.
 */
export async function markTasksBilling(input: MarkBillingInput): Promise<MarkBillingResult> {
  const ids = input.invoiceRef
    ? (
        await prisma.task.findMany({
          where: { invoiceRef: input.invoiceRef },
          select: { id: true },
        })
      ).map((t) => t.id)
    : [...new Set(input.taskIds ?? [])];

  if (!ids.length) return { updated: 0, status: input.status, invoiceRef: input.invoiceRefNew ?? null, taskIds: [] };

  const currency = billingCurrency();
  const now = new Date();

  const tasks = await prisma.task.findMany({
    where: { id: { in: ids } },
    include: {
      project: { select: { hourlyRate: true } },
      client: { select: { hourlyRate: true } },
      timeEntries: { select: { status: true, durationSec: true, startedAt: true } },
    },
  });

  const touched: string[] = [];

  for (const task of tasks) {
    // Las horas del tiquete se derivan de sus tramos (no del acumulado) para que
    // un tramo en curso cuente con su tiempo real y no se congele a medias.
    const seconds = task.timeEntries.reduce((acc, e) => acc + liveSeconds(e), 0);
    const { rate } = resolveRate({
      taskRate: task.hourlyRate,
      projectRate: task.project?.hourlyRate ?? null,
      clientRate: task.client?.hourlyRate ?? null,
    });
    const calculated = amountFor(seconds, rate, currency);
    const explicit = input.amount === undefined ? undefined : input.amount;
    // El importe se congela la primera vez: recalcularlo en cada marcado haría
    // que una factura ya emitida cambiara sola al registrar horas nuevas.
    const frozen = explicit !== undefined && explicit !== null ? explicit : task.billedAmount ?? calculated;

    const data =
      input.status === 'PENDING'
        ? { billingStatus: 'PENDING', billedAt: null, paidAt: null, invoiceRef: null, billedAmount: null }
        : input.status === 'BILLED'
          ? {
              billingStatus: 'BILLED',
              billedAt: input.billedAt ?? now,
              // Refacturar no debe dejar una marca de pago vieja.
              paidAt: null,
              invoiceRef: input.invoiceRefNew !== undefined ? input.invoiceRefNew : task.invoiceRef,
              billedAmount: frozen,
            }
          : {
              billingStatus: 'PAID',
              billedAt: task.billedAt ?? input.billedAt ?? now,
              paidAt: input.paidAt ?? now,
              invoiceRef: input.invoiceRefNew !== undefined ? input.invoiceRefNew : task.invoiceRef,
              billedAmount: frozen,
            };

    await prisma.task.update({ where: { id: task.id }, data });
    touched.push(task.id);
  }

  return {
    updated: touched.length,
    status: input.status,
    invoiceRef: input.invoiceRefNew ?? input.invoiceRef ?? null,
    taskIds: touched,
  };
}

// ---------------------------------------------------------------------------
// Vista de control: tiquetes y su estado de cobro
// ---------------------------------------------------------------------------

export interface BillingQuery {
  /** Si se indican fechas, las horas son las del periodo; si no, las del tiquete completo. */
  from?: Date;
  to?: Date;
  userIds?: string[];
  clientId?: string;
  projectId?: string;
  billingStatus?: BillingStatus;
  invoiceRef?: string;
  search?: string;
  take?: number;
  skip?: number;
  scope?: 'me' | 'team' | 'all';
}

/**
 * Acumulador interno de una factura. Se usan `Date` (no string) mientras se
 * agrupa para poder comparar fechas; al devolver se serializan a ISO.
 */
interface InvoiceAcc {
  invoiceRef: string;
  clientNames: string[];
  tickets: number;
  seconds: number;
  hours: number;
  amount: number;
  billingStatus: string;
  billedAt: Date | null;
  paidAt: Date | null;
  taskIds: string[];
}

interface RawTask {
  id: string;
  title: string;
  reference: string | null;
  status: string;
  totalSeconds: number;
  entryCount: number;
  firstWorkedAt: Date | null;
  lastWorkedAt: Date | null;
  hourlyRate: number | null;
  billingStatus: string;
  billedAt: Date | null;
  paidAt: Date | null;
  invoiceRef: string | null;
  billedAmount: number | null;
  clientId: string | null;
  projectId: string | null;
  taskTypeId: string | null;
  client: { name: string; hourlyRate: number | null } | null;
  project: { name: string; hourlyRate: number | null } | null;
  taskType: { name: string } | null;
  assignee: { fullName: string } | null;
}

export async function billingOverview(query: BillingQuery): Promise<BillingOverview> {
  const currency = billingCurrency();
  const period = Boolean(query.from && query.to);

  const where = {
    // Un tiquete sin tramos no tiene nada que facturar.
    entryCount: { gt: 0 },
    ...(query.billingStatus ? { billingStatus: query.billingStatus } : {}),
    ...(query.invoiceRef ? { invoiceRef: query.invoiceRef } : {}),
    ...(query.clientId ? { clientId: query.clientId } : {}),
    ...(query.projectId ? { projectId: query.projectId } : {}),
    ...(query.userIds?.length ? { assigneeId: { in: query.userIds } } : {}),
    ...(query.search
      ? {
          OR: [
            { title: { contains: query.search } },
            { description: { contains: query.search } },
            { reference: { contains: query.search } },
            { invoiceRef: { contains: query.search } },
          ],
        }
      : {}),
  };

  // En modo periodo se listan los tiquetes con actividad dentro del rango.
  const periodWhere = period
    ? { timeEntries: { some: { startedAt: { gte: query.from, lt: query.to }, status: { not: 'CANCELLED' } } } }
    : {};

  const [rows, total] = await Promise.all([
    prisma.task.findMany({
      where: { ...where, ...periodWhere },
      include: {
        client: { select: { name: true, hourlyRate: true } },
        project: { select: { name: true, hourlyRate: true } },
        taskType: { select: { name: true } },
        assignee: { select: { fullName: true } },
      },
      orderBy: [{ billingStatus: 'asc' }, { lastWorkedAt: 'desc' }, { createdAt: 'desc' }],
      take: query.take ?? 300,
      skip: query.skip ?? 0,
    }),
    prisma.task.count({ where: { ...where, ...periodWhere } }),
  ]);

  // Segundos del periodo por tiquete (una sola consulta para todos).
  const periodSeconds = new Map<string, { seconds: number; entries: number }>();
  if (period && rows.length) {
    const entries = await prisma.timeEntry.findMany({
      where: {
        taskId: { in: rows.map((r) => r.id) },
        startedAt: { gte: query.from, lt: query.to },
        status: { not: 'CANCELLED' },
      },
      select: { taskId: true, status: true, durationSec: true, startedAt: true },
    });
    for (const e of entries) {
      if (!e.taskId) continue;
      const acc = periodSeconds.get(e.taskId) ?? { seconds: 0, entries: 0 };
      acc.seconds += liveSeconds(e);
      acc.entries += 1;
      periodSeconds.set(e.taskId, acc);
    }
  }

  const tickets: BillingTicketRow[] = (rows as unknown as RawTask[]).map((t) => {
    const inPeriod = periodSeconds.get(t.id);
    const seconds = period ? (inPeriod?.seconds ?? 0) : t.totalSeconds;
    const { rate, source } = resolveRate({
      taskRate: t.hourlyRate,
      projectRate: t.project?.hourlyRate ?? null,
      clientRate: t.client?.hourlyRate ?? null,
    });
    const amount = amountFor(seconds, rate, currency);
    return {
      id: t.id,
      reference: t.reference,
      title: t.title,
      status: t.status,
      statusLabel: TASK_STATUS_LABEL[t.status] ?? t.status,
      clientId: t.clientId,
      clientName: t.client?.name ?? null,
      projectId: t.projectId,
      projectName: t.project?.name ?? null,
      taskTypeName: t.taskType?.name ?? null,
      assigneeName: t.assignee?.fullName ?? null,
      seconds,
      hours: hoursFromSeconds(seconds),
      entryCount: period ? (inPeriod?.entries ?? 0) : t.entryCount,
      rate,
      rateSource: source,
      amount,
      billingStatus: t.billingStatus,
      billedAt: t.billedAt?.toISOString() ?? null,
      paidAt: t.paidAt?.toISOString() ?? null,
      invoiceRef: t.invoiceRef,
      billedAmount: t.billedAmount,
      chargedAmount: t.billedAmount ?? amount,
      firstWorkedAt: t.firstWorkedAt?.toISOString() ?? null,
      lastWorkedAt: t.lastWorkedAt?.toISOString() ?? null,
    };
  });

  // --- Totales por estado ---
  const acc = {
    PENDING: { seconds: 0, amount: 0, tickets: 0 },
    BILLED: { seconds: 0, amount: 0, tickets: 0 },
    PAID: { seconds: 0, amount: 0, tickets: 0 },
  };
  let allSeconds = 0;
  let allAmount = 0;
  for (const t of tickets) {
    const bucket = acc[(t.billingStatus as BillingStatus) ?? 'PENDING'] ?? acc.PENDING;
    const value = t.chargedAmount ?? t.amount ?? 0;
    bucket.seconds += t.seconds;
    bucket.amount += value;
    bucket.tickets += 1;
    allSeconds += t.seconds;
    allAmount += value;
  }

  // --- Agrupación por cliente ---
  const byClientMap = new Map<string, BillingOverview['byClient'][number]>();
  for (const t of tickets) {
    const key = t.clientId ?? 'none';
    const group =
      byClientMap.get(key) ??
      {
        clientId: t.clientId,
        clientName: t.clientName ?? 'Sin cliente',
        tickets: 0,
        seconds: 0,
        hours: 0,
        amount: 0,
        pendingHours: 0,
        pendingAmount: 0,
        billedHours: 0,
        billedAmount: 0,
        paidHours: 0,
        paidAmount: 0,
      };
    const value = t.chargedAmount ?? t.amount ?? 0;
    group.tickets += 1;
    group.seconds += t.seconds;
    group.amount += value;
    if (t.billingStatus === 'PENDING') {
      group.pendingHours += t.hours;
      group.pendingAmount += value;
    } else if (t.billingStatus === 'BILLED') {
      group.billedHours += t.hours;
      group.billedAmount += value;
    } else if (t.billingStatus === 'PAID') {
      group.paidHours += t.hours;
      group.paidAmount += value;
    }
    group.hours = hoursFromSeconds(group.seconds);
    byClientMap.set(key, group);
  }
  const byClient = [...byClientMap.values()].map((g) => ({
    ...g,
    hours: hoursFromSeconds(g.seconds),
    pendingHours: Math.round(g.pendingHours * 100) / 100,
    billedHours: Math.round(g.billedHours * 100) / 100,
    paidHours: Math.round(g.paidHours * 100) / 100,
    amount: roundMoney(g.amount, currency),
    pendingAmount: roundMoney(g.pendingAmount, currency),
    billedAmount: roundMoney(g.billedAmount, currency),
    paidAmount: roundMoney(g.paidAmount, currency),
  }));

  // --- Facturas (conjuntos de tiquetes que comparten nº de factura) ---
  // Se consultan aparte para que el total de una factura no dependa de los
  // filtros de la pantalla: una factura es una factura, se mire como se mire.
  const invoiceTasks = await prisma.task.findMany({
    where: {
      invoiceRef: { not: null },
      ...(query.clientId ? { clientId: query.clientId } : {}),
      ...(query.userIds?.length ? { assigneeId: { in: query.userIds } } : {}),
    },
    include: {
      client: { select: { name: true, hourlyRate: true } },
      project: { select: { hourlyRate: true } },
    },
    orderBy: { billedAt: 'desc' },
  });

  const invoiceMap = new Map<string, InvoiceAcc>();
  for (const t of invoiceTasks) {
    const ref = t.invoiceRef!;
    const group =
      invoiceMap.get(ref) ??
      ({
        invoiceRef: ref,
        clientNames: [],
        tickets: 0,
        seconds: 0,
        hours: 0,
        amount: 0,
        billingStatus: 'PAID',
        billedAt: null,
        paidAt: null,
        taskIds: [],
      } satisfies InvoiceAcc);
    const { rate } = resolveRate({
      taskRate: t.hourlyRate,
      projectRate: t.project?.hourlyRate ?? null,
      clientRate: t.client?.hourlyRate ?? null,
    });
    const value = t.billedAmount ?? amountFor(t.totalSeconds, rate, currency) ?? 0;
    group.tickets += 1;
    group.seconds += t.totalSeconds;
    group.amount += value;
    group.taskIds.push(t.id);
    group.hours = hoursFromSeconds(group.seconds);
    if (t.client?.name && !group.clientNames.includes(t.client.name)) group.clientNames.push(t.client.name);
    // El estado de la factura es el "más atrasado" de sus tiquetes: si alguno
    // sigue pendiente, la factura no está cerrada.
    const rank: Record<string, number> = { PENDING: 0, BILLED: 1, PAID: 2 };
    if ((rank[t.billingStatus] ?? 0) < (rank[group.billingStatus] ?? 2)) group.billingStatus = t.billingStatus;
    if (t.billedAt && (!group.billedAt || t.billedAt > group.billedAt)) group.billedAt = t.billedAt;
    if (t.paidAt && (!group.paidAt || t.paidAt < group.paidAt)) group.paidAt = t.paidAt;
    invoiceMap.set(ref, group);
  }
  const invoices = [...invoiceMap.values()].map((g) => ({
    ...g,
    hours: hoursFromSeconds(g.seconds),
    amount: roundMoney(g.amount, currency),
    billedAt: g.billedAt?.toISOString() ?? null,
    paidAt: g.paidAt?.toISOString() ?? null,
  }));

  // --- Horas sin tiquete (no se pueden cobrar por tiquete; se informan) ---
  const unticketed = await unticketedHours({
    from: query.from,
    to: query.to,
    clientId: query.clientId,
    projectId: query.projectId,
    userIds: query.userIds,
  });

  // --- Pendiente histórico: red de seguridad para no perder trabajo sin cobrar ---
  const historicalPending = await prisma.task.findMany({
    where: {
      entryCount: { gt: 0 },
      billingStatus: 'PENDING',
      ...(query.clientId ? { clientId: query.clientId } : {}),
      ...(query.projectId ? { projectId: query.projectId } : {}),
      ...(query.userIds?.length ? { assigneeId: { in: query.userIds } } : {}),
    },
    include: { project: { select: { hourlyRate: true } }, client: { select: { hourlyRate: true } } },
  });
  let historicalSeconds = 0;
  let historicalAmount = 0;
  for (const t of historicalPending) {
    const { rate } = resolveRate({
      taskRate: t.hourlyRate,
      projectRate: t.project?.hourlyRate ?? null,
      clientRate: t.client?.hourlyRate ?? null,
    });
    historicalSeconds += t.totalSeconds;
    historicalAmount += amountFor(t.totalSeconds, rate, currency) ?? 0;
  }

  return {
    range: {
      from: query.from?.toISOString() ?? '',
      to: query.to?.toISOString() ?? '',
      label: period ? '' : 'Todo el historial',
    },
    currency,
    scope: query.scope ?? 'all',
    tickets,
    total,
    totals: {
      all: totalsOf(allSeconds, roundMoney(allAmount, currency)),
      pending: totalsOf(acc.PENDING.seconds, roundMoney(acc.PENDING.amount, currency)),
      billed: totalsOf(acc.BILLED.seconds, roundMoney(acc.BILLED.amount, currency)),
      paid: totalsOf(acc.PAID.seconds, roundMoney(acc.PAID.amount, currency)),
      receivable: roundMoney(acc.BILLED.amount, currency),
      tickets: total,
      pendingTickets: acc.PENDING.tickets,
      billedTickets: acc.BILLED.tickets,
      paidTickets: acc.PAID.tickets,
    },
    byClient: byClient.sort((a, b) => b.amount - a.amount || b.seconds - a.seconds),
    invoices: invoices.sort((a, b) => (b.billedAt ?? '').localeCompare(a.billedAt ?? '')),
    unticketed,
    historicalPending: {
      seconds: historicalSeconds,
      hours: hoursFromSeconds(historicalSeconds),
      amount: roundMoney(historicalAmount, currency),
      tickets: historicalPending.length,
    },
  };
}

/** Horas registradas sin tiquete: se informan aparte porque no son facturables por tiquete. */
async function unticketedHours(filter: {
  from?: Date;
  to?: Date;
  clientId?: string;
  projectId?: string;
  userIds?: string[];
}): Promise<{ seconds: number; hours: number; entries: number }> {
  const entries = await prisma.timeEntry.findMany({
    where: {
      taskId: null,
      status: { not: 'CANCELLED' },
      ...(filter.from && filter.to ? { startedAt: { gte: filter.from, lt: filter.to } } : {}),
      ...(filter.clientId ? { clientId: filter.clientId } : {}),
      ...(filter.projectId ? { projectId: filter.projectId } : {}),
      ...(filter.userIds?.length ? { userId: { in: filter.userIds } } : {}),
    },
    select: { status: true, durationSec: true, startedAt: true },
  });
  const seconds = entries.reduce((acc, e) => acc + liveSeconds(e), 0);
  return { seconds, hours: hoursFromSeconds(seconds), entries: entries.length };
}

// ---------------------------------------------------------------------------
// Reporte entregable al cliente
// ---------------------------------------------------------------------------

export interface StatementQuery {
  clientId: string;
  from: Date;
  to: Date;
  label: string;
  userIds?: string[];
  projectId?: string;
  /** 'ALL' = sin filtrar por estado de facturación. */
  billingStatus?: BillingStatus | 'ALL';
  /** Incluir las horas de tiquetes ya facturados o pagados. */
  includeBilled?: boolean;
  /** Añadir el detalle de cada tramo de tiempo dentro de cada tiquete. */
  withEntries?: boolean;
  scope: 'me' | 'team' | 'all';
}

interface RawStatementEntry {
  id: string;
  taskId: string | null;
  durationSec: number;
  status: string;
  startedAt: Date;
  endedAt: Date | null;
  title: string | null;
  description: string | null;
  billable: boolean;
  user: { fullName: string };
  task: {
    id: string;
    title: string;
    description: string | null;
    status: string;
    reference: string | null;
    hourlyRate: number | null;
    billingStatus: string;
    billedAt: Date | null;
    paidAt: Date | null;
    invoiceRef: string | null;
    billedAmount: number | null;
    projectId: string | null;
    project: { name: string; hourlyRate: number | null } | null;
    taskType: { name: string } | null;
    assignee: { fullName: string } | null;
  } | null;
}

/**
 * Estado de horas de un cliente en un periodo, listo para entregar.
 *
 * Las horas son las del PERIODO (no el acumulado del tiquete) para que el
 * reporte cuadre con el resto del panel: lo trabajado en ese rango de fechas.
 */
export async function buildClientStatement(query: StatementQuery): Promise<ClientStatement> {
  const currency = billingCurrency();

  const client = await prisma.client.findUnique({
    where: { id: query.clientId },
    // `locale` decide el idioma del documento que se le entrega a ESTE cliente.
    select: { id: true, name: true, code: true, hourlyRate: true, locale: true },
  });
  if (!client) throw Object.assign(new Error('Cliente no encontrado'), { statusCode: 404 });

  const entries = (await prisma.timeEntry.findMany({
    where: {
      startedAt: { gte: query.from, lt: query.to },
      status: { not: 'CANCELLED' },
      // El cliente puede venir en el registro, en su proyecto o en su TAREA: los
      // tramos antiguos (o los creados indicando solo el tiquete) no siempre
      // llevan el cliente copiado, y un reporte al que le falten horas de un
      // tiquete de este cliente estaría mal sin que se note.
      AND: [
        {
          OR: [
            { clientId: query.clientId },
            { project: { clientId: query.clientId } },
            { task: { clientId: query.clientId } },
            { task: { project: { clientId: query.clientId } } },
          ],
        },
        ...(query.projectId
          ? [{ OR: [{ projectId: query.projectId }, { task: { projectId: query.projectId } }] }]
          : []),
      ],
      ...(query.userIds?.length ? { userId: { in: query.userIds } } : {}),
      ...(query.billingStatus && query.billingStatus !== 'ALL' ? { task: { billingStatus: query.billingStatus } } : {}),
      ...(query.includeBilled === false
        ? { NOT: { task: { billingStatus: { in: ['BILLED', 'PAID'] } } } }
        : {}),
    },
    include: {
      user: { select: { fullName: true } },
      task: {
        include: {
          project: { select: { name: true, hourlyRate: true } },
          taskType: { select: { name: true } },
          assignee: { select: { fullName: true } },
        },
      },
    },
    orderBy: { startedAt: 'asc' },
  })) as unknown as RawStatementEntry[];

  const ticketMap = new Map<string, StatementTicket>();
  let unticketedSeconds = 0;
  let unticketedEntries = 0;
  const users = new Set<string>();

  for (const entry of entries) {
    const seconds = liveSeconds(entry);
    users.add(entry.user.fullName);

    if (!entry.task) {
      unticketedSeconds += seconds;
      unticketedEntries += 1;
      continue;
    }

    const task = entry.task;
    let ticket = ticketMap.get(task.id);
    if (!ticket) {
      const { rate, source } = resolveRate({
        taskRate: task.hourlyRate,
        projectRate: task.project?.hourlyRate ?? null,
        clientRate: client.hourlyRate ?? null,
      });
      ticket = {
        id: task.id,
        reference: task.reference,
        title: task.title,
        description: task.description,
        status: task.status,
        statusLabel: TASK_STATUS_LABEL[task.status] ?? task.status,
        projectId: task.projectId,
        projectName: task.project?.name ?? null,
        taskTypeName: task.taskType?.name ?? null,
        assignees: [],
        seconds: 0,
        hours: 0,
        billableSeconds: 0,
        entryCount: 0,
        firstWorkedAt: null,
        lastWorkedAt: null,
        rate,
        rateSource: source,
        amount: null,
        billingStatus: task.billingStatus,
        billedAt: task.billedAt?.toISOString() ?? null,
        paidAt: task.paidAt?.toISOString() ?? null,
        invoiceRef: task.invoiceRef,
        billedAmount: task.billedAmount,
        chargedAmount: null,
        ...(query.withEntries ? { entries: [] } : {}),
      };
      ticketMap.set(task.id, ticket);
    }

    ticket.seconds += seconds;
    if (entry.billable) ticket.billableSeconds += seconds;
    ticket.entryCount += 1;
    const started = entry.startedAt.toISOString();
    if (!ticket.firstWorkedAt || started < ticket.firstWorkedAt) ticket.firstWorkedAt = started;
    const ended = (entry.endedAt ?? entry.startedAt).toISOString();
    if (!ticket.lastWorkedAt || ended > ticket.lastWorkedAt) ticket.lastWorkedAt = ended;
    if (!ticket.assignees.includes(entry.user.fullName)) ticket.assignees.push(entry.user.fullName);

    if (ticket.entries) {
      ticket.entries.push({
        id: entry.id,
        startedAt: started,
        endedAt: entry.endedAt?.toISOString() ?? null,
        userName: entry.user.fullName,
        title: entry.title,
        description: entry.description,
        seconds,
        hours: hoursFromSeconds(seconds),
        billable: entry.billable,
      });
    }
  }

  // Importes y redondeos finales.
  for (const ticket of ticketMap.values()) {
    ticket.hours = hoursFromSeconds(ticket.seconds);
    ticket.amount = amountFor(ticket.seconds, ticket.rate, currency);
    ticket.chargedAmount = ticket.billedAmount ?? ticket.amount;
    // Si la tarea no tiene responsable asignado, los nombres salen de los tramos.
    void ticket.assignees;
  }

  // Orden de lectura del reporte: por proyecto y luego cronológico.
  const tickets = [...ticketMap.values()].sort((a, b) => {
    const pa = a.projectName ?? 'zzz';
    const pb = b.projectName ?? 'zzz';
    if (pa !== pb) return pa.localeCompare(pb);
    return (a.firstWorkedAt ?? '').localeCompare(b.firstWorkedAt ?? '');
  });

  // --- Totales ---
  const sum = (list: StatementTicket[]): { seconds: number; amount: number } =>
    list.reduce(
      (acc, t) => {
        acc.seconds += t.seconds;
        acc.amount += t.chargedAmount ?? t.amount ?? 0;
        return acc;
      },
      { seconds: 0, amount: 0 },
    );

  const all = sum(tickets);
  const pending = sum(tickets.filter((t) => t.billingStatus === 'PENDING'));
  const billed = sum(tickets.filter((t) => t.billingStatus === 'BILLED'));
  const paid = sum(tickets.filter((t) => t.billingStatus === 'PAID'));

  // --- Agrupación por proyecto ---
  const projectMap = new Map<string, ClientStatement['byProject'][number]>();
  for (const t of tickets) {
    const key = t.projectId ?? 'none';
    const group =
      projectMap.get(key) ??
      { projectId: t.projectId, projectName: t.projectName ?? 'Sin proyecto', tickets: 0, seconds: 0, hours: 0, amount: 0 };
    group.tickets += 1;
    group.seconds += t.seconds;
    group.amount += t.chargedAmount ?? t.amount ?? 0;
    projectMap.set(key, group);
  }
  const byProject = [...projectMap.values()]
    .map((g) => ({
      ...g,
      hours: hoursFromSeconds(g.seconds),
      amount: roundMoney(g.amount, currency),
    }))
    .sort((a, b) => b.seconds - a.seconds);

  return {
    client: { id: client.id, name: client.name, code: client.code },
    company: {
      name: getSetting(SETTING_KEYS.COMPANY_NAME, 'TeleTimeTracker'),
      taxId: getSetting(SETTING_KEYS.COMPANY_TAX_ID, '') || null,
    },
    currency,
    // Idioma del documento, ya resuelto: el panel y el CSV lo usan tal cual.
    locale: normalizeLocale(client.locale),
    range: { from: query.from.toISOString(), to: query.to.toISOString(), label: query.label },
    generatedAt: new Date().toISOString(),
    includeBilled: query.includeBilled !== false,
    scope: query.scope,
    totals: {
      all: totalsOf(all.seconds, roundMoney(all.amount, currency)),
      pending: totalsOf(pending.seconds, roundMoney(pending.amount, currency)),
      billed: totalsOf(billed.seconds, roundMoney(billed.amount, currency)),
      paid: totalsOf(paid.seconds, roundMoney(paid.amount, currency)),
      receivable: roundMoney(billed.amount, currency),
      tickets: tickets.length,
      entries: entries.length,
      users: users.size,
    },
    byProject,
    tickets,
    unticketed: {
      seconds: unticketedSeconds,
      hours: hoursFromSeconds(unticketedSeconds),
      entries: unticketedEntries,
    },
  };
}

// ---------------------------------------------------------------------------
// Export CSV del estado de horas por tiquete
// ---------------------------------------------------------------------------

export function statementToCsv(statement: ClientStatement, timezone: string): string {
  // El CSV es la misma entrega que el papel, así que va en el idioma del cliente.
  const locale: ReportLocale = normalizeLocale(statement.locale);
  const t = (key: Parameters<typeof tr>[1]): string => tr(locale, key);

  const header = [
    t('csv.reference'), t('csv.ticket'), t('csv.description'), t('csv.project'), t('csv.type'), t('csv.assignees'),
    t('csv.first'), t('csv.last'), t('csv.segments'), t('csv.hours'), t('csv.hours_decimal'),
    t('csv.rate'), t('csv.amount'), t('csv.billing_status'), t('csv.invoice'), t('csv.billed_at'), t('csv.paid_at'),
  ];

  // Las fechas se expresan en la zona del usuario que genera el reporte: en UTC
  // un tramo de las 20:00 en Bogotá aparecería con la fecha del día siguiente.
  const day = (value: string | null): string => (value ? zonedDateString(new Date(value), timezone) : '');

  const rows = statement.tickets.map((t) => [
    t.reference ?? '',
    t.title,
    (t.description ?? '').replace(/\s+/g, ' '),
    t.projectName ?? '',
    t.taskTypeName ?? '',
    t.assignees.join('|'),
    day(t.firstWorkedAt),
    day(t.lastWorkedAt),
    t.entryCount,
    formatHhMm(t.seconds),
    (t.seconds / 3600).toFixed(2),
    t.rate ?? '',
    t.chargedAmount ?? '',
    // El estado se escribe legible ("Pagado" / "Paid"): el CSV lo abre una persona.
    billingStatusText(locale, t.billingStatus),
    t.invoiceRef ?? '',
    day(t.billedAt),
    day(t.paidAt),
  ]);

  // Fila de totales: el cliente ve el cierre del periodo sin sumar a mano.
  rows.push([
    '', t('doc.total'), '', '', '', '', '', '', statement.totals.entries,
    formatHhMm(statement.totals.all.seconds),
    (statement.totals.all.seconds / 3600).toFixed(2),
    '', statement.totals.all.amount, '', '', '', '',
  ]);

  return [header, ...rows]
    .map((cols) => cols.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(','))
    .join('\n');
}

/** "7h 30m" para exportaciones legibles. */
function formatHhMm(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${h}h ${String(m).padStart(2, '0')}m`;
}
