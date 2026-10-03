import { prisma } from '../db/prisma';
import {
  setBotToken,
  sendMessage,
  sendChatAction,
  downloadFile,
  fileExtension,
  chunkMessage,
  answerCallbackQuery,
  editMessageText,
  type TgMessage,
  type TgUpdate,
} from './telegram.api';
import { parseCommand } from '../services/nlu.service';
import { transcribeAudio } from '../services/audio.service';
import { linkContactToUser, shareContactKeyboard } from '../services/telegram-auth.service';
import {
  getActiveEntry,
  startTimer,
  pauseTimer,
  resumeTimer,
  stopTimer,
  cancelActive,
} from '../services/timer.service';
import { isWithinWorkHours } from '../utils/time';
import { listVisibleProjects } from '../services/resolve.service';
import { githubToken } from '../config/env';
import {
  MAIN_KEYBOARD,
  agendaMessage,
  entryButtons,
  errorMessage,
  helpMessage,
  pauseConfirmation,
  projectPicker,
  projectPrompt,
  resumeConfirmation,
  startConfirmation,
  statusMessage,
  stopConfirmation,
  transcriptionFailed,
} from './messages';
import {
  buildTelegramReport,
  nluContext,
  pendingTasksFor,
  presetFromEntities,
  rememberPendingProject,
  takePendingProject,
  todaySeconds,
  type HandlerUser,
} from '../services/assistant.service';
import { SETTING_KEYS, getSetting } from '../services/settings.service';
import type { ResolvedProject } from '../services/resolve.service';

/**
 * Controlador del Bot de Telegram.
 * Se usa tanto desde el webhook (POST /api/telegram/webhook) como desde
 * el long polling interno (TELEGRAM_MODE=polling).
 */

interface LinkedUser extends HandlerUser {
  telegramId: string;
  companyName: string;
}

/** Datos minimos de un mensaje que usan los comandos. */
interface CommandInput {
  text?: string;
  from?: { id: number; username?: string };
}

/** El usuario ya vinculado, o null. */
async function findLinkedUser(telegramId: string) {
  return prisma.user.findFirst({
    where: { telegramId, isActive: true },
    include: { role: true },
  });
}

async function toHandlerUser(user: {
  id: string;
  fullName: string;
  telegramId: string | null;
  timezone: string;
  role: { key: string };
}): Promise<LinkedUser> {
  return {
    id: user.id,
    fullName: user.fullName,
    roleKey: user.role.key,
    timezone: user.timezone,
    telegramId: user.telegramId!,
    companyName: getSetting(SETTING_KEYS.COMPANY_NAME, 'TeleTimeTracker'),
  };
}

async function logInteraction(params: {
  userId?: string | null;
  telegramId?: string | null;
  chatId?: string | null;
  kind: string;
  rawText?: string | null;
  transcript?: string | null;
  intent?: string | null;
  entities?: unknown;
  reply?: string | null;
  ok?: boolean;
  error?: string | null;
  latencyMs?: number;
}): Promise<void> {
  try {
    await prisma.botMessage.create({
      data: {
        userId: params.userId ?? null,
        telegramId: params.telegramId ?? null,
        chatId: params.chatId ?? null,
        kind: params.kind,
        rawText: params.rawText ?? null,
        transcript: params.transcript ?? null,
        intent: params.intent ?? null,
        entities: params.entities ? JSON.stringify(params.entities) : null,
        reply: params.reply ? params.reply.slice(0, 1500) : null,
        ok: params.ok ?? true,
        error: params.error ?? null,
        latencyMs: params.latencyMs ?? null,
      },
    });
  } catch (err) {
    console.warn('[bot] no se pudo registrar la interaccion:', (err as Error).message);
  }
}

/** Envia respuesta partiendo mensajes largos. */
async function reply(chatId: number | string, text: string, extra?: Parameters<typeof sendMessage>[2]): Promise<void> {
  const parts = chunkMessage(text);
  for (let i = 0; i < parts.length; i++) {
    await sendMessage(chatId, parts[i]!, i === parts.length - 1 ? { ...extra, parse_mode: 'HTML' } : { parse_mode: 'HTML' });
  }
}

// ---------------------------------------------------------------------------
// Comandos explicitos (/estado, /reporte, ...)
// ---------------------------------------------------------------------------
interface CommandResult {
  handled: boolean;
  text?: string;
  /** Muestra el boton persistente "Compartir mi numero". */
  needContactKeyboard?: boolean;
}

async function handleSlashCommand(message: CommandInput, user: LinkedUser | null): Promise<CommandResult> {
  const raw = (message.text ?? '').trim();
  if (!raw.startsWith('/')) return { handled: false };
  const [commandRaw, ...args] = raw.split(/\s+/);
  const command = (commandRaw ?? '').split('@')[0]!.toLowerCase();
  const arg = args.join(' ').trim();

  if (command === '/vincular' || command === '/link') {
    const code = arg.toUpperCase();
    if (!code) return { handled: true, text: '🔗 Envia tu codigo de vinculacion: <code>/vincular ABCD-1234</code>' };
    const pending = await prisma.user.findFirst({
      where: { telegramLinkCode: code, telegramLinkExp: { gt: new Date() } },
    });
    if (!pending) {
      return { handled: true, text: '❌ Codigo invalido o expirado. Pide uno nuevo en el panel web.' };
    }
    await prisma.user.update({
      where: { id: pending.id },
      data: {
        telegramId: String(message.from!.id),
        telegramUsername: message.from?.username ?? null,
        telegramLinkedAt: new Date(),
        telegramLinkCode: null,
        telegramLinkExp: null,
      },
    });
    return {
      handled: true,
      text: `✅ Cuenta vinculada a <b>${pending.fullName}</b>.\nYa puedes enviar notas de voz para registrar tu tiempo. Escribe /ayuda para ver ejemplos.`,
    };
  }

  if (command === '/start' || command === '/ayuda' || command === '/help') {
    return { handled: true, text: helpMessage(user?.companyName ?? 'TeleTimeTracker', Boolean(user)) };
  }

  // Vinculacion compartiendo el telefono (camino principal para quien empieza).
  if (command === '/telefono' || command === '/phone' || command === '/vincular-telefono') {
    if (user) {
      return { handled: true, text: `✅ Ya estás vinculado como <b>${user.fullName}</b>.` };
    }
    return {
      handled: true,
      text: '📱 Toca el botón <b>Compartir mi número</b> aquí abajo para vincular tu cuenta.',
      needContactKeyboard: true,
    };
  }

  if (!user) {
    return {
      handled: true,
      text: '⚠️ Tu Telegram no esta vinculado a ninguna cuenta.\nPide a un administrador tu codigo y envialo con <code>/vincular CODIGO</code>.',
    };
  }

  switch (command) {
    case '/estado':
    case '/status': {
      const entry = await getActiveEntry(user.id);
      const seconds = await todaySeconds(user.id, user.timezone);
      return { handled: true, text: statusMessage(entry, user.timezone, seconds) };
    }
    case '/pausar':
    case '/pause': {
      const res = await pauseTimer(user.id, arg || 'Pausa por comando');
      if (!res.ok || !res.entry) return { handled: true, text: res.message ?? 'No tienes tarea activa.' };
      return { handled: true, text: pauseConfirmation(res.entry, user.timezone) };
    }
    case '/retomar':
    case '/resume': {
      const res = await resumeTimer(user.id);
      if (!res.ok || !res.entry) return { handled: true, text: res.message ?? 'No tienes tarea activa.' };
      return { handled: true, text: resumeConfirmation(res.entry, user.timezone) };
    }
    case '/terminar':
    case '/stop': {
      const res = await stopTimer({ userId: user.id, description: arg || undefined });
      if (!res.ok || !res.entry) return { handled: true, text: res.message ?? 'No tienes tarea activa.' };
      return { handled: true, text: stopConfirmation(res.entry, user.timezone, Boolean(githubToken())) };
    }
    case '/cancelar':
    case '/cancel': {
      const res = await cancelActive(user.id);
      return { handled: true, text: res.ok ? '🚫 Tarea descartada (no se contabiliza).' : res.message ?? 'No hay tarea activa.' };
    }
    case '/reporte':
    case '/report': {
      const text = await buildTelegramReport(user, { preset: presetFromEntities(arg || 'hoy', {}), entities: {} });
      return { handled: true, text };
    }
    case '/pendientes':
    case '/agenda': {
      const [tasks, entry] = await Promise.all([pendingTasksFor(user.id), getActiveEntry(user.id)]);
      return { handled: true, text: agendaMessage(tasks, entry?.title ?? null, user.timezone) };
    }
    case '/misproyectos': {
      const projects = await listVisibleProjects(user.id, user.roleKey);
      const list = projects.map((p) => `• ${p.name} <i>(${p.client.name})</i>`).join('\n');
      return { handled: true, text: `📁 <b>Proyectos disponibles</b>\n${list || '<i>Sin proyectos asignados.</i>'}` };
    }
    default:
      return { handled: true, text: 'No conozco ese comando. Escribe /ayuda.' };
  }
}

// ---------------------------------------------------------------------------
// Acciones del NLU
// ---------------------------------------------------------------------------
async function handleStartLike(user: LinkedUser, text: string, entities: any, source: string, switchMode: boolean) {
  const res = await startTimer({
    userId: user.id,
    roleKey: user.roleKey,
    rawText: text,
    projectName: entities.projectName,
    clientName: entities.clientName,
    taskTypeName: entities.taskTypeName,
    title: entities.title ?? text,
    description: entities.description,
    tag: entities.tag,
    source,
  });

  if (res.needsProject) {
    rememberPendingProject(user.id, text);
    const candidates = (res.available ?? []).slice(0, 8);
    if (!candidates.length) {
      return {
        text: '📁 No tienes proyectos configurados. Pide a un administrador que cree un proyecto o te asigne a uno.',
      };
    }
    return {
      text: projectPrompt(candidates),
      markup: projectPicker(candidates.map((c: ResolvedProject) => ({ id: c.id, label: `${c.name} · ${c.clientName}` }))),
    };
  }

  void switchMode; // el encabezado de "cambio de tarea" ya lo arma startConfirmation
  return { text: startConfirmation(res.entry!, res.previous ?? null, user.timezone), markup: entryButtons(res.entry!.id) };
}

// ---------------------------------------------------------------------------
// Entrada principal
// ---------------------------------------------------------------------------
export async function processUpdate(update: TgUpdate): Promise<void> {
  const started = Date.now();
  try {
    if (update.callback_query) return await handleCallback(update.callback_query);
    const message = update.message ?? update.edited_message;
    if (!message) return;
    if (!message.from || message.from.is_bot) return;
    if (message.chat.type !== 'private') {
      await sendMessage(message.chat.id, '👋 Escríbeme por privado para registrar tu tiempo.');
      return;
    }
    return await handleMessage(message, started);
  } catch (err) {
    console.error('[bot] error procesando update:', err);
  }
}

async function handleMessage(message: TgMessage, started: number): Promise<void> {
  const telegramId = String(message.from!.id);
  const chatId = message.chat.id;
  const linked = await findLinkedUser(telegramId);
  const user = linked ? await toHandlerUser(linked) : null;

  // 1) Comandos explicitos
  const commandResult = await handleSlashCommand({ text: message.text, from: message.from }, user);
  if (commandResult.handled) {
    const markup = commandResult.needContactKeyboard
      ? shareContactKeyboard()
      : user
        ? MAIN_KEYBOARD
        : undefined;
    await reply(chatId, commandResult.text!, { reply_markup: markup });
    await logInteraction({
      userId: user?.id,
      telegramId,
      chatId: String(chatId),
      kind: 'COMMAND',
      rawText: message.text,
      reply: commandResult.text,
      latencyMs: Date.now() - started,
    });
    return;
  }

  // 2) Contacto compartido (boton "Compartir mi numero")
  if (message.contact) {
    const result = await linkContactToUser({
      telegramId,
      telegramUsername: message.from?.username ?? null,
      phoneNumber: message.contact.phone_number,
      firstName: message.contact.first_name,
      lastName: message.contact.last_name,
      contactUserId: message.contact.user_id,
    });
    await reply(chatId, result.text, {
      reply_markup: result.status === 'LINKED' ? MAIN_KEYBOARD : shareContactKeyboard(),
    });
    await logInteraction({
      userId: result.userId,
      telegramId,
      chatId: String(chatId),
      kind: 'CONTACT',
      rawText: 'contact',
      intent: result.status,
      reply: result.text,
      latencyMs: Date.now() - started,
    });
    return;
  }

  // 3) Audio / nota de voz
  const audio = message.voice ?? message.audio;
  if (audio) {
    if (!user) {
      await reply(
        chatId,
        '⚠️ Vincula tu cuenta primero. Toca <b>Compartir mi número</b>, o usa el código con <code>/vincular CODIGO</code>.',
        { reply_markup: shareContactKeyboard() },
      );
      return;
    }
    await sendChatAction(chatId, 'typing');
    const { buffer, path } = await downloadFile(audio.file_id);
    const result = await transcribeAudio({
      buffer,
      filename: `nota.${fileExtension(path)}`,
      mimeType: audio.mime_type ?? 'audio/ogg',
    });
    if (!result.ok || !result.text) {
      await reply(chatId, transcriptionFailed());
      await logInteraction({
        userId: user.id, telegramId, chatId: String(chatId), kind: 'VOICE',
        ok: false, error: result.error, latencyMs: Date.now() - started,
      });
      return;
    }
    await reply(chatId, `🎙 <i>${escapeForHtml(result.text)}</i>`);
    await handleNaturalText(user, result.text, chatId, telegramId, 'VOICE', 'TELEGRAM_VOICE', started, message.message_id);
    return;
  }

  // 3) Texto natural
  if (message.text) {
    await handleNaturalText(user, message.text, chatId, telegramId, 'TEXT', 'TELEGRAM_TEXT', started, message.message_id);
    return;
  }

  await reply(chatId, 'Puedo procesar texto o notas de voz. Escribe /ayuda para ver ejemplos.');
}

const escapeForHtml = (v: string): string => v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

async function handleNaturalText(
  user: LinkedUser | null,
  text: string,
  chatId: number,
  telegramId: string,
  kind: 'TEXT' | 'VOICE',
  source: string,
  started: number,
  replyTo?: number,
): Promise<void> {
  if (!user) {
    await reply(
      chatId,
      '⚠️ Tu Telegram no está vinculado todavía.\n\n' +
        'Toca <b>📱 Compartir mi número</b> aquí abajo para vincular tu cuenta.' +
        '\n\nSi tu administrador ya te dio un código, envíalo con <code>/vincular CODIGO</code>.',
      { reply_markup: shareContactKeyboard() },
    );
    return;
  }

  // Accesos rapidos del teclado persistente
  const quick = text.trim().toLowerCase();
  if (['📊 estado', 'estado'].includes(quick)) {
    const entry = await getActiveEntry(user.id);
    await reply(chatId, statusMessage(entry, user.timezone, await todaySeconds(user.id, user.timezone)));
    return;
  }
  if (['📝 pendientes', 'pendientes'].includes(quick)) {
    const [tasks, entry] = await Promise.all([pendingTasksFor(user.id), getActiveEntry(user.id)]);
    await reply(chatId, agendaMessage(tasks, entry?.title ?? null, user.timezone));
    return;
  }
  if (['⏸ pausar', 'pausar'].includes(quick)) {
    const res = await pauseTimer(user.id, 'Pausa desde teclado');
    await reply(chatId, res.entry ? pauseConfirmation(res.entry, user.timezone) : res.message ?? 'Sin tarea activa.');
    return;
  }
  if (['▶️ retomar', 'retomar'].includes(quick)) {
    const res = await resumeTimer(user.id);
    await reply(chatId, res.entry ? resumeConfirmation(res.entry, user.timezone) : res.message ?? 'Sin tarea activa.');
    return;
  }
  if (['⏹ terminar', 'terminar'].includes(quick)) {
    const res = await stopTimer({ userId: user.id });
    await reply(chatId, res.entry ? stopConfirmation(res.entry, user.timezone, Boolean(githubToken())) : res.message ?? 'Sin tarea activa.');
    return;
  }

  // Codigo de vinculacion enviado suelto (sin comando)
  const codeOnly = text.trim().toUpperCase().match(/^([A-Z0-9]{4}-[A-Z0-9]{4})$/);
  if (codeOnly) {
    const res = await handleSlashCommand(
      { text: `/vincular ${codeOnly[1]}`, from: { id: Number(telegramId) } },
      user,
    );
    await reply(chatId, res.text ?? 'Procesado.');
    return;
  }

  const context = await nluContext(user.id, user.roleKey);
  const parsed = await parseCommand(text, context);
  let response = '';
  let markup: any = undefined;

  switch (parsed.intent) {
    case 'STOP': {
      const res = await stopTimer({
        userId: user.id,
        description: parsed.entities.description ?? text,
        taskTypeName: parsed.entities.taskTypeName,
        tag: parsed.entities.tag,
        source,
      });
      response = res.entry ? stopConfirmation(res.entry, user.timezone, Boolean(githubToken())) : res.message ?? 'No tienes tarea activa.';
      break;
    }
    case 'PAUSE': {
      const res = await pauseTimer(user.id, parsed.entities.description ?? text, source);
      response = res.entry ? pauseConfirmation(res.entry, user.timezone) : res.message ?? 'No tienes tarea activa.';
      if (res.entry) markup = entryButtons(res.entry.id);
      break;
    }
    case 'RESUME': {
      const res = await resumeTimer(user.id, source);
      response = res.entry ? resumeConfirmation(res.entry, user.timezone) : res.message ?? 'No tienes tarea activa.';
      break;
    }
    case 'SWITCH':
    case 'START': {
      const result = await handleStartLike(user, text, parsed.entities, source, parsed.intent === 'SWITCH');
      response = result.text;
      markup = result.markup;
      break;
    }
    case 'STATUS': {
      const entry = await getActiveEntry(user.id);
      response = statusMessage(entry, user.timezone, await todaySeconds(user.id, user.timezone));
      if (entry) markup = entryButtons(entry.id);
      break;
    }
    case 'REPORT': {
      response = await buildTelegramReport(user, { preset: presetFromEntities(text, parsed.entities), entities: parsed.entities });
      break;
    }
    case 'AGENDA': {
      const [tasks, entry] = await Promise.all([pendingTasksFor(user.id), getActiveEntry(user.id)]);
      response = agendaMessage(tasks, entry?.title ?? null, user.timezone);
      break;
    }
    case 'HELP': {
      response = helpMessage(user.companyName, true);
      break;
    }
    default: {
      // Texto ambiguo: si no tiene tarea activa, se interpreta como inicio de tarea.
      const entry = await getActiveEntry(user.id);
      if (!entry) {
        const result = await handleStartLike(user, text, parsed.entities, source, false);
        response = `🤔 No estoy seguro de la intencion, pero te dejo la tarea iniciada:\n\n${result.text}`;
        markup = result.markup;
      } else {
        response = [
          '🤔 No entendi el mensaje. Estas trabajando en:',
          `🟢 <b>${escapeForHtml(entry.title ?? 'Tarea')}</b>`,
          '',
          'Prueba con: "terminar", "pausa", "cambia a &lt;proyecto&gt;" o /ayuda.',
        ].join('\n');
      }
    }
  }

  await reply(chatId, response || 'Sin respuesta.', { reply_markup: markup ?? MAIN_KEYBOARD, ...(replyTo ? { reply_to_message_id: replyTo } : {}) });
  await logInteraction({
    userId: user.id,
    telegramId,
    chatId: String(chatId),
    kind,
    rawText: text,
    transcript: kind === 'VOICE' ? text : null,
    intent: parsed.intent,
    entities: parsed.entities,
    reply: response,
    latencyMs: Date.now() - started,
  });
}

// ---------------------------------------------------------------------------
// Botones inline
// ---------------------------------------------------------------------------
async function handleCallback(query: TgUpdate['callback_query']): Promise<void> {
  if (!query?.data) return;
  const telegramId = String(query.from.id);
  const linked = await findLinkedUser(telegramId);
  const [action, value] = query.data.split(':');

  await answerCallbackQuery(query.id).catch(() => false);

  if (!linked) {
    await answerCallbackQuery(query.id, 'Vincula tu cuenta primero', true).catch(() => false);
    return;
  }
  const user = await toHandlerUser(linked);
  const chatId = query.message?.chat.id;
  if (!chatId) return;

  switch (action) {
    case 'pause': {
      const res = await pauseTimer(user.id, 'Pausa desde boton', 'TELEGRAM_BUTTON');
      await reply(chatId, res.entry ? pauseConfirmation(res.entry, user.timezone) : res.message ?? 'Sin tarea activa.', { reply_markup: MAIN_KEYBOARD });
      break;
    }
    case 'stop': {
      const res = await stopTimer({ userId: user.id, source: 'TELEGRAM_BUTTON' });
      await reply(chatId, res.entry ? stopConfirmation(res.entry, user.timezone, Boolean(githubToken())) : res.message ?? 'Sin tarea activa.', { reply_markup: MAIN_KEYBOARD });
      break;
    }
    case 'status': {
      const entry = await getActiveEntry(user.id);
      const text = statusMessage(entry, user.timezone, await todaySeconds(user.id, user.timezone));
      if (query.message) await editMessageText(chatId, query.message.message_id, text, { reply_markup: entry ? entryButtons(entry.id) : MAIN_KEYBOARD }).catch(() => reply(chatId, text));
      break;
    }
    case 'pick': {
      const pending = takePendingProject(user.id);
      const project = await prisma.clientProject.findUnique({ where: { id: value }, include: { client: true } });
      if (!project) {
        await reply(chatId, 'No encontre ese proyecto.');
        return;
      }
      const res = await startTimer({
        userId: user.id,
        roleKey: user.roleKey,
        rawText: pending?.text ?? project.name, // texto original del trabajador
        project: { id: project.id, name: project.name, clientId: project.client.id, clientName: project.client.name, githubRepos: project.githubRepos },
        title: pending?.text || project.name,
        source: 'TELEGRAM_BUTTON',
      });
      await reply(chatId, startConfirmation(res.entry!, res.previous ?? null, user.timezone), {
        reply_markup: entryButtons(res.entry!.id),
      });
      break;
    }
    default:
      await reply(chatId, 'Accion no reconocida.');
  }
}

// ---------------------------------------------------------------------------
// Long polling (alternativa al webhook)
// ---------------------------------------------------------------------------
let polling = false;
let offset: number | undefined;

export async function startPolling(): Promise<void> {
  if (polling) return;
  polling = true;
  const { getUpdates } = await import('./telegram.api');
  console.log('[bot] long polling activo');
  // Bucle infinito controlado; se detiene si el proceso muere.
  while (polling) {
    try {
      const updates = await getUpdates(offset, 30);
      for (const update of updates) {
        offset = update.update_id + 1;
        await processUpdate(update);
      }
    } catch (err) {
      const message = (err as Error).message;
      if (/401|404/.test(message)) {
        console.error('[bot] token invalido, deteniendo polling:', message);
        polling = false;
        break;
      }
      if (!/abort/i.test(message)) console.warn('[bot] error de polling, reintento en 5s:', message);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

export function stopPolling(): void {
  polling = false;
}

/** Aplica el token guardado en la BD al cliente de Telegram. */
export function applyBotTokenFromSettings(token: string): void {
  setBotToken(token || null);
}

export const botRuntime = {
  webhookSecret: () => process.env.TELEGRAM_WEBHOOK_SECRET ?? '',
  isWorkTime: (user: { timezone: string; workDays: string; workStart: string; workEnd: string }) =>
    isWithinWorkHours(new Date(), {
      timezone: user.timezone,
      workDays: user.workDays.split(',').map((d) => Number.parseInt(d, 10)).filter((n) => Number.isFinite(n)),
      workStart: user.workStart,
      workEnd: user.workEnd,
    }),
};
