import crypto from 'node:crypto';
import { prisma } from '../db/prisma';
import { telegramToken } from '../config/env';
import { getSetting, SETTING_KEYS } from './settings.service';
import { getMe, sendMessage, type ReplyMarkup } from '../bot/telegram.api';

/**
 * Acceso al panel con Telegram, replicando la logica de NosotrosConstruimos:
 *
 *  1) Telegram OAuth / Login Widget -> el usuario autoriza y Telegram devuelve
 *     los datos firmados (en el hash `#tgAuthResult` o como query params).
 *     Se verifican en el SERVIDOR con HMAC-SHA256 usando SHA256(bot_token).
 *  2) Telefono + codigo OTP enviado por el bot (6 digitos, 10 minutos).
 *  3) Correo + contrasena (administradores).
 *
 * El identificador del bot para el boton de OAuth es PUBLICO y sale del prefijo
 * del token ("123456:AAH..." -> "123456").
 */

/** Vigencia maxima de una autorizacion de Telegram (segundos). */
const MAX_AUTH_AGE_SECONDS = 60 * 60; // 1 hora
/** Vigencia del codigo OTP. */
const OTP_TTL_MINUTES = 10;
/** Intentos fallidos permitidos por codigo. */
const OTP_MAX_ATTEMPTS = 5;
/** Espera minima entre envios de codigo al mismo usuario (segundos). */
const OTP_RESEND_COOLDOWN_SECONDS = 60;

export interface TelegramLoginPayload {
  id: number;
  first_name?: string;
  last_name?: string;
  username?: string;
  photo_url?: string;
  auth_date: number;
  hash: string;
}

// ---------------------------------------------------------------------------
// Token y datos publicos del bot
// ---------------------------------------------------------------------------
/** Token del bot: panel (BD) primero, luego entorno. */
export function getBotToken(): string | null {
  const token = telegramToken();
  return token || null;
}

/**
 * Id numerico del bot (publico). Se obtiene del prefijo del token, asi no hace
 * falta consultar la API de Telegram para pintar el boton de login.
 */
export function getBotId(): string | null {
  const token = getBotToken();
  if (!token) return null;
  const id = token.split(':')[0] ?? '';
  return /^\d+$/.test(id) ? id : null;
}

let botUsernameCache: { value: string | null; at: number } | null = null;

export async function getBotUsername(): Promise<string | null> {
  if (!getBotToken()) return null;
  if (botUsernameCache && Date.now() - botUsernameCache.at < 10 * 60 * 1000) return botUsernameCache.value;
  try {
    const me = await getMe();
    botUsernameCache = { value: me.username ?? null, at: Date.now() };
    return me.username ?? null;
  } catch {
    botUsernameCache = { value: null, at: Date.now() };
    return null;
  }
}

export function invalidateBotUsernameCache(): void {
  botUsernameCache = null;
}

// ---------------------------------------------------------------------------
// Verificacion de la firma de Telegram
// ---------------------------------------------------------------------------
/** Cadena que firma Telegram: claves ordenadas, sin `hash`, sin valores vacios. */
export function buildDataCheckString(data: Record<string, unknown>): string {
  return Object.entries(data)
    .filter(([key, value]) => key !== 'hash' && value !== undefined && value !== null && value !== '')
    .map(([key, value]) => [key, String(value)] as [string, string])
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
}

export type VerifyResult =
  | { ok: true; payload: TelegramLoginPayload }
  | { ok: false; error: string; code: string };

/**
 * Verifica los datos del Login Widget / OAuth.
 *  - `auth_date` no puede ser futuro ni tener mas de 1 hora.
 *  - El hash se recomputa y se compara en tiempo constante.
 */
export function verifyTelegramLoginPayload(
  data: TelegramLoginPayload,
  botToken: string,
  now: Date = new Date(),
): VerifyResult {
  const authAge = Math.floor(now.getTime() / 1000) - data.auth_date;
  if (!Number.isFinite(data.auth_date) || authAge < -60 || authAge > MAX_AUTH_AGE_SECONDS) {
    return { ok: false, error: 'La autorizacion de Telegram expiro. Intenta de nuevo.', code: 'TELEGRAM_AUTH_EXPIRED' };
  }
  if (!data.hash || typeof data.hash !== 'string') {
    return { ok: false, error: 'Respuesta de Telegram incompleta.', code: 'TELEGRAM_AUTH_MALFORMED' };
  }

  const secretKey = crypto.createHash('sha256').update(botToken).digest();
  const computed = crypto
    .createHmac('sha256', secretKey)
    .update(buildDataCheckString(data as unknown as Record<string, unknown>))
    .digest('hex');

  try {
    const a = Buffer.from(computed, 'hex');
    const b = Buffer.from(data.hash, 'hex');
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      return { ok: false, error: 'No pudimos validar el login de Telegram.', code: 'TELEGRAM_AUTH_INVALID' };
    }
  } catch {
    return { ok: false, error: 'No pudimos validar el login de Telegram.', code: 'TELEGRAM_AUTH_INVALID' };
  }

  return { ok: true, payload: data };
}

/** Normaliza un payload crudo (query params o el JSON del hash). */
export function normalizeTelegramPayload(raw: Record<string, unknown>): TelegramLoginPayload | null {
  const pick = (...keys: string[]): string | undefined => {
    for (const key of keys) {
      const value = raw[key];
      if (value !== undefined && value !== null && value !== '') return String(value);
    }
    return undefined;
  };

  const id = Number(pick('id'));
  const authDate = Number(pick('auth_date', 'authDate'));
  const hash = pick('hash');
  const firstName = pick('first_name', 'firstName') ?? '';

  if (!Number.isFinite(id) || !Number.isFinite(authDate) || !hash) return null;

  return {
    id,
    auth_date: authDate,
    hash,
    first_name: firstName,
    last_name: pick('last_name', 'lastName'),
    username: pick('username'),
    photo_url: pick('photo_url', 'photoUrl'),
  };
}

/**
 * Telegram devuelve los datos en `#tgAuthResult=<base64(JSON)>` (no llegan al
 * servidor) o como query params si se usa un `data-auth-url`. Esta funcion
 * acepta las dos formas: el cliente puede reenviar el hash tal cual.
 */
export function parseTelegramAuthHash(hash: string): TelegramLoginPayload | null {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  if (!raw) return null;

  const attempt = (text: string): TelegramLoginPayload | null => {
    try {
      const parsed = JSON.parse(text) as Record<string, unknown>;
      return normalizeTelegramPayload(parsed);
    } catch {
      return null;
    }
  };

  // Formato 1: #tgAuthResult=<base64(JSON)>
  if (raw.startsWith('tgAuthResult=')) {
    const encoded = raw.slice('tgAuthResult='.length);
    try {
      const decoded = Buffer.from(decodeURIComponent(encoded), 'base64').toString('utf8');
      const fromBase64 = attempt(decoded);
      if (fromBase64) return fromBase64;
    } catch {
      /* se intenta con JSON plano */
    }
    return attempt(decodeURIComponent(encoded));
  }

  // Formato 2: #tgAuthResult como base64 de un query string (widget mas antiguo)
  try {
    const decoded = Buffer.from(raw, 'base64').toString('utf8');
    if (decoded.includes('auth_date')) {
      const params = new URLSearchParams(decoded.replace(/^tgAuthResult=/, ''));
      return normalizeTelegramPayload(Object.fromEntries(params.entries()));
    }
  } catch {
    /* siguiente intento */
  }

  // Formato 3: los campos directamente en el hash (id=...&hash=...)
  if (raw.includes('id=') && raw.includes('hash=')) {
    return normalizeTelegramPayload(Object.fromEntries(new URLSearchParams(raw).entries()));
  }

  return null;
}

// ---------------------------------------------------------------------------
// Telefono
// ---------------------------------------------------------------------------
/**
 * Normaliza un telefono a E.164 sin espacios.
 * Sin dependencias externas: asume Colombia (+57) cuando llega sin prefijo.
 */
export function normalizePhone(input: string, defaultCountry = '+57'): string | null {
  const cleaned = (input ?? '').replace(/[^\d+]/g, '');
  if (!cleaned) return null;

  if (cleaned.startsWith('+')) {
    const digits = cleaned.slice(1).replace(/\D/g, '');
    return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : null;
  }
  const digits = cleaned.replace(/\D/g, '');
  if (digits.length < 7) return null;
  // Numero local colombiano (10 digitos empezando por 3) -> +57
  if (digits.length === 10 && digits.startsWith('3')) return `+57${digits}`;
  if (digits.length >= 11) return `+${digits}`;
  return `${defaultCountry}${digits}`;
}

/** Presentacion legible: +573001234567 -> +57 300 123 4567 */
export function formatPhone(phone: string): string {
  if (phone.startsWith('+57') && phone.length === 13) {
    return `+57 ${phone.slice(3, 6)} ${phone.slice(6, 9)} ${phone.slice(9)}`;
  }
  return phone;
}

// ---------------------------------------------------------------------------
// Resolucion del usuario (OAuth)
// ---------------------------------------------------------------------------
export interface AccessOutcome {
  ok: boolean;
  status: number;
  error?: string;
  code?: string;
  user?: any;
}

/** Busca el usuario por telegramId y valida que pueda entrar al panel. */
export async function resolvePanelUserByTelegramId(telegramId: string | number): Promise<AccessOutcome> {
  const user = await prisma.user.findUnique({
    where: { telegramId: String(telegramId) },
    include: { role: true, manager: { select: { fullName: true } } },
  });

  if (!user) {
    return {
      ok: false,
      status: 403,
      error:
        'No hay una cuenta vinculada a ese Telegram. Abre el bot, toca /start y comparte tu telefono para vincularlo.',
      code: 'TELEGRAM_NOT_LINKED',
    };
  }
  if (!user.isActive) {
    return { ok: false, status: 403, error: 'Tu cuenta esta desactivada. Contacta al administrador.', code: 'USER_DISABLED' };
  }
  return { ok: true, status: 200, user };
}

/** Resultado completo del login por Telegram (firma + usuario). */
export async function resolveTelegramOAuth(payload: TelegramLoginPayload): Promise<AccessOutcome> {
  const token = getBotToken();
  if (!token) {
    return { ok: false, status: 503, error: 'El bot de Telegram no esta configurado.', code: 'TELEGRAM_NOT_CONFIGURED' };
  }

  const verified = verifyTelegramLoginPayload(payload, token);
  if (!verified.ok) return { ok: false, status: 401, error: verified.error, code: verified.code };

  const outcome = await resolvePanelUserByTelegramId(payload.id);
  if (!outcome.ok || !outcome.user) return outcome;

  // Se completan los datos que aporta Telegram y no teniamos.
  const patch: Record<string, string | Date> = {};
  if (payload.username && outcome.user.telegramUsername !== payload.username) patch.telegramUsername = payload.username;
  if (!outcome.user.telegramLinkedAt) patch.telegramLinkedAt = new Date();
  if (Object.keys(patch).length) {
    await prisma.user.update({ where: { id: outcome.user.id }, data: patch });
  }
  return outcome;
}

// ---------------------------------------------------------------------------
// Codigo OTP enviado por el bot
// ---------------------------------------------------------------------------
const hashCode = (userId: string, code: string): string =>
  crypto.createHash('sha256').update(`${userId}:${code}`).digest('hex');

const generateOtp = (): string => String(crypto.randomInt(100000, 1000000));

export interface OtpRequestResult {
  ok: boolean;
  status: number;
  error?: string;
  code?: string;
  /** Numero al que se envio el codigo, ya normalizado y enmascarado. */
  phone?: string;
  maskedPhone?: string;
  /** El usuario existe pero aun no vinculo Telegram. */
  needsTelegram?: boolean;
  expiresInMinutes?: number;
}

/** Envia un codigo de 6 digitos al chat de Telegram del usuario. */
export async function requestPhoneOtp(rawPhone: string): Promise<OtpRequestResult> {
  if (!getBotToken()) {
    return { ok: false, status: 503, error: 'El bot de Telegram no esta configurado.', code: 'TELEGRAM_NOT_CONFIGURED' };
  }

  const phone = normalizePhone(rawPhone);
  if (!phone) {
    return { ok: false, status: 400, error: 'Escribe un numero de telefono valido.', code: 'PHONE_INVALID' };
  }

  const user = await prisma.user.findUnique({ where: { phone }, include: { role: true } });
  if (!user) {
    return {
      ok: false,
      status: 404,
      error: 'Ese numero no tiene una cuenta registrada. Pide a un administrador que la cree.',
      code: 'PHONE_NOT_REGISTERED',
    };
  }
  if (!user.isActive) {
    return { ok: false, status: 403, error: 'Tu cuenta esta desactivada. Contacta al administrador.', code: 'USER_DISABLED' };
  }
  if (!user.telegramId) {
    return {
      ok: false,
      status: 409,
      error: 'Tu cuenta aun no tiene Telegram vinculado. Abre el bot, toca /start y comparte tu numero.',
      code: 'TELEGRAM_NOT_LINKED',
      needsTelegram: true,
    };
  }
  if (user.otpLastSentAt && Date.now() - user.otpLastSentAt.getTime() < OTP_RESEND_COOLDOWN_SECONDS * 1000) {
    const wait = Math.ceil((OTP_RESEND_COOLDOWN_SECONDS * 1000 - (Date.now() - user.otpLastSentAt.getTime())) / 1000);
    return { ok: false, status: 429, error: `Espera ${wait} segundo(s) antes de pedir otro codigo.`, code: 'OTP_COOLDOWN' };
  }

  const code = generateOtp();
  await prisma.user.update({
    where: { id: user.id },
    data: {
      otpCodeHash: hashCode(user.id, code),
      otpExpiresAt: new Date(Date.now() + OTP_TTL_MINUTES * 60 * 1000),
      otpAttempts: 0,
      otpLastSentAt: new Date(),
      phoneVerifiedAt: user.phoneVerifiedAt ?? new Date(),
    },
  });

  const company = getSetting(SETTING_KEYS.COMPANY_NAME, 'TeleTimeTracker');
  try {
    await sendMessage(
      user.telegramId,
      [
        `🔐 <b>Codigo de acceso</b> — ${company}`,
        '',
        `Tu codigo es: <b><code>${code}</code></b>`,
        '',
        `Caduca en ${OTP_TTL_MINUTES} minutos. Si no fuiste tu, ignora este mensaje.`,
      ].join('\n'),
    );
  } catch (err) {
    return {
      ok: false,
      status: 502,
      error: `No pudimos enviarte el codigo por Telegram. Abre el bot y toca /start. (${(err as Error).message})`,
      code: 'OTP_SEND_FAILED',
      needsTelegram: true,
    };
  }

  return {
    ok: true,
    status: 200,
    phone,
    maskedPhone: maskPhone(phone),
    expiresInMinutes: OTP_TTL_MINUTES,
  };
}

export function maskPhone(phone: string): string {
  if (phone.length <= 6) return phone;
  return `${phone.slice(0, phone.length - 6)}•••${phone.slice(-3)}`;
}

export interface OtpVerifyResult {
  ok: boolean;
  status: number;
  error?: string;
  code?: string;
  user?: any;
}

/** Valida el codigo OTP y devuelve el usuario (la ruta emite los tokens). */
export async function verifyPhoneOtp(rawPhone: string, rawCode: string): Promise<OtpVerifyResult> {
  const phone = normalizePhone(rawPhone);
  const code = (rawCode ?? '').trim();
  if (!phone) return { ok: false, status: 400, error: 'Numero de telefono invalido.', code: 'PHONE_INVALID' };
  if (!/^\d{6}$/.test(code)) return { ok: false, status: 400, error: 'El codigo debe tener 6 numeros.', code: 'OTP_FORMAT' };

  const user = await prisma.user.findUnique({
    where: { phone },
    include: { role: true, manager: { select: { fullName: true } } },
  });
  const invalid = (): OtpVerifyResult => ({ ok: false, status: 401, error: 'Codigo incorrecto o expirado.', code: 'OTP_INVALID' });
  if (!user || !user.otpCodeHash || !user.otpExpiresAt) return invalid();

  if (user.otpExpiresAt.getTime() < Date.now()) {
    await prisma.user.update({
      where: { id: user.id },
      data: { otpCodeHash: null, otpExpiresAt: null, otpAttempts: 0 },
    });
    return { ok: false, status: 401, error: 'El codigo expiro. Pide uno nuevo.', code: 'OTP_EXPIRED' };
  }
  if (user.otpAttempts >= OTP_MAX_ATTEMPTS) {
    return { ok: false, status: 429, error: 'Demasiados intentos. Pide un codigo nuevo.', code: 'OTP_TOO_MANY_ATTEMPTS' };
  }

  const expected = Buffer.from(hashCode(user.id, code), 'utf8');
  const received = Buffer.from(user.otpCodeHash, 'utf8');
  const matches = expected.length === received.length && crypto.timingSafeEqual(expected, received);

  if (!matches) {
    await prisma.user.update({ where: { id: user.id }, data: { otpAttempts: { increment: 1 } } });
    return invalid();
  }

  if (!user.isActive) return { ok: false, status: 403, error: 'Tu cuenta esta desactivada.', code: 'USER_DISABLED' };

  // Codigo de un solo uso: se invalida al usarlo.
  await prisma.user.update({
    where: { id: user.id },
    data: { otpCodeHash: null, otpExpiresAt: null, otpAttempts: 0, phoneVerifiedAt: new Date() },
  });

  return { ok: true, status: 200, user };
}

// ---------------------------------------------------------------------------
// Configuracion publica para la pantalla de login
// ---------------------------------------------------------------------------
export interface LoginConfig {
  companyName: string;
  /** Id publico del bot para el boton de Telegram OAuth. */
  botId: string | null;
  botUsername: string | null;
  telegramEnabled: boolean;
  phoneOtpEnabled: boolean;
  /**
   * 'oauth'  -> boton propio que abre oauth.telegram.org (no necesita /setdomain)
   * 'widget' -> widget oficial de Telegram (requiere registrar el dominio en
   *             BotFather con /setdomain y postea en form-urlencoded)
   */
  telegramLoginMode: 'oauth' | 'widget';
}

export async function loginConfig(): Promise<LoginConfig> {
  const botId = getBotId();
  const rawMode = getSetting(SETTING_KEYS.TELEGRAM_LOGIN_MODE, 'oauth');
  return {
    companyName: getSetting(SETTING_KEYS.COMPANY_NAME, 'TeleTimeTracker'),
    botId,
    botUsername: botId ? await getBotUsername() : null,
    telegramEnabled: Boolean(botId),
    phoneOtpEnabled: Boolean(botId),
    telegramLoginMode: rawMode === 'widget' ? 'widget' : 'oauth',
  };
}

// ---------------------------------------------------------------------------
// Vinculacion desde el bot compartiendo el telefono
// ---------------------------------------------------------------------------
export interface ContactLinkResult {
  status: 'LINKED' | 'ALREADY_LINKED' | 'PENDING' | 'REJECTED_NOT_OWN';
  text: string;
  userId?: string;
}

/**
 * Procesa un contacto compartido por el bot.
 *  - Solo se acepta el numero PROPIO (contact.user_id === from.id).
 *  - Si el telefono ya pertenece a un usuario -> se vincula el telegramId.
 *  - Si no existe esa cuenta -> queda como solicitud (bot_contacts) para que
 *    un administrador la apruebe creando el usuario.
 */
export async function linkContactToUser(params: {
  telegramId: string;
  telegramUsername?: string | null;
  phoneNumber: string;
  firstName?: string;
  lastName?: string;
  contactUserId?: number;
}): Promise<ContactLinkResult> {
  // Seguridad: Telegram permite reenviar la agenda de otra persona.
  if (params.contactUserId && String(params.contactUserId) !== String(params.telegramId)) {
    return {
      status: 'REJECTED_NOT_OWN',
      text: '⚠️ Ese contacto no es tuyo. Comparte <b>tu propio número</b> con el botón del teclado.',
    };
  }

  const phone = normalizePhone(params.phoneNumber);
  if (!phone) {
    return { status: 'PENDING', text: '⚠️ No pudimos leer tu número. Intenta de nuevo, por favor.' };
  }

  // ¿Ya hay un usuario con ese telefono?
  const existing = await prisma.user.findUnique({ where: { phone } });
  if (existing) {
    if (existing.telegramId && existing.telegramId !== params.telegramId) {
      return {
        status: 'ALREADY_LINKED',
        text:
          '⚠️ Ese número ya está vinculado a otra cuenta de Telegram.\n' +
          'Si es un error, pide a un administrador que lo desvincule desde el panel.',
      };
    }
    if (!existing.isActive) {
      return { status: 'PENDING', text: '⚠️ Tu cuenta está desactivada. Contacta al administrador.' };
    }
    await prisma.user.update({
      where: { id: existing.id },
      data: {
        telegramId: params.telegramId,
        telegramUsername: params.telegramUsername ?? null,
        telegramLinkedAt: new Date(),
        phoneVerifiedAt: new Date(),
        telegramLinkCode: null,
        telegramLinkExp: null,
      },
    });
    await prisma.botContact.upsert({
      where: { telegramId: params.telegramId },
      create: {
        telegramId: params.telegramId,
        phone,
        firstName: params.firstName ?? null,
        lastName: params.lastName ?? null,
        username: params.telegramUsername ?? null,
        status: 'LINKED',
        userId: existing.id,
      },
      update: { status: 'LINKED', userId: existing.id, phone },
    });

    return {
      status: 'LINKED',
      userId: existing.id,
      text:
        `✅ <b>Listo, ${escapeName(existing.fullName)}</b>\n` +
        `Tu Telegram quedó vinculado con el número ${formatPhone(phone)}.\n\n` +
        'Ya puedes:\n' +
        '• Enviar <b>notas de voz</b> para registrar tu tiempo\n' +
        '• Entrar al panel web con <b>Teléfono + código</b>\n\n' +
        'Escribe /ayuda para ver ejemplos.',
    };
  }

  // No existe la cuenta: queda como solicitud de acceso.
  await prisma.botContact.upsert({
    where: { telegramId: params.telegramId },
    create: {
      telegramId: params.telegramId,
      phone,
      firstName: params.firstName ?? null,
      lastName: params.lastName ?? null,
      username: params.telegramUsername ?? null,
      status: 'PENDING',
    },
    update: {
      phone,
      firstName: params.firstName ?? null,
      lastName: params.lastName ?? null,
      username: params.telegramUsername ?? null,
      status: 'PENDING',
    },
  });

  return {
    status: 'PENDING',
    text:
      '📨 <b>Solicitud enviada</b>\n' +
      `Registramos tu número ${formatPhone(phone)}.\n\n` +
      'Un administrador debe crear tu cuenta en el panel. En cuanto lo haga, este número quedará vinculado automáticamente y podrás usar el bot.',
  };
}

const escapeName = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Boton persistente "Compartir mi numero" (solo funciona en ReplyKeyboard). */
export const shareContactKeyboard = (): ReplyMarkup => ({
  keyboard: [[{ text: '📱 Compartir mi número', request_contact: true }]],
  resize_keyboard: true,
  is_persistent: true,
});

export { sendMessage };
