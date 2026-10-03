import type { EntryWithRelations } from '../services/timer.service';
import { liveSeconds, pauseSeconds } from '../services/timer.service';
import { humanDuration, escapeHtml, truncate } from '../utils/format';
import { formatLocal } from '../utils/time';
import { formatGithubSummary, parseGithubData } from '../services/github.service';
import type { InlineKeyboardButton, ReplyMarkup } from './telegram.api';

/** Teclado rapido persistente (atajos del dia a dia). */
export const MAIN_KEYBOARD: ReplyMarkup = {
  keyboard: [
    [{ text: '📊 Estado' }, { text: '📝 Pendientes' }],
    [{ text: '⏸ Pausar' }, { text: '▶️ Retomar' }, { text: '⏹ Terminar' }],
  ],
  resize_keyboard: true,
  is_persistent: true,
};

export const entryButtons = (entryId: string): ReplyMarkup => ({
  inline_keyboard: [
    [
      { text: '⏸ Pausar', callback_data: `pause:${entryId}` },
      { text: '⏹ Terminar', callback_data: `stop:${entryId}` },
    ],
    [{ text: '🔄 Refrescar', callback_data: `status:${entryId}` }],
  ],
});

export const projectPicker = (items: Array<{ id: string; label: string }>): ReplyMarkup => ({
  inline_keyboard: chunkPairs(
    items.slice(0, 12).map((i) => ({ text: i.label, callback_data: `pick:${i.id}` })),
  ),
});

function chunkPairs(buttons: InlineKeyboardButton[]): InlineKeyboardButton[][] {
  const rows: InlineKeyboardButton[][] = [];
  for (let i = 0; i < buttons.length; i += 2) rows.push(buttons.slice(i, i + 2));
  return rows;
}

const statusEmoji: Record<string, string> = {
  RUNNING: '🟢',
  PAUSED: '🟡',
  FINISHED: '✅',
  CANCELLED: '🚫',
};

export const entryLine = (entry: EntryWithRelations, timezone: string): string => {
  const project = entry.project ? `${entry.project.name}` : 'sin proyecto';
  const client = entry.project?.client?.name ?? entry.client?.name ?? 'sin cliente';
  const live = liveSeconds(entry);
  return (
    `${statusEmoji[entry.status] ?? '•'} <b>${escapeHtml(entry.title ?? 'Tarea')}</b>\n` +
    `   ${escapeHtml(project)} · <i>${escapeHtml(client)}</i>${entry.taskType ? ` · ${escapeHtml(entry.taskType.name)}` : ''}\n` +
    `   ⏱ ${humanDuration(live)} (inicio ${formatLocal(entry.startedAt, timezone)})`
  );
};

/** Confirmacion al iniciar/cambiar de tarea. */
export function startConfirmation(entry: EntryWithRelations, previous: EntryWithRelations | null, timezone: string): string {
  const lines: string[] = [];
  if (previous) {
    lines.push(`🔄 <b>Cambio de tarea</b>`);
    lines.push(`Anterior: ${escapeHtml(previous.title ?? 'Tarea')} — ${humanDuration(liveSeconds(previous))}`);
    lines.push('');
  }
  lines.push(`▶️ <b>Tarea iniciada</b>`);
  lines.push(entryLine(entry, timezone));
  lines.push('');
  lines.push('<i>Usa los botones o envia una nota de voz para pausar, cambiar o terminar.</i>');
  return lines.join('\n');
}

export function pauseConfirmation(entry: EntryWithRelations, timezone: string): string {
  const paused = pauseSeconds(entry.pauses);
  return [
    '⏸ <b>Tarea en pausa</b>',
    entryLine(entry, timezone),
    paused ? `\nPausa acumulada: <b>${humanDuration(paused)}</b>` : '',
    '\nCuando vuelvas, escribe <i>"retomo"</i> o envia otra nota de voz.',
  ]
    .filter(Boolean)
    .join('\n');
}

export function resumeConfirmation(entry: EntryWithRelations, timezone: string): string {
  return ['▶️ <b>Tarea retomada</b>', entryLine(entry, timezone)].join('\n');
}

export function stopConfirmation(entry: EntryWithRelations, timezone: string, githubEnabled: boolean): string {
  const github = parseGithubData(entry.githubData);
  const lines = [
    '⏹ <b>Tarea finalizada</b>',
    entryLine(entry, timezone),
    '',
    `⏱ <b>Tiempo total: ${humanDuration(entry.durationSec)}</b>`,
  ];
  const pauses = pauseSeconds(entry.pauses);
  if (pauses) lines.push(`(pausas: ${humanDuration(pauses)})`);
  if (entry.description) lines.push(`\n📝 ${escapeHtml(truncate(entry.description, 600))}`);
  if (entry.tags.length) lines.push(`🏷 ${entry.tags.map((t) => escapeHtml(t.tag)).join(', ')}`);
  if (githubEnabled && github) {
    const summary = formatGithubSummary(github);
    if (summary) lines.push('', summary);
    else lines.push('', '<i>Sin commits/PRs en el rango de la tarea.</i>');
  }
  return lines.join('\n');
}

export function statusMessage(entry: EntryWithRelations | null, timezone: string, todaySeconds: number): string {
  if (!entry) {
    return [
      '💤 <b>No tienes ninguna tarea en curso.</b>',
      `Hoy llevas <b>${humanDuration(todaySeconds)}</b> registrados.`,
      '',
      'Envia una nota de voz o escribe algo como:',
      '<i>"Iniciando tarea de maquetacion en el proyecto X del cliente Y"</i>',
    ].join('\n');
  }
  const lines = ['📊 <b>Estado actual</b>', entryLine(entry, timezone)];
  const pauses = pauseSeconds(entry.pauses);
  if (entry.status === 'PAUSED') lines.push(`⏸ En pausa desde hace ${humanDuration(pauses)}`);
  lines.push('', `Total de hoy: <b>${humanDuration(todaySeconds + liveSeconds(entry))}</b>`);
  return lines.join('\n');
}

export function helpMessage(companyName: string, linked: boolean): string {
  return [
    `🤖 <b>${escapeHtml(companyName)} · Control de tiempo</b>`,
    '',
    linked
      ? 'Estás vinculado ✅ — puedes usar el bot con voz o texto.'
      : '⚠️ Tu cuenta de Telegram no está vinculada.\nToca <b>📱 Compartir mi número</b> (aquí abajo) o envía el código que te dio tu administrador: <code>/vincular ABCD-1234</code>.',
    '',
    '<b>Ejemplos por voz o texto:</b>',
    '• "Iniciando tarea de maquetacion en el proyecto Tienda del cliente Acme"',
    '• "Pausa para reunion de equipo"',
    '• "Cambia a la tarea de soporte del cliente Globex"',
    '• "Termine la tarea, ajuste el login y subi el fix"',
    '• "Reporte de hoy" · "Cuantas horas hice ayer"',
    '',
    '<b>Comandos:</b>',
    '/estado — que estas haciendo ahora',
    '/reporte [hoy|ayer|semana|mes] — resumen de horas',
    '/pendientes — lista de tareas pendientes',
    '/telefono — vincular compartiendo tu número',
    '/vincular CODIGO — vincula tu cuenta con el código del panel',
    '/cancelar — descarta la tarea en curso',
    '/ayuda — este mensaje',
  ].join('\n');
}

export function agendaMessage(
  tasks: Array<{ id: string; title: string; priority: string; dueDate: Date | null; projectName?: string | null }>,
  runningTitle: string | null,
  timezone: string,
): string {
  const lines: string[] = [];
  lines.push('📝 <b>Pendientes</b>');
  if (runningTitle) lines.push(`🟢 En curso: <i>${escapeHtml(runningTitle)}</i>`);
  lines.push('');
  if (!tasks.length) {
    lines.push('<i>No tienes tareas pendientes registradas.</i>');
  } else {
    const prio: Record<string, string> = { HIGH: '🔴', NORMAL: '🟡', LOW: '🟢' };
    tasks.slice(0, 20).forEach((t, i) => {
      const due = t.dueDate ? ` · vence ${formatLocal(t.dueDate, timezone, false)}` : '';
      const project = t.projectName ? ` <i>(${escapeHtml(t.projectName)})</i>` : '';
      lines.push(`${i + 1}. ${prio[t.priority] ?? '•'} ${escapeHtml(t.title)}${project}${due}`);
    });
  }
  lines.push('', '<i>Para empezar una: envia una nota de voz diciendo en que proyecto vas a trabajar.</i>');
  return lines.join('\n');
}

export function projectPrompt(candidates: Array<{ name: string; clientName: string }>): string {
  const list = candidates.slice(0, 6).map((c) => `• ${escapeHtml(c.name)} <i>(${escapeHtml(c.clientName)})</i>`);
  return ['🤔 <b>No identifique el proyecto.</b>', 'Elige uno o vuelve a decir el nombre:', '', ...list].join('\n');
}

export const errorMessage = (detail: string): string =>
  `⚠️ No pude procesar el mensaje.\n<i>${escapeHtml(truncate(detail, 300))}</i>\n\nIntenta de nuevo o escribe /ayuda.`;

export const transcriptionFailed = (): string =>
  '🎙 No pude transcribir el audio.\nVerifica que la OPENAI_API_KEY este configurada en el panel o escribe la tarea por texto.';
