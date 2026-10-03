/**
 * Cliente HTTP del panel.
 *  - Guarda los tokens en localStorage.
 *  - Renueva el access token automaticamente al recibir 401 (una sola vez por request).
 *  - Serializa querystrings y errores de la API.
 */

const ACCESS_KEY = 'ttt.access';
const REFRESH_KEY = 'ttt.refresh';
const USER_KEY = 'ttt.user';

export interface ApiError extends Error {
  status: number;
  code?: string;
}

export const tokens = {
  get access(): string | null {
    return localStorage.getItem(ACCESS_KEY);
  },
  get refresh(): string | null {
    return localStorage.getItem(REFRESH_KEY);
  },
  save(data: { accessToken: string; refreshToken: string; user?: unknown }): void {
    localStorage.setItem(ACCESS_KEY, data.accessToken);
    localStorage.setItem(REFRESH_KEY, data.refreshToken);
    if (data.user) localStorage.setItem(USER_KEY, JSON.stringify(data.user));
  },
  saveUser(user: unknown): void {
    localStorage.setItem(USER_KEY, JSON.stringify(user));
  },
  get cachedUser(): any | null {
    const raw = localStorage.getItem(USER_KEY);
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  },
  clear(): void {
    localStorage.removeItem(ACCESS_KEY);
    localStorage.removeItem(REFRESH_KEY);
    localStorage.removeItem(USER_KEY);
  },
};

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

interface RequestOptions {
  query?: Record<string, string | number | boolean | undefined | null>;
  body?: unknown;
  /** No intentar refrescar el token (usado por el propio /refresh). */
  skipRefresh?: boolean;
  raw?: boolean;
}

function buildUrl(path: string, query?: RequestOptions['query']): string {
  const url = new URL(path.startsWith('http') ? path : `/api${path}`, window.location.origin);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null || value === '') continue;
      url.searchParams.set(key, String(value));
    }
  }
  return `${url.pathname}${url.search}`;
}

let refreshing: Promise<boolean> | null = null;

async function tryRefresh(): Promise<boolean> {
  if (refreshing) return refreshing;
  const refreshToken = tokens.refresh;
  if (!refreshToken) return false;

  refreshing = (async () => {
    try {
      const res = await fetch('/api/auth/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken }),
      });
      if (!res.ok) return false;
      const data = await res.json();
      tokens.save({ accessToken: data.accessToken, refreshToken: data.refreshToken, user: data.user });
      return true;
    } catch {
      return false;
    } finally {
      // Se libera en el siguiente tick para que las peticiones en cola compartan el resultado.
      setTimeout(() => {
        refreshing = null;
      }, 0);
    }
  })();

  return refreshing;
}

export const onUnauthorized = { handler: null as null | (() => void) };

async function request<T>(method: Method, path: string, options: RequestOptions = {}): Promise<T> {
  const doFetch = async (): Promise<Response> =>
    fetch(buildUrl(path, options.query), {
      method,
      headers: {
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        ...(tokens.access ? { Authorization: `Bearer ${tokens.access}` } : {}),
      },
      ...(options.body ? { body: JSON.stringify(options.body) } : {}),
    });

  let res = await doFetch();

  if (res.status === 401 && !options.skipRefresh) {
    const ok = await tryRefresh();
    if (ok) res = await doFetch();
  }

  if (res.status === 401 && !path.startsWith('/auth/login')) {
    tokens.clear();
    onUnauthorized.handler?.();
  }

  if (!res.ok) {
    let message = `Error ${res.status}`;
    let code: string | undefined;
    try {
      const data = await res.json();
      message = data.error ?? data.message ?? message;
      code = data.code;
    } catch {
      /* respuesta sin JSON */
    }
    const error = new Error(message) as ApiError;
    error.status = res.status;
    error.code = code;
    throw error;
  }

  if (res.status === 204) return undefined as T;
  const contentType = res.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json')) return (await res.text()) as unknown as T;
  return (await res.json()) as T;
}

export const api = {
  get: <T>(path: string, query?: RequestOptions['query']) => request<T>('GET', path, { query }),
  post: <T>(path: string, body?: unknown, query?: RequestOptions['query']) => request<T>('POST', path, { body, query }),
  put: <T>(path: string, body?: unknown) => request<T>('PUT', path, { body }),
  patch: <T>(path: string, body?: unknown) => request<T>('PATCH', path, { body }),
  delete: <T>(path: string, query?: RequestOptions['query']) => request<T>('DELETE', path, { query }),
  refresh: tryRefresh,
};

/** Descarga un archivo (export CSV) respetando el token. */
export async function downloadFile(path: string, filename: string, query?: RequestOptions['query']): Promise<void> {
  const res = await fetch(buildUrl(path, query), {
    headers: tokens.access ? { Authorization: `Bearer ${tokens.access}` } : {},
  });
  if (!res.ok) throw new Error(`No se pudo descargar (${res.status})`);
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}
