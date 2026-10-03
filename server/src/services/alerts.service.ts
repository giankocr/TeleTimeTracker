import cron, { type ScheduledTask } from 'node-cron';
import { prisma } from '../db/prisma';
import { sendMessage } from '../bot/telegram.api';
import { MAIN_KEYBOARD } from '../bot/messages';
import { autoCloseStaleEntries, liveSeconds } from './timer.service';
import { getSetting, getSettingBool, getSettingInt, SETTING_KEYS } from './settings.service';
import { humanDuration, escapeHtml } from '../utils/format';
import { isWithinWorkHours } from '../utils/time';

/**
 * Alertas proactivas del bot:
 *  1. Inactividad: si el usuario esta en jornada y no tiene tarea corriendo,
 *     se le recuerda (con anti-spam de 1 alerta por ventana).
 *  2. Digest diario: resumen de horas del dia anterior + pendientes.
 */

const jobs: ScheduledTask[] = [];

function workDaysOf(raw: string): number[] {
  return raw
    .split(',')
    .map((d) => Number.parseInt(d.trim(), 10))
    .filter((n) => Number.isFinite(n));
}

function minutesSince(date: Date): number {
  return Math.floor((Date.now() - date.getTime()) / 60000);
}

/** Revisa inactividad de todos los usuarios vinculados a Telegram. */
export async function runIdleCheck(): Promise<number> {
  if (!getSettingBool(SETTING_KEYS.ALERTS_ENABLED, true)) return 0;

  const users = await prisma.user.findMany({
    where: { isActive: true, telegramId: { not: null } },
    select: {
      id: true,
      fullName: true,
      telegramId: true,
      timezone: true,
      workDays: true,
      workStart: true,
      workEnd: true,
      idleAlertMin: true,
    },
  });

  let sent = 0;
  for (const user of users) {
    const inShift = isWithinWorkHours(new Date(), {
      timezone: user.timezone,
      workDays: workDaysOf(user.workDays),
      workStart: user.workStart,
      workEnd: user.workEnd,
    });
    if (!inShift) continue;

    const active = await prisma.timeEntry.findFirst({
      where: { userId: user.id, status: { in: ['RUNNING', 'PAUSED'] } },
      orderBy: { startedAt: 'desc' },
    });
    // Pausado tambien cuenta como inactivo si la pausa es larga.
    if (active && active.status === 'RUNNING') continue;

    const idleMinutes = active
      ? minutesSince(active.updatedAt)
      : await lastActivityMinutes(user.id);

    if (idleMinutes < user.idleAlertMin) continue;

    // Anti-spam: maximo 1 alerta de inactividad cada 60 minutos por usuario.
    const recent = await prisma.alertLog.findFirst({
      where: { userId: user.id, type: 'IDLE', sentAt: { gte: new Date(Date.now() - 60 * 60000) } },
    });
    if (recent) continue;

    try {
      const text = active
        ? [
            `⏸ <b>Llevas ${humanDuration(idleMinutes * 60)} en pausa.</b>`,
            `Tarea: <i>${escapeHtml(active.title ?? 'Sin titulo')}</i>`,
            '',
            'Escribe <i>"retomo"</i> o envia una nota de voz para continuar.',
          ].join('\n')
        : [
            `⏰ <b>No tienes ninguna tarea corriendo.</b>`,
            `Son las ${new Date().toLocaleTimeString('es-CO', { timeZone: user.timezone, hour: '2-digit', minute: '2-digit' })} y llevas ${humanDuration(idleMinutes * 60)} sin registrar tiempo.`,
            '',
            'Envia una nota de voz: <i>"Iniciando tarea de X en el proyecto Y del cliente Z"</i>',
          ].join('\n');

      await sendMessage(user.telegramId!, text, { reply_markup: MAIN_KEYBOARD });
      await prisma.alertLog.create({ data: { userId: user.id, type: 'IDLE', payload: JSON.stringify({ idleMinutes }) } });
      sent++;
    } catch (err) {
      console.warn(`[alerts] no se pudo alertar a ${user.fullName}:`, (err as Error).message);
    }
  }
  return sent;
}

async function lastActivityMinutes(userId: string): Promise<number> {
  const last = await prisma.timeEntry.findFirst({
    where: { userId },
    orderBy: { endedAt: 'desc' },
    select: { endedAt: true, updatedAt: true },
  });
  const reference = last?.endedAt ?? last?.updatedAt;
  if (!reference) return 24 * 60; // nunca ha registrado nada
  return minutesSince(reference);
}

/** Digest diario: horas de ayer + pendientes activos. */
export async function runDailyDigest(): Promise<number> {
  if (!getSettingBool(SETTING_KEYS.ALERTS_ENABLED, true)) return 0;
  const users = await prisma.user.findMany({
    where: { isActive: true, telegramId: { not: null }, dailyDigest: true },
    select: { id: true, fullName: true, telegramId: true, timezone: true },
  });

  let sent = 0;
  for (const user of users) {
    const since = new Date(Date.now() - 24 * 3600 * 1000);
    const entries = await prisma.timeEntry.findMany({
      where: { userId: user.id, startedAt: { gte: since }, status: { not: 'CANCELLED' } },
      include: { project: true, client: true },
    });
    const total = entries.reduce((acc, e) => acc + liveSeconds(e), 0);

    const pending = await prisma.pendingTask.findMany({
      where: { userId: user.id, isDone: false },
      orderBy: [{ priority: 'desc' }, { dueDate: 'asc' }],
      take: 8,
    });

    const byProject = new Map<string, number>();
    for (const e of entries) {
      const key = e.project?.name ?? e.client?.name ?? 'Sin proyecto';
      byProject.set(key, (byProject.get(key) ?? 0) + liveSeconds(e));
    }

    const lines = [`☀️ <b>Buenos dias, ${escapeHtml(user.fullName.split(' ')[0]!)}</b>`, ''];
    lines.push(`Ayer/dia anterior: <b>${humanDuration(total)}</b> en ${entries.length} registro(s).`);
    if (byProject.size) {
      [...byProject.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .forEach(([name, secs]) => lines.push(`   • ${escapeHtml(name)}: ${humanDuration(secs)}`));
    }
    if (pending.length) {
      lines.push('', '<b>Pendientes:</b>');
      pending.forEach((t) => lines.push(`   ${t.priority === 'HIGH' ? '🔴' : t.priority === 'LOW' ? '🟢' : '🟡'} ${escapeHtml(t.title)}`));
    }
    lines.push('', 'Que vas a hacer hoy? Envia una nota de voz para empezar.');

    try {
      await sendMessage(user.telegramId!, lines.join('\n'), { reply_markup: MAIN_KEYBOARD });
      await prisma.alertLog.create({ data: { userId: user.id, type: 'DAILY_DIGEST' } });
      sent++;
    } catch (err) {
      console.warn(`[alerts] digest fallido para ${user.fullName}:`, (err as Error).message);
    }
  }
  return sent;
}

/** Arranca los cron jobs (idempotente). */
export function startScheduler(): void {
  const idleCron = process.env.ALERT_CRON ?? '* * * * *';
  const digestCron = getSetting(SETTING_KEYS.DIGEST_CRON, '0 8 * * 1-5');

  const idleJob = cron.schedule(idleCron, () => {
    void runIdleCheck().catch((err) => console.warn('[alerts] idle check fallo:', err.message));
  });
  const digestJob = cron.schedule(digestCron, () => {
    void runDailyDigest().catch((err) => console.warn('[alerts] digest fallo:', err.message));
  });
  // Limpieza nocturna: cierra segmentos olvidados de mas de 16h.
  const cleanupJob = cron.schedule('15 3 * * *', () => {
    void autoCloseStaleEntries()
      .then((n) => n && console.log(`[cleanup] ${n} registro(s) cerrados automaticamente`))
      .catch(() => undefined);
  });

  jobs.push(idleJob, digestJob, cleanupJob);
  console.log(`[alerts] scheduler activo (idle="${idleCron}", digest="${digestCron}")`);
}

export function stopScheduler(): void {
  jobs.forEach((j) => j.stop());
  jobs.length = 0;
}

export const alertsInternals = { runIdleCheck, runDailyDigest, getSettingInt };
