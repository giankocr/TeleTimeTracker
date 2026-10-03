import { telegramToken } from '../config/env';

/**
 * Cliente HTTP minimo para la Bot API de Telegram.
 * Se implementa a mano (sin dependencias) para tener control total sobre
 * webhooks y long polling dentro del mismo proceso Fastify.
 */

// Configurable para pruebas locales (servidor stub) y para despliegues detras
// de proxies o mocks. En produccion siempre es la API oficial.
const API_BASE = (process.env.TELEGRAM_API_BASE ?? 'https://api.telegram.org').replace(/\/$/, '');
const FILE_BASE = API_BASE.replace('/bot', ''); // la descarga de archivos no lleva el token en la ruta base

export interface TgUser {
  id: number;
  is_bot: boolean;
  first_name: string;
  last_name?: string;
  username?: string;
  language_code?: string;
}

export interface TgChat {
  id: number;
  type: 'private' | 'group' | 'supergroup' | 'channel';
  title?: string;
  username?: string;
}

export interface TgMessage {
  message_id: number;
  from?: TgUser;
  chat: TgChat;
  date: number;
  text?: string;
  voice?: { file_id: string; duration: number; mime_type?: string; file_size?: number };
  audio?: { file_id: string; duration: number; mime_type?: string; file_size?: number; file_name?: string };
  document?: { file_id: string; file_name?: string; mime_type?: string };
  /** Contacto compartido con el boton "Compartir mi numero". */
  contact?: {
    phone_number: string;
    first_name: string;
    last_name?: string;
    user_id?: number;
  };
  caption?: string;
}

export interface TgCallbackQuery {
  id: string;
  from: TgUser;
  message?: TgMessage;
  data?: string;
}

export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  edited_message?: TgMessage;
  callback_query?: TgCallbackQuery;
}

export interface InlineKeyboardButton {
  text: string;
  callback_data?: string;
  url?: string;
}

export interface KeyboardButton {
  text: string;
  /** Pide el telefono del usuario (ReplyKeyboard). No existe en botones inline. */
  request_contact?: boolean;
  request_location?: boolean;
}

export type ReplyMarkup = {
  inline_keyboard?: InlineKeyboardButton[][];
  keyboard?: KeyboardButton[][];
  resize_keyboard?: boolean;
  is_persistent?: boolean;
  /** Texto del placeholder de la barra de teclado. */
  input_field_placeholder?: string;
  /** Oculta el teclado. */
  remove_keyboard?: boolean;
  one_time_keyboard?: boolean;
};

export interface SendMessageOptions {
  reply_markup?: ReplyMarkup;
  parse_mode?: 'HTML' | 'MarkdownV2' | 'Markdown';
  disable_notification?: boolean;
  reply_to_message_id?: number;
}

export class TelegramApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly description?: string,
  ) {
    super(message);
    this.name = 'TelegramApiError';
  }
}

let tokenOverride: string | null = null;
/** Permite usar el token guardado desde el panel sin reiniciar el proceso. */
export const setBotToken = (token: string | null): void => {
  tokenOverride = token;
};

const currentToken = (): string => tokenOverride || telegramToken();

export const isConfigured = (): boolean => Boolean(currentToken());

async function call<T>(method: string, payload?: Record<string, unknown>, timeoutMs = 20_000): Promise<T> {
  const token = currentToken();
  if (!token) throw new TelegramApiError('TELEGRAM_BOT_TOKEN no configurado', 0);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${API_BASE}/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload ?? {}),
      signal: controller.signal,
    });
    const json = (await res.json().catch(() => ({}))) as {
      ok: boolean;
      result?: T;
      description?: string;
      error_code?: number;
    };
    if (!json.ok) {
      throw new TelegramApiError(json.description ?? `Error en ${method}`, json.error_code ?? res.status, json.description);
    }
    return json.result as T;
  } finally {
    clearTimeout(timer);
  }
}

export const getMe = () => call<TgUser>('getMe');

export const sendMessage = (chatId: string | number, text: string, options: SendMessageOptions = {}) =>
  call<TgMessage>('sendMessage', {
    chat_id: chatId,
    text,
    parse_mode: options.parse_mode ?? 'HTML',
    disable_web_page_preview: true,
    ...(options.reply_markup ? { reply_markup: options.reply_markup } : {}),
    ...(options.disable_notification ? { disable_notification: true } : {}),
    ...(options.reply_to_message_id ? { reply_to_message_id: options.reply_to_message_id } : {}),
  });

export const editMessageText = (
  chatId: string | number,
  messageId: number,
  text: string,
  options: SendMessageOptions = {},
) =>
  call<TgMessage>('editMessageText', {
    chat_id: chatId,
    message_id: messageId,
    text,
    parse_mode: options.parse_mode ?? 'HTML',
    ...(options.reply_markup ? { reply_markup: options.reply_markup } : {}),
  });

export const answerCallbackQuery = (callbackQueryId: string, text?: string, showAlert = false) =>
  call<boolean>('answerCallbackQuery', {
    callback_query_id: callbackQueryId,
    ...(text ? { text } : {}),
    show_alert: showAlert,
  });

export const setMyCommands = (
  commands: Array<{ command: string; description: string }>,
) => call<boolean>('setMyCommands', { commands });

export const sendChatAction = (chatId: string | number, action = 'typing') =>
  call<boolean>('sendChatAction', { chat_id: chatId, action }).catch(() => false);

export const deleteWebhook = (dropPending = false) =>
  call<boolean>('deleteWebhook', { drop_pending_updates: dropPending });

export const setWebhook = (url: string, secretToken?: string) =>
  call<boolean>('setWebhook', {
    url,
    ...(secretToken ? { secret_token: secretToken } : {}),
    allowed_updates: ['message', 'edited_message', 'callback_query'],
    drop_pending_updates: false,
  });

export const getWebhookInfo = () => call<Record<string, unknown>>('getWebhookInfo');

export const getUpdates = (offset?: number, timeoutSec = 30) =>
  call<TgUpdate[]>('getUpdates', { offset, timeout: timeoutSec, allowed_updates: ['message', 'callback_query'] }, (timeoutSec + 15) * 1000);

export interface TgFile {
  file_id: string;
  file_unique_id: string;
  file_size?: number;
  file_path?: string;
}

export const getFile = (fileId: string) => call<TgFile>('getFile', { file_id: fileId });

/** Descarga el contenido binario de un archivo (nota de voz) a memoria. */
export async function downloadFile(fileId: string, maxBytes = 25 * 1024 * 1024): Promise<{ buffer: Buffer; path: string }> {
  const token = currentToken();
  if (!token) throw new TelegramApiError('TELEGRAM_BOT_TOKEN no configurado', 0);
  const file = await getFile(fileId);
  if (!file.file_path) throw new TelegramApiError('Telegram no devolvio file_path', 0);
  const res = await fetch(`${FILE_BASE}/file/bot${token}/${file.file_path}`);
  if (!res.ok) throw new TelegramApiError(`Descarga fallida (${res.status})`, res.status);
  const arrayBuffer = await res.arrayBuffer();
  if (arrayBuffer.byteLength > maxBytes) throw new TelegramApiError('Archivo demasiado grande', 413);
  return { buffer: Buffer.from(arrayBuffer), path: file.file_path };
}

export const fileExtension = (filePath: string, fallback = 'ogg'): string => {
  const ext = filePath.split('.').pop();
  return ext && ext.length <= 5 ? ext : fallback;
};

export const TELEGRAM_MAX_MESSAGE = 4096;

/** Parte mensajes largos respetando el limite de Telegram. */
export function chunkMessage(text: string, limit = TELEGRAM_MAX_MESSAGE): string[] {
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  let current = '';
  for (const line of text.split('\n')) {
    if ((current + line).length + 1 > limit) {
      chunks.push(current);
      current = '';
    }
    current += `${line}\n`;
  }
  if (current.trim()) chunks.push(current);
  return chunks;
}
