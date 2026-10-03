import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { env } from '../config/env';
import { getSetting, SETTING_KEYS } from './settings.service';
import { prisma } from '../db/prisma';

/**
 * Telegram Login — flujo OIDC oficial (2025).
 *
 * Telegram ARCHIVÓ el widget iframe antiguo (`telegram-widget.js`, con firma
 * HMAC-SHA256 del bot token y `/setdomain`). Lo vigente es:
 *
 *   - Librería `telegram-login.js` (popup) → devuelve un **id_token** (JWT).
 *   - O bien OIDC manual: Authorization Code Flow + PKCE contra
 *     `/auth` y `/token`, con Client ID + Client Secret de BotFather.
 *
 * En ambos casos el id_token se firma con **RS256** y se verifica contra las
 * claves públicas de JWKS. Aquí se implementa esa verificación:
 *
 *   1. Descargar y cachear el JWKS de https://oauth.telegram.org/.well-known/jwks.json
 *   2. Comprobar la firma con la clave cuyo `kid` coincide.
 *   3. Validar `iss` (https://oauth.telegram.org), `aud` (Client ID) y `exp`.
 *
 * Referencia: https://core.telegram.org/bots/telegram-login
 */

const JWKS_URL = 'https://oauth.telegram.org/.well-known/jwks.json';
const ISSUER = 'https://oauth.telegram.org';
const AUTH_ENDPOINT = 'https://oauth.telegram.org/auth';
const TOKEN_ENDPOINT = 'https://oauth.telegram.org/token';

/** Claims del id_token de Telegram. */
export interface TelegramIdTokenClaims {
  iss: string;
  aud: string;
  sub: string;
  iat: number;
  exp: number;
  /** Id numérico del usuario de Telegram (equivale al antiguo `id`). */
  id?: number;
  name?: string;
  given_name?: string;
  family_name?: string;
  preferred_username?: string;
  picture?: string;
  phone_number?: string;
  phone_number_verified?: boolean;
}

interface Jwk {
  kid: string;
  kty: string;
  use?: string;
  alg?: string;
  n?: string;
  e?: string;
  crv?: string;
  x?: string;
  y?: string;
}

// ---------------------------------------------------------------------------
// Configuración (BotFather → Login Widget → Client ID / Secret)
// ---------------------------------------------------------------------------
export interface OidcConfig {
  clientId: string | null;
  clientSecret: string | null;
  /** Client ID efectivo: el configurado o, como respaldo, el id del bot. */
  effectiveClientId: string | null;
  /** true si el Client ID viene de BotFather (no del token del bot). */
  clientIdFromBotFather: boolean;
  configured: boolean;
}

/**
 * URL de retorno que Telegram exige tener registrada.
 *
 * La libreria `telegram-login.js` usa `response_type=post_message` y manda como
 * `redirect_uri` la pagina donde vive el boton. Si esa URL no esta en la lista
 * de **Allowed URLs** del Login Widget en BotFather, Telegram responde
 * "redirect_uri required" y el popup no llega a abrirse.
 */
export function webLoginRedirectUri(publicUrl?: string | null): string {
  const base = (publicUrl || env.PUBLIC_URL || '').replace(/\/$/, '');
  return `${base}/login`;
}

export function oidcConfig(): OidcConfig {
  const clientId = (getSetting(SETTING_KEYS.TELEGRAM_LOGIN_CLIENT_ID, env.TELEGRAM_LOGIN_CLIENT_ID) || '').trim();
  const clientSecret = (getSetting(SETTING_KEYS.TELEGRAM_LOGIN_CLIENT_SECRET, env.TELEGRAM_LOGIN_CLIENT_SECRET) || '').trim();
  // El Client ID de BotFather suele coincidir con el id del bot; si no se ha
  // configurado, se usa el prefijo del token como respaldo razonable.
  const fallbackId = (env.TELEGRAM_BOT_TOKEN || '').split(':')[0] ?? '';
  const effectiveClientId = clientId || (/^\d+$/.test(fallbackId) ? fallbackId : null);
  return {
    clientId: clientId || null,
    clientSecret: clientSecret || null,
    effectiveClientId,
    clientIdFromBotFather: Boolean(clientId),
    configured: Boolean(effectiveClientId && clientSecret),
  };
}

// ---------------------------------------------------------------------------
// JWKS con cache
// ---------------------------------------------------------------------------
let jwksCache: { keys: Jwk[]; at: number } | null = null;
const JWKS_TTL_MS = 10 * 60 * 1000;

export function invalidateJwksCache(): void {
  jwksCache = null;
}

async function getJwks(force = false): Promise<Jwk[]> {
  if (!force && jwksCache && Date.now() - jwksCache.at < JWKS_TTL_MS) return jwksCache.keys;
  const res = await fetch(JWKS_URL, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`No se pudo obtener el JWKS de Telegram (HTTP ${res.status})`);
  const json = (await res.json()) as { keys?: Jwk[] };
  const keys = json.keys ?? [];
  if (!keys.length) throw new Error('El JWKS de Telegram llegó vacío');
  jwksCache = { keys, at: Date.now() };
  return keys;
}

/** Convierte una JWK RSA en clave pública PEM (sin dependencias externas). */
function jwkToPem(jwk: Jwk): string {
  if (jwk.kty !== 'RSA' || !jwk.n || !jwk.e) {
    throw new Error(`Tipo de clave no soportado: ${jwk.kty} (se espera RSA para RS256)`);
  }
  return crypto.createPublicKey({ key: { kty: 'RSA', n: jwk.n, e: jwk.e }, format: 'jwk' }).export({
    type: 'spki',
    format: 'pem',
  }) as string;
}

// ---------------------------------------------------------------------------
// Verificación del id_token
// ---------------------------------------------------------------------------
export type IdTokenResult =
  | { ok: true; claims: TelegramIdTokenClaims }
  | { ok: false; error: string; code: string };

export interface VerifyOptions {
  /** nonce esperado (si se envió al abrir el popup). */
  nonce?: string;
  /** Tiempo de tolerancia de reloj en segundos. */
  clockToleranceSec?: number;
}

export async function verifyTelegramIdToken(token: string, options: VerifyOptions = {}): Promise<IdTokenResult> {
  const config = oidcConfig();
  const audience = config.effectiveClientId;

  if (!token || typeof token !== 'string') {
    return { ok: false, error: 'No recibimos el id_token de Telegram.', code: 'ID_TOKEN_MISSING' };
  }
  if (!audience) {
    return {
      ok: false,
      error: 'Falta el Client ID de Telegram Login (BotFather → Login Widget).',
      code: 'OIDC_NOT_CONFIGURED',
    };
  }

  const decoded = jwt.decode(token, { complete: true });
  if (!decoded || typeof decoded === 'string' || !decoded.header) {
    return { ok: false, error: 'El id_token no tiene el formato esperado.', code: 'ID_TOKEN_MALFORMED' };
  }

  const kid = decoded.header.kid;
  const alg = decoded.header.alg;
  if (alg !== 'RS256') {
    // Telegram firma con RS256 por defecto; otros algoritmos requieren otra
    // verificacion (ES256/EdDSA) que aqui no se implementa.
    return { ok: false, error: `Algoritmo de firma no soportado: ${alg}`, code: 'ID_TOKEN_ALG' };
  }

  try {
    let keys = await getJwks();
    let jwk = kid ? keys.find((k) => k.kid === kid) : undefined;
    if (!jwk) {
      // La clave puede haberse rotado: se refresca el JWKS una vez.
      keys = await getJwks(true);
      jwk = kid ? keys.find((k) => k.kid === kid) : keys[0];
      if (!jwk) return { ok: false, error: 'No se encontró la clave de firma en el JWKS.', code: 'ID_TOKEN_NO_KEY' };
    }

    const claims = jwt.verify(token, jwkToPem(jwk), {
      algorithms: ['RS256'],
      issuer: ISSUER,
      audience,
      clockTolerance: options.clockToleranceSec ?? 60,
    }) as TelegramIdTokenClaims;

    if (options.nonce && (claims as unknown as { nonce?: string }).nonce !== options.nonce) {
      return { ok: false, error: 'El nonce no coincide (posible replay).', code: 'ID_TOKEN_NONCE' };
    }

    return { ok: true, claims };
  } catch (err) {
    if (err instanceof jwt.TokenExpiredError) {
      return { ok: false, error: 'La sesión de Telegram expiró. Intenta de nuevo.', code: 'ID_TOKEN_EXPIRED' };
    }
    if (err instanceof jwt.JsonWebTokenError) {
      return { ok: false, error: 'No pudimos validar la firma de Telegram.', code: 'ID_TOKEN_INVALID' };
    }
    return { ok: false, error: (err as Error).message, code: 'ID_TOKEN_ERROR' };
  }
}

// ---------------------------------------------------------------------------
// Resolución del usuario a partir de los claims
// ---------------------------------------------------------------------------
export interface OidcLoginOutcome {
  ok: boolean;
  status: number;
  error?: string;
  code?: string;
  user?: any;
  claims?: TelegramIdTokenClaims;
}

export async function resolveUserFromClaims(claims: TelegramIdTokenClaims): Promise<OidcLoginOutcome> {
  // `id` es el id numérico del usuario; `sub` es el identificador del sujeto.
  const telegramId = String(claims.id ?? claims.sub ?? '');
  if (!telegramId) {
    return { ok: false, status: 400, error: 'El id_token no incluye el identificador de usuario.', code: 'ID_TOKEN_NO_SUB' };
  }

  const user = await prisma.user.findFirst({
    where: { telegramId },
    include: { role: true, manager: { select: { fullName: true } } },
  });

  if (!user) {
    return {
      ok: false,
      status: 403,
      error:
        'No hay una cuenta vinculada a ese Telegram. Abre el bot, toca /start y comparte tu teléfono para vincularlo.',
      code: 'TELEGRAM_NOT_LINKED',
    };
  }
  if (!user.isActive) {
    return { ok: false, status: 403, error: 'Tu cuenta está desactivada. Contacta al administrador.', code: 'USER_DISABLED' };
  }

  const patch: Record<string, string | Date> = {};
  if (claims.preferred_username && user.telegramUsername !== claims.preferred_username) {
    patch.telegramUsername = claims.preferred_username;
  }
  if (!user.telegramLinkedAt) patch.telegramLinkedAt = new Date();
  // Si el usuario autorizó compartir el telefono y aun no lo teniamos, se guarda.
  if (claims.phone_number && !user.phone) {
    const normalized = claims.phone_number.startsWith('+') ? claims.phone_number : `+${claims.phone_number}`;
    const taken = await prisma.user.findFirst({ where: { phone: normalized, NOT: { id: user.id } } });
    if (!taken) {
      patch.phone = normalized;
      patch.phoneVerifiedAt = new Date();
    }
  }
  if (Object.keys(patch).length) await prisma.user.update({ where: { id: user.id }, data: patch });

  return { ok: true, status: 200, user, claims };
}

// ---------------------------------------------------------------------------
// OIDC manual (Authorization Code Flow + PKCE) — opcional
// ---------------------------------------------------------------------------
export interface PkcePair {
  verifier: string;
  challenge: string;
  state: string;
}

export function createPkce(): PkcePair {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge, state: crypto.randomBytes(16).toString('base64url') };
}

/** URL de autorización del flujo manual (redirige en el navegador). */
export function buildAuthorizationUrl(params: {
  redirectUri: string;
  state: string;
  codeChallenge: string;
  scopes?: string[];
}): string {
  const config = oidcConfig();
  const url = new URL(AUTH_ENDPOINT);
  url.searchParams.set('client_id', config.effectiveClientId ?? '');
  url.searchParams.set('redirect_uri', params.redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', (params.scopes ?? ['openid', 'profile']).join(' '));
  url.searchParams.set('state', params.state);
  url.searchParams.set('code_challenge', params.codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  return url.toString();
}

/** Canjea el `code` por tokens (requiere Client Secret). */
export async function exchangeCodeForTokens(params: {
  code: string;
  redirectUri: string;
  codeVerifier: string;
}): Promise<{ ok: boolean; idToken?: string; error?: string }> {
  const config = oidcConfig();
  if (!config.effectiveClientId || !config.clientSecret) {
    return { ok: false, error: 'Faltan el Client ID o el Client Secret de Telegram Login.' };
  }

  const basic = Buffer.from(`${config.effectiveClientId}:${config.clientSecret}`).toString('base64');
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: params.code,
    redirect_uri: params.redirectUri,
    client_id: config.effectiveClientId,
    code_verifier: params.codeVerifier,
  });

  try {
    const res = await fetch(TOKEN_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${basic}`,
      },
      body,
    });
    const json = (await res.json().catch(() => ({}))) as { id_token?: string; error?: string; error_description?: string };
    if (!res.ok || !json.id_token) {
      return { ok: false, error: json.error_description ?? json.error ?? `HTTP ${res.status}` };
    }
    return { ok: true, idToken: json.id_token };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

export const telegramOidc = {
  JWKS_URL,
  ISSUER,
  AUTH_ENDPOINT,
  TOKEN_ENDPOINT,
};
