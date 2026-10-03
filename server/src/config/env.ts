import path from 'node:path';
import fs from 'node:fs';
import dotenv from 'dotenv';

dotenv.config();

const bool = (v: string | undefined, def = false): boolean =>
  v === undefined ? def : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());

const int = (v: string | undefined, def: number): number => {
  const n = Number.parseInt(v ?? '', 10);
  return Number.isFinite(n) ? n : def;
};

const list = (v: string | undefined, def: string[] = []): string[] =>
  (v ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .concat(v ? [] : def);

/**
 * Directorio de datos persistente (volumen Docker: /app/data).
 *
 * El mkdir NUNCA debe tumbar el proceso: si el volumen no esta montado o no es
 * escribible queremos que el servidor arranque y lo diga por el log, no un
 * stack trace de una linea que oculta el problema real.
 */
const configuredDataDir = process.env.DATA_DIR || path.join(process.cwd(), 'data');
export const DATA_DIR = path.resolve(configuredDataDir);

export const dataDirStatus: { writable: boolean; error: string | null; configured: string } = {
  writable: false,
  error: null,
  configured: configuredDataDir,
};

try {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  // Comprobacion real de escritura (un volumen puede existir y ser de solo lectura).
  fs.accessSync(DATA_DIR, fs.constants.W_OK);
  dataDirStatus.writable = true;
} catch (err) {
  dataDirStatus.error = (err as NodeJS.ErrnoException).code ?? (err as Error).message;
  console.error('─'.repeat(64));
  console.error('❌ El directorio de datos no es escribible:', DATA_DIR);
  console.error(`   Causa: ${dataDirStatus.error}`);
  console.error('   En EasyPanel: monta un volumen persistente con Mount Path = /app/data');
  console.error('   y define DATA_DIR=/app/data. El panel intentara arrancar en modo degradado.');
  console.error('─'.repeat(64));
}

/** Ruta del archivo SQLite dentro del volumen. */
export const SQLITE_FILE = path.join(DATA_DIR, 'teletimetracker.db');

/**
 * DATABASE_URL admite:
 *  - postgresql://... / mysql://...  -> se usa tal cual
 *  - file:/abs/path.db               -> ruta absoluta al archivo SQLite
 *  - file:./loquesea.db (relativa)   -> se reescribe a DATA_DIR/loquesea.db
 *  - vacio                           -> DATA_DIR/teletimetracker.db
 */
export const resolveDatabaseUrl = (raw: string | undefined): string => {
  if (!raw) return `file:${SQLITE_FILE}`;
  if (!raw.startsWith('file:')) return raw;
  const filePath = raw.slice('file:'.length);
  if (path.isAbsolute(filePath)) return raw;
  const name = path.basename(filePath);
  return `file:${path.join(DATA_DIR, name)}`;
};

const resolvedDbUrl = resolveDatabaseUrl(process.env.DATABASE_URL);

// Se normaliza en process.env para que los procesos hijos (prisma CLI, seed)
// usen exactamente la misma base de datos que el servidor.
process.env.DATABASE_URL = resolvedDbUrl;
process.env.DATA_DIR = DATA_DIR;

export const env = {
  NODE_ENV: process.env.NODE_ENV ?? 'development',
  isProd: (process.env.NODE_ENV ?? 'development') === 'production',
  HOST: process.env.HOST ?? '0.0.0.0',
  PORT: int(process.env.PORT, 8080),

  // --- Base de datos ---
  DATABASE_URL: resolvedDbUrl,
  DATA_DIR,
  SQLITE_FILE,
  /** Si es true, al arrancar se aplican migraciones y el seed automaticamente. */
  AUTO_MIGRATE: bool(process.env.AUTO_MIGRATE, true),
  AUTO_SEED: bool(process.env.AUTO_SEED, true),

  // --- Seguridad ---
  JWT_SECRET: process.env.JWT_SECRET ?? 'cambia-esto-en-produccion-por-un-secreto-largo',
  JWT_EXPIRES_IN: process.env.JWT_EXPIRES_IN ?? '12h',
  REFRESH_EXPIRES_DAYS: int(process.env.REFRESH_EXPIRES_DAYS, 30),
  /** Clave (32 bytes hex/base64) para cifrar secretos en la tabla system_settings. */
  SETTINGS_ENC_KEY: process.env.SETTINGS_ENC_KEY ?? '',
  CORS_ORIGINS: list(process.env.CORS_ORIGINS, ['*']),
  COOKIE_SECURE: bool(process.env.COOKIE_SECURE, false),

  // --- Bootstrap del admin inicial ---
  ADMIN_EMAIL: process.env.ADMIN_EMAIL ?? 'admin@teletimetracker.local',
  ADMIN_PASSWORD: process.env.ADMIN_PASSWORD ?? 'Admin123!',
  ADMIN_NAME: process.env.ADMIN_NAME ?? 'Administrador',

  // --- Telegram ---
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN ?? '',
  // Telegram Login (BotFather -> Login Widget). Requerido por el flujo OIDC:
  // el id_token se valida contra estos valores (aud = Client ID).
  TELEGRAM_LOGIN_CLIENT_ID: process.env.TELEGRAM_LOGIN_CLIENT_ID ?? '',
  TELEGRAM_LOGIN_CLIENT_SECRET: process.env.TELEGRAM_LOGIN_CLIENT_SECRET ?? '',
  TELEGRAM_MODE: (process.env.TELEGRAM_MODE ?? 'webhook') as 'webhook' | 'polling' | 'off',
  TELEGRAM_WEBHOOK_SECRET: process.env.TELEGRAM_WEBHOOK_SECRET ?? '',
  /** URL publica del panel, p.ej. https://tiempo.midominio.com (para setWebhook) */
  PUBLIC_URL: (process.env.PUBLIC_URL ?? '').replace(/\/$/, ''),

  // --- IA: transcripcion de voz y NLU ---
  //
  // Hay dos proveedores posibles y se elige automaticamente:
  //  1. Groq (si hay GROQ_API_KEY)  -> whisper-large-v3 + llama, muy rapido y barato
  //  2. OpenAI (si hay OPENAI_API_KEY) -> whisper-1 + gpt-4o-mini
  // El SDK es el mismo porque Groq expone una API compatible con OpenAI.
  GROQ_API_KEY: process.env.GROQ_API_KEY ?? '',
  GROQ_BASE_URL: (process.env.GROQ_BASE_URL ?? 'https://api.groq.com/openai/v1').replace(/\/$/, ''),
  GROQ_WHISPER_MODEL: process.env.GROQ_WHISPER_MODEL ?? 'whisper-large-v3',
  GROQ_LLM_MODEL: process.env.GROQ_LLM_MODEL ?? 'llama-3.1-8b-instant',

  OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? '',
  WHISPER_MODEL: process.env.WHISPER_MODEL ?? 'whisper-1',
  NLU_MODEL: process.env.NLU_MODEL ?? 'gpt-4o-mini',
  NLU_ENABLED: bool(process.env.NLU_ENABLED, true),

  // --- GitHub ---
  GITHUB_TOKEN: process.env.GITHUB_TOKEN ?? '',
  GITHUB_ENRICH: bool(process.env.GITHUB_ENRICH, true),

  // --- Alertas ---
  ALERTS_ENABLED: bool(process.env.ALERTS_ENABLED, true),
  ALERT_CRON: process.env.ALERT_CRON ?? '* * * * *',
  DIGEST_CRON: process.env.DIGEST_CRON ?? '0 8 * * 1-5',
  DEFAULT_TIMEZONE: process.env.DEFAULT_TIMEZONE ?? 'America/Bogota',

  LOG_LEVEL: process.env.LOG_LEVEL ?? 'info',
};

export type AppEnv = typeof env;

/**
 * Persiste el archivo de settings dinamicos (tokens guardados desde el panel)
 * sobre las variables de entorno, para que el bot use los valores de la BD.
 */
export const runtimeOverrides: Record<string, string> = {};

export function effective(key: keyof AppEnv): any {
  return runtimeOverrides[key as string] ?? env[key];
}

/** Token de Telegram efectivo: panel (BD) tiene prioridad sobre .env */
export const telegramToken = (): string =>
  runtimeOverrides.TELEGRAM_BOT_TOKEN || env.TELEGRAM_BOT_TOKEN;
export const openaiKey = (): string => runtimeOverrides.OPENAI_API_KEY || env.OPENAI_API_KEY;
export const groqKey = (): string => runtimeOverrides.GROQ_API_KEY || env.GROQ_API_KEY;
export const githubToken = (): string => runtimeOverrides.GITHUB_TOKEN || env.GITHUB_TOKEN;
