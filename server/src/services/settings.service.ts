import { prisma } from '../db/prisma';
import { decryptSecret, encryptSecret, maskSecret } from '../config/crypto';
import { env, runtimeOverrides } from '../config/env';

/**
 * Configuracion dinamica del sistema.
 *
 * Prioridad: SystemSetting (BD, editable desde el panel) > variable de entorno.
 * Los secretos se guardan cifrados con AES-256-GCM.
 */

export const SETTING_KEYS = {
  TELEGRAM_BOT_TOKEN: 'telegram.bot_token',
  TELEGRAM_WEBHOOK_SECRET: 'telegram.webhook_secret',
  OPENAI_API_KEY: 'openai.api_key',
  GROQ_API_KEY: 'groq.api_key',
  GROQ_WHISPER_MODEL: 'groq.whisper_model',
  GROQ_LLM_MODEL: 'groq.llm_model',
  GITHUB_TOKEN: 'github.token',
  GITHUB_ENRICH: 'github.enrich_enabled',
  WHISPER_MODEL: 'openai.whisper_model',
  NLU_MODEL: 'openai.nlu_model',
  NLU_ENABLED: 'openai.nlu_enabled',
  ALERTS_ENABLED: 'alerts.enabled',
  IDLE_ALERT_MIN: 'alerts.idle_minutes',
  DIGEST_CRON: 'alerts.digest_cron',
  WORK_DAYS: 'work.default_days',
  WORK_START: 'work.default_start',
  WORK_END: 'work.default_end',
  TIMEZONE: 'work.default_timezone',
  COMPANY_NAME: 'ui.company_name',
  /**
   * 'oidc'  -> libreria oficial telegram-login.js (popup) + id_token  [RECOMENDADO]
   * 'widget'-> widget iframe legacy (HMAC + /setdomain)  [en desuso]
   * 'oauth' -> redireccion oauth.telegram.org sin OIDC  [en desuso]
   */
  TELEGRAM_LOGIN_MODE: 'telegram.login_mode',
  /** Permite el borrado definitivo de registros de tiempo (solo con entries:delete). */
  ENTRIES_ALLOW_HARD_DELETE: 'entries.allow_hard_delete',
  TELEGRAM_LOGIN_CLIENT_ID: 'telegram.login_client_id',
  TELEGRAM_LOGIN_CLIENT_SECRET: 'telegram.login_client_secret',
  WELCOME_MESSAGE: 'bot.welcome_message',
} as const;

export type SettingKey = (typeof SETTING_KEYS)[keyof typeof SETTING_KEYS];

const SECRET_KEYS: string[] = [
  SETTING_KEYS.TELEGRAM_BOT_TOKEN,
  SETTING_KEYS.TELEGRAM_WEBHOOK_SECRET,
  SETTING_KEYS.TELEGRAM_LOGIN_CLIENT_SECRET,
  SETTING_KEYS.OPENAI_API_KEY,
  SETTING_KEYS.GROQ_API_KEY,
  SETTING_KEYS.GITHUB_TOKEN,
];

const DEFAULTS: Record<string, string> = {
  [SETTING_KEYS.GITHUB_ENRICH]: env.GITHUB_ENRICH ? 'true' : 'false',
  [SETTING_KEYS.WHISPER_MODEL]: env.WHISPER_MODEL,
  [SETTING_KEYS.GROQ_WHISPER_MODEL]: env.GROQ_WHISPER_MODEL,
  [SETTING_KEYS.GROQ_LLM_MODEL]: env.GROQ_LLM_MODEL,
  [SETTING_KEYS.NLU_MODEL]: env.NLU_MODEL,
  [SETTING_KEYS.NLU_ENABLED]: env.NLU_ENABLED ? 'true' : 'false',
  [SETTING_KEYS.ALERTS_ENABLED]: env.ALERTS_ENABLED ? 'true' : 'false',
  [SETTING_KEYS.IDLE_ALERT_MIN]: '45',
  [SETTING_KEYS.DIGEST_CRON]: env.DIGEST_CRON,
  [SETTING_KEYS.WORK_DAYS]: '1,2,3,4,5',
  [SETTING_KEYS.WORK_START]: '09:00',
  [SETTING_KEYS.WORK_END]: '18:00',
  [SETTING_KEYS.TIMEZONE]: env.DEFAULT_TIMEZONE,
  [SETTING_KEYS.COMPANY_NAME]: 'TeleTimeTracker',
  [SETTING_KEYS.TELEGRAM_LOGIN_MODE]: 'oidc',
  [SETTING_KEYS.ENTRIES_ALLOW_HARD_DELETE]: 'true',
  [SETTING_KEYS.WELCOME_MESSAGE]:
    'Hola {name}! Envia una nota de voz o escribe que estas haciendo y empiezo a cronometrar.',
};

/** Mapa de secretos de entorno que sirven como respaldo si la BD esta vacia. */
const ENV_FALLBACK: Record<string, string> = {
  [SETTING_KEYS.TELEGRAM_BOT_TOKEN]: env.TELEGRAM_BOT_TOKEN,
  [SETTING_KEYS.TELEGRAM_WEBHOOK_SECRET]: env.TELEGRAM_WEBHOOK_SECRET,
  [SETTING_KEYS.OPENAI_API_KEY]: env.OPENAI_API_KEY,
  [SETTING_KEYS.GROQ_API_KEY]: env.GROQ_API_KEY,
  [SETTING_KEYS.GITHUB_TOKEN]: env.GITHUB_TOKEN,
};

/** Claves que se exponen al runtime (para que el bot use lo guardado en el panel). */
const RUNTIME_MAP: Record<string, keyof typeof runtimeOverrides> = {
  [SETTING_KEYS.TELEGRAM_BOT_TOKEN]: 'TELEGRAM_BOT_TOKEN',
  [SETTING_KEYS.OPENAI_API_KEY]: 'OPENAI_API_KEY',
  [SETTING_KEYS.GROQ_API_KEY]: 'GROQ_API_KEY',
  [SETTING_KEYS.GITHUB_TOKEN]: 'GITHUB_TOKEN',
};

const cache = new Map<string, string>();

export async function loadSettings(): Promise<void> {
  try {
    const rows = await prisma.systemSetting.findMany();
    cache.clear();
    for (const row of rows) {
      cache.set(row.key, row.isSecret ? decryptSecret(row.value) : row.value);
    }
  } catch (err) {
    // La tabla puede no existir todavia (antes de migrar): se usan defaults.
    console.warn('[settings] no se pudieron cargar de la BD:', (err as Error).message);
  }
  applyRuntimeOverrides();
}

function applyRuntimeOverrides(): void {
  for (const [key, runtimeKey] of Object.entries(RUNTIME_MAP)) {
    const value = cache.get(key) || ENV_FALLBACK[key] || '';
    if (value) runtimeOverrides[runtimeKey] = value;
    else delete runtimeOverrides[runtimeKey];
  }
}

export function getSetting(key: string, fallback?: string): string {
  const fromDb = cache.get(key);
  if (fromDb !== undefined && fromDb !== '') return fromDb;
  if (ENV_FALLBACK[key]) return ENV_FALLBACK[key];
  if (fallback !== undefined) return fallback;
  return DEFAULTS[key] ?? '';
}

export function getSettingBool(key: string, fallback = false): boolean {
  const raw = getSetting(key, fallback ? 'true' : 'false');
  return ['1', 'true', 'yes', 'on'].includes(raw.toLowerCase());
}

export function getSettingInt(key: string, fallback: number): number {
  const n = Number.parseInt(getSetting(key, String(fallback)), 10);
  return Number.isFinite(n) ? n : fallback;
}

export async function setSetting(key: string, value: string): Promise<void> {
  const isSecret = SECRET_KEYS.includes(key);
  const stored = isSecret ? encryptSecret(value) : value;
  await prisma.systemSetting.upsert({
    where: { key },
    create: { key, value: stored, isSecret },
    update: { value: stored, isSecret },
  });
  cache.set(key, value);
  applyRuntimeOverrides();
}

/**
 * Borra un ajuste guardado en la BD.
 * Necesario para que un secreto vuelva a tomar el valor de la variable de
 * entorno: sin borrar la fila, un valor guardado (aunque sea un error de
 * copiado) siempre tendria prioridad sobre el .env.
 */
export async function clearSetting(key: string): Promise<void> {
  await prisma.systemSetting.deleteMany({ where: { key } });
  cache.delete(key);
  applyRuntimeOverrides();
}

export async function setSettings(entries: Record<string, string | undefined | null>): Promise<void> {
  for (const [key, value] of Object.entries(entries)) {
    if (value === undefined || value === null) continue;
    await setSetting(key, String(value));
  }
}

/** Vista para el panel: los secretos van enmascarados. */
export function listSettingsForUI(): Array<{ key: string; value: string; isSecret: boolean; isSet: boolean }> {
  const keys = new Set<string>([...Object.keys(DEFAULTS), ...cache.keys(), ...Object.keys(ENV_FALLBACK)]);
  return [...keys].sort().map((key) => {
    const isSecret = SECRET_KEYS.includes(key);
    const effectiveValue = getSetting(key);
    return {
      key,
      isSecret,
      isSet: Boolean(effectiveValue),
      value: isSecret ? maskSecret(encryptSecret(effectiveValue)) : effectiveValue,
    };
  });
}

export const SECRET_SETTING_KEYS = SECRET_KEYS;
