import crypto from 'node:crypto';
import { env } from './env';

/**
 * Cifrado simetrico AES-256-GCM para secretos guardados en la BD
 * (Telegram Bot Token, OpenAI Key, GitHub Tokens, tokens personales).
 *
 * La clave se deriva de SETTINGS_ENC_KEY; si no existe se usa JWT_SECRET
 * (asi el sistema funciona out-of-the-box, pero en produccion define ambas).
 */
const KEY_SOURCE = env.SETTINGS_ENC_KEY || env.JWT_SECRET;
const KEY = crypto.createHash('sha256').update(KEY_SOURCE).digest(); // 32 bytes

const PREFIX = 'enc:v1:';

export function encryptSecret(plain: string): string {
  if (!plain) return '';
  if (plain.startsWith(PREFIX)) return plain; // ya cifrado
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}${iv.toString('base64url')}.${tag.toString('base64url')}.${enc.toString('base64url')}`;
}

export function decryptSecret(value: string | null | undefined): string {
  if (!value) return '';
  if (!value.startsWith(PREFIX)) return value; // texto plano heredado
  try {
    const [ivB64, tagB64, dataB64] = value.slice(PREFIX.length).split('.');
    if (!ivB64 || !tagB64 || !dataB64) return '';
    const decipher = crypto.createDecipheriv('aes-256-gcm', KEY, Buffer.from(ivB64, 'base64url'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64url')), decipher.final()]).toString('utf8');
  } catch {
    return '';
  }
}

/** Devuelve un preview seguro de un secreto para mostrarlo en el panel. */
export function maskSecret(value: string | null | undefined): string {
  const plain = decryptSecret(value);
  if (!plain) return '';
  if (plain.length <= 8) return '••••••••';
  return `${plain.slice(0, 4)}••••••••${plain.slice(-4)}`;
}

// ---------------------------------------------------------------------------
// Helpers de tokens
// ---------------------------------------------------------------------------
export const randomToken = (bytes = 32): string => crypto.randomBytes(bytes).toString('base64url');

/** Codigo corto tipo "A1B2-C3D4" para vincular Telegram. */
export function generateLinkCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const pick = (n: number) =>
    Array.from({ length: n }, () => alphabet[crypto.randomInt(alphabet.length)]).join('');
  return `${pick(4)}-${pick(4)}`;
}

export const sha256 = (value: string): string => crypto.createHash('sha256').update(value).digest('hex');
