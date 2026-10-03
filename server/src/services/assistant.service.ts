import { prisma } from '../db/prisma';
import { getSettingBool, getSettingInt, SETTING_KEYS } from './settings.service';
import { buildReport, type ReportFilters } from './report.service';
import { humanDuration, hoursFromSeconds, escapeHtml, truncate } from '../utils/format';
import { dayBounds, resolveRange, zonedParts } from '../utils/time';
import { parseCommand } from './nlu.service';
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

/**
 * Memoria efimera: si el bot no identifica el proyecto, se guarda el texto
 * original para reutilizarlo cuando el usuario elija uno de los botones.
 */
const pendingSelections = new Map<string, { text: string; at: number }>();

export function rememberPendingProject(userId: string, text: string): void {
  pendingSelections.set(userId, { text, at: Date.now() });
}

export function takePendingProject(userId: string): { text: string } | null {
  const value = pendingSelections.get(userId);
  if (!value) return null;
  pendingSelections.delete(userId);
  if (Date.now() - value.at > 10 * 60 * 1000) return null;
  return { text: value.text };
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
