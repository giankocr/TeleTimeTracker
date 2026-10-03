import { prisma } from '../db/prisma';
import { getSettingBool, getSettingInt, SETTING_KEYS } from './settings.service';
import { buildReport, type ReportFilters } from './report.service';
import { humanDuration, hoursFromSeconds, escapeHtml, truncate } from '../utils/format';
import { dayBounds, formatLocal, resolveRange, zonedParts } from '../utils/time';
import { parseCommand } from './nlu.service';
import { liveSeconds } from './timer.service';
import type { ParsedEntities } from '../../../shared/types';

/**
 * Asistente conversacional: mantiene el estado del usuario (tarea activa,
 * proyecto pendiente por confirmar) y responde a cada intent del NLU.
 */

export interface HandlerUser {
  id: string;
  fullName: string;
  roleKey: string;
  timezone: string;
  telegramId: string | null;
}

export interface ReplyKeyboardHint {
  pendingProjectId?: string | null;
  pendingText?: string | null;
}

/** Segundos registrados hoy por el usuario (todos los estados menos cancelados). */
export async function todaySeconds(userId: string, timezone: string): Promise<number> {
  const { from, to } = dayBounds(new Date(), timezone);
  const entries = await prisma.timeEntry.findMany({
    where: { userId, status: { not: 'CANCELLED' }, startedAt: { gte: from, lt: to } },
    select: { durationSec: true, status: true, startedAt: true },
  });
  return entries.reduce((acc, e) => {
    if (e.status === 'RUNNING') {
      return acc + e.durationSec + Math.max(0, Math.floor((Date.now() - e.startedAt.getTime()) / 1000));
    }
    return acc + e.durationSec;
  }, 0);
}

export async function pendingTasksFor(userId: string) {
  const tasks = await prisma.pendingTask.findMany({
    where: { userId, isDone: false },
    orderBy: [{ priority: 'desc' }, { dueDate: 'asc' }],
    take: 25,
  });
  const projectIds = [...new Set(tasks.map((t) => t.projectId).filter(Boolean))] as string[];
  const projects = projectIds.length
    ? await prisma.clientProject.findMany({ where: { id: { in: projectIds } }, select: { id: true, name: true } })
    : [];
  return tasks.map((t) => ({
    id: t.id,
    title: t.title,
    priority: t.priority,
    dueDate: t.dueDate,
    projectName: projects.find((p) => p.id === t.projectId)?.name ?? null,
  }));
}

/** Contexto que se le pasa al NLU (nombres reales para que los use textualmente). */
export async function nluContext(userId: string, roleKey: string) {
  const [projects, clients, active] = await Promise.all([
    prisma.clientProject.findMany({ where: { isActive: true }, include: { client: true }, take: 60 }),
    prisma.client.findMany({ where: { isActive: true }, take: 60 }),
    prisma.timeEntry.findFirst({ where: { userId, status: { in: ['RUNNING', 'PAUSED'] } }, orderBy: { startedAt: 'desc' } }),
  ]);
  void roleKey;
  return {
    activeTask: active ? `${active.title ?? 'Tarea'} (${active.status})` : null,
    projects: projects.map((p) => `${p.name} [cliente: ${p.client.name}]`),
    clients: clients.map((c) => c.name),
  };
}

export interface ReportOptions {
  /** today | yesterday | last7 | thisMonth | lastMonth */
  preset: string;
  entities: ParsedEntities;
}

/** Reporte de horas listo para enviar por Telegram. */
export async function buildTelegramReport(
  user: HandlerUser,
  options: ReportOptions,
): Promise<string> {
  const preset = options.preset || 'today';
  const range = resolveRange(preset, user.timezone);

  const filters: ReportFilters = {
    from: range.from,
    to: range.to,
    userIds: [user.id],
  };
  const report = await buildReport(filters, user.timezone);

  const lines: string[] = [`📈 <b>Reporte — ${range.label}</b>`, ''];
  lines.push(`⏱ Total: <b>${humanDuration(report.totals.totalSeconds)}</b>${report.totals.totalSeconds >= 3600 ? ` (${report.totals.totalHours} h)` : ''}`);
  if (report.totals.billableHours !== report.totals.totalHours) {
    lines.push(`💵 Facturable: ${report.totals.billableHours} h`);
  }
  lines.push(`📌 Registros: ${report.totals.entries}`);

  if (report.byProject.length) {
    lines.push('', '<b>Por proyecto</b>');
    report.byProject.slice(0, 10).forEach((b) => lines.push(`• ${escapeHtml(b.label)}: <b>${humanDuration(b.seconds)}</b>`));
  }
  if (report.byClient.length > 1) {
    lines.push('', '<b>Por cliente</b>');
    report.byClient.slice(0, 10).forEach((b) => lines.push(`• ${escapeHtml(b.label)}: <b>${humanDuration(b.seconds)}</b>`));
  }
  if (!report.byProject.length) lines.push('', '<i>Sin registros en el periodo.</i>');
  return lines.join('\n');
}

/**
 * Tiempo consumido en una tarea o proyecto concreto.
 * Busca por texto libre (titulo o descripcion) y por nombre de proyecto, para
 * responder a "cuanto llevo en la tarea del login" o "cuanto llevo en Portal Web".
 */
export async function taskTimeReport(
  user: HandlerUser,
  query: string,
  timezone: string,
): Promise<{ found: boolean; text: string }> {
  const term = query.trim();
  if (term.length < 3) {
    return { found: false, text: 'Dime al menos 3 letras de la tarea o del proyecto.' };
  }

  const entries = await prisma.timeEntry.findMany({
    where: {
      userId: user.id,
      status: { not: 'CANCELLED' },
      OR: [
        { task: { title: { contains: term } } },
        { title: { contains: term } },
        { description: { contains: term } },
        { project: { name: { contains: term } } },
        { client: { name: { contains: term } } },
      ],
    },
    include: { task: { select: { id: true, title: true, status: true } }, project: true, client: true, taskType: true },
    orderBy: { startedAt: 'desc' },
    take: 100,
  });

  if (!entries.length) {
    return {
      found: false,
      text: `🔍 No encontré registros que coincidan con <b>${escapeHtml(term)}</b>.`,
    };
  }

  const totalSeconds = entries.reduce((acc, e) => acc + liveSeconds(e), 0);

  // Se agrupa por TAREA cuando el registro la tiene: es la unidad de trabajo y
  // puede acumular varios tramos. Si no, se cae al proyecto.
  const byTask = new Map<string, { seconds: number; tramos: number }>();
  const byProject = new Map<string, number>();
  for (const entry of entries) {
    const segundos = liveSeconds(entry);
    const claveTarea = entry.task?.title;
    if (claveTarea) {
      const actual = byTask.get(claveTarea) ?? { seconds: 0, tramos: 0 };
      byTask.set(claveTarea, { seconds: actual.seconds + segundos, tramos: actual.tramos + 1 });
    }
    const key = entry.project?.name ?? entry.client?.name ?? 'Sin proyecto';
    byProject.set(key, (byProject.get(key) ?? 0) + segundos);
  }

  const lineas = [
    `⏱ <b>Tiempo en «${escapeHtml(term)}»</b>`,
    '',
    `Total: <b>${humanDuration(totalSeconds)}</b> en ${entries.length} registro(s)`,
  ];

  if (byTask.size) {
    lineas.push('', '<b>Por tarea</b>');
    for (const [titulo, datos] of [...byTask.entries()].sort((a, b) => b[1].seconds - a[1].seconds).slice(0, 6)) {
      const tramos = datos.tramos === 1 ? '1 tramo' : `${datos.tramos} tramos`;
      lineas.push(`• ${escapeHtml(titulo)}: ${humanDuration(datos.seconds)} (${tramos})`);
    }
  }

  if (byProject.size > 1) {
    lineas.push('', '<b>Por proyecto</b>');
    for (const [nombre, segundos] of [...byProject.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6)) {
      lineas.push(`• ${escapeHtml(nombre)}: ${humanDuration(segundos)}`);
    }
  }

  const ultimos = entries.slice(0, 5);
  lineas.push('', '<b>Últimos registros</b>');
  for (const entry of ultimos) {
    const cuando = formatLocal(entry.startedAt, timezone, false);
    const estado = entry.status === 'RUNNING' ? ' (en curso)' : '';
    lineas.push(`• ${cuando} · ${humanDuration(liveSeconds(entry))} — ${escapeHtml(entry.title ?? 'Sin título')}${estado}`);
  }

  return { found: true, text: lineas.join('\n') };
}

/** Convierte "hoy/ayer/semana/mes" o una fecha en un preset del reporte. */
export function presetFromEntities(text: string, entities: ParsedEntities): string {
  const t = (text || '').toLowerCase();
  if (t.includes('ayer')) return 'yesterday';
  if (t.includes('semana') || t.includes('7 dias')) return 'last7';
  if (t.includes('mes pasado') || t.includes('mes anterior')) return 'lastMonth';
  if (t.includes('mes')) return 'thisMonth';
  if (t.includes('hoy')) return 'today';
  if (entities.date) {
    const target = new Date(`${entities.date}T12:00:00Z`);
    const today = new Date();
    const sameDay = target.toISOString().slice(0, 10) === today.toISOString().slice(0, 10);
    if (sameDay) return 'today';
    return 'yesterday';
  }
  return 'today';
}

/** Resumen del dia en una linea (para el digest automatico). */
export function daySummaryLine(name: string, seconds: number, entries: number): string {
  return `• ${escapeHtml(name)}: <b>${hoursFromSeconds(seconds)} h</b> en ${entries} registro(s)`;
}

export function timezoneOf(user: { timezone: string | null }): string {
  return user.timezone || 'UTC';
}

export function zonedNow(timezone: string) {
  return zonedParts(new Date(), timezone);
}

export const botSettings = () => ({
  alertsEnabled: getSettingBool(SETTING_KEYS.ALERTS_ENABLED, true),
  idleMinutes: getSettingInt(SETTING_KEYS.IDLE_ALERT_MIN, 45),
});

export const shortText = (value: string | null | undefined): string => truncate(value, 100);

export { parseCommand };
