/**
 * Helpers de navegador para el acceso con Telegram, siguiendo la lógica de
 * NosotrosConstruimos:
 *
 *  - Telegram OAuth devuelve los datos en el hash (`#tgAuthResult=...`), que
 *    NUNCA llega al servidor. Por eso el navegador lo lee y lo reenvía.
 *  - `origin` debe ser el del navegador: `0.0.0.0` es una dirección de escucha,
 *    no un host válido, y en local hay que quedarse en http (Telegram solo
 *    permite http para localhost).
 *  - El hash de Telegram no se interpreta aquí: se reenvía tal cual al backend,
 *    que es quien verifica la firma (una sola implementación de la verdad).
 */

export interface TelegramAuthUser {
  id: number;
  first_name?: string;
  last_name?: string;
  username?: string;
  photo_url?: string;
  auth_date: number;
  hash: string;
}

/** Origen de navegador que Telegram acepta (local y producción). */
export function getTelegramAuthOrigin(): string {
  const url = new URL(window.location.href);

  if (url.hostname === '0.0.0.0' || url.hostname === '[::]' || url.hostname === '::') {
    url.hostname = 'localhost';
  }
  if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') {
    url.protocol = 'http:';
  }
  return url.origin;
}

/** ¿Estamos dentro del navegador interno de Telegram? */
export function isTelegramWebView(userAgent: string = navigator.userAgent): boolean {
  return /Telegram/i.test(userAgent);
}

/** ¿El hash de la URL trae el resultado de Telegram? */
export function hasTelegramAuthHash(hash: string = window.location.hash): boolean {
  return hash.includes('tgAuthResult=') || (hash.includes('auth_date=') && hash.includes('hash='));
}

/**
 * Parsea `#tgAuthResult=<base64(JSON)>` solo para uso de UI (por ejemplo mostrar
 * el nombre), nunca para decidir el acceso: la validación es del servidor.
 */
export function parseTgAuthResultFromHash(hash: string): TelegramAuthUser | null {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  if (!raw) return null;

  const fromObject = (value: unknown): TelegramAuthUser | null => {
    if (!value || typeof value !== 'object') return null;
    const data = value as Record<string, unknown>;
    const id = Number(data.id);
    const authDate = Number(data.auth_date);
    const hashValue = typeof data.hash === 'string' ? data.hash : '';
    if (!Number.isFinite(id) || !Number.isFinite(authDate) || !hashValue) return null;
    return {
      id,
      auth_date: authDate,
      hash: hashValue,
      first_name: typeof data.first_name === 'string' ? data.first_name : undefined,
      last_name: typeof data.last_name === 'string' ? data.last_name : undefined,
      username: typeof data.username === 'string' ? data.username : undefined,
      photo_url: typeof data.photo_url === 'string' ? data.photo_url : undefined,
    };
  };

  if (raw.startsWith('tgAuthResult=')) {
    const encoded = raw.slice('tgAuthResult='.length);
    try {
      return fromObject(JSON.parse(atob(decodeURIComponent(encoded))));
    } catch {
      try {
        return fromObject(JSON.parse(decodeURIComponent(encoded)));
      } catch {
        return null;
      }
    }
  }

  if (raw.includes('id=') && raw.includes('hash=')) {
    const params = new URLSearchParams(raw);
    return fromObject(Object.fromEntries(params.entries()));
  }

  return null;
}

/**
 * URL de autorización de Telegram OAuth.
 * Se construye con el `bot_id` público (prefijo del token) y se vuelve a la
 * página de callback. No se añade `next` a `return_to` porque Telegram suele
 * eliminar los query strings y el destino se conserva en sessionStorage.
 */
export function buildTelegramOAuthUrl(botId: string, origin: string, callbackPath = '/login/telegram/callback'): string {
  const returnTo = new URL(callbackPath, origin);
  const url = new URL('https://oauth.telegram.org/auth');
  url.searchParams.set('bot_id', botId);
  url.searchParams.set('origin', origin);
  url.searchParams.set('request_access', 'write');
  url.searchParams.set('return_to', returnTo.toString());
  return url.toString();
}

/** Guarda a dónde volver tras el login (Telegram pierde los query strings). */
const NEXT_KEY = 'ttt.login.next';

export function persistLoginNext(path: string): void {
  try {
    sessionStorage.setItem(NEXT_KEY, sanitizeNext(path));
  } catch {
    /* almacenamiento no disponible */
  }
}

export function readPersistedLoginNext(): string | null {
  try {
    const value = sessionStorage.getItem(NEXT_KEY);
    return value ? sanitizeNext(value) : null;
  } catch {
    return null;
  }
}

export function clearPersistedLoginNext(): void {
  try {
    sessionStorage.removeItem(NEXT_KEY);
  } catch {
    /* ignorar */
  }
}

/** Evita redirecciones abiertas: solo rutas internas. */
export function sanitizeNext(path: string | null | undefined): string {
  if (!path) return '/';
  if (!path.startsWith('/') || path.startsWith('//')) return '/';
  return path.split('?')[0]!.split('#')[0] || '/';
}
