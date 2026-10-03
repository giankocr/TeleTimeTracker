import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { prisma } from '../db/prisma';
import { issueTokens, serializeUser } from '../services/auth.service';
import { normalizeTelegramPayload, resolveTelegramOAuth, type TelegramLoginPayload } from '../services/telegram-auth.service';
import { audit } from '../utils/audit';

/**
 * Endpoint del **widget oficial** de Telegram (data-auth-url).
 *
 * Telegram postea aqui los datos del usuario en `application/x-www-form-urlencoded`
 * (no JSON) y espera una pagina HTML como respuesta: es un formulario enviado
 * dentro de un iframe/popup. Por eso devolvemos HTML que:
 *   1. guarda la sesion en el navegador,
 *   2. avisa a la ventana del panel (postMessage) para que continue el flujo,
 *   3. se cierra sola.
 *
 * Si algo falla, se responde HTML con `window.__TTT_AUTH_ERROR` para mostrar el
 * error en la pantalla de login en lugar de una pagina rota.
 */
export default async function authFormRoutes(app: FastifyInstance): Promise<void> {
  /** Emite la sesion y responde HTML para el iframe del widget. */
  const respondWithSession = async (
    request: FastifyRequest,
    reply: FastifyReply,
    payload: TelegramLoginPayload,
  ): Promise<FastifyReply> => {
    const outcome = await resolveTelegramOAuth(payload);
    if (!outcome.ok || !outcome.user) {
      await audit(request, {
        action: 'auth.telegram_login_failed',
        metadata: { telegramId: String(payload.id), code: outcome.code, reason: outcome.error },
      });
      return reply.type('text/html; charset=utf-8').send(htmlError(outcome.error ?? 'No se pudo validar el login.'));
    }

    const tokens = await issueTokens(app, outcome.user.id, outcome.user.email, {
      userAgent: request.headers['user-agent'],
      ip: request.ip,
    });
    await prisma.user.update({ where: { id: outcome.user.id }, data: { lastLoginAt: new Date() } });
    await audit(request, {
      action: 'auth.login_telegram',
      entity: 'user',
      entityId: outcome.user.id,
      userId: outcome.user.id,
      metadata: { via: 'widget' },
    });

    return reply.type('text/html; charset=utf-8').send(htmlSuccess(tokens, serializeUser(outcome.user)));
  };

  // -------------------------------------------------------------------------
  // POST /api/auth/telegram/widget — el widget oficial envia form-urlencoded
  // -------------------------------------------------------------------------
  app.post('/telegram/widget', async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const payload = normalizeTelegramPayload(body);
    if (!payload) {
      return reply
        .type('text/html; charset=utf-8')
        .send(htmlError('No recibimos los datos de Telegram. Intenta de nuevo.'));
    }
    return respondWithSession(request, reply, payload);
  });

  /** Algunos clientes hacen GET con los parametros en la query. */
  app.get('/telegram/widget', async (request, reply) => {
    const payload = normalizeTelegramPayload((request.query ?? {}) as Record<string, unknown>);
    if (!payload) {
      return reply
        .type('text/html; charset=utf-8')
        .send(htmlError('No recibimos los datos de Telegram. Intenta de nuevo.'));
    }
    return respondWithSession(request, reply, payload);
  });
}

// ---------------------------------------------------------------------------
// Plantillas HTML del iframe (autocontenidas: sin CSS ni JS externos)
// ---------------------------------------------------------------------------
const BASE_STYLE = `
  :root { color-scheme: dark; }
  body { margin:0; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;
         background:#0d1424; color:#e8edf7; display:flex; align-items:center; justify-content:center;
         min-height:100vh; padding:16px; text-align:center; font-size:14px; }
  .box { max-width:320px; }
  .icon { font-size:28px; margin-bottom:10px; }
  .muted { color:#94a3b8; font-size:12px; margin-top:8px; }
  .error { color:#fca5a5; }
`;

const escapeJs = (value: string): string => JSON.stringify(value).replace(/</g, '\\u003c');

function htmlSuccess(tokens: { accessToken: string; refreshToken: string }, user: unknown): string {
  const payload = JSON.stringify({ ...tokens, user }).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><title>Acceso correcto</title><style>${BASE_STYLE}</style></head>
<body><div class="box">
  <div class="icon">✅</div>
  <div><b>Acceso correcto</b></div>
  <div class="muted">Cerrando esta ventana…</div>
</div>
<script>
  (function () {
    var data = ${payload};
    try {
      // El panel escucha este mensaje y guarda la sesion (ver Login.tsx).
      if (window.opener && !window.opener.closed) {
        window.opener.postMessage({ type: 'ttt-telegram-widget-auth', data: data }, window.location.origin);
      }
    } catch (e) {}
    // Respaldo por si el widget se abrio sin opener: se cierra igual.
    setTimeout(function () { try { window.close(); } catch (e) {} }, 400);
  })();
</script>
</body></html>`;
}

function htmlError(message: string): string {
  const safe = message.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><title>No se pudo iniciar sesión</title><style>${BASE_STYLE}</style></head>
<body><div class="box">
  <div class="icon">⚠️</div>
  <div class="error">${safe}</div>
  <div class="muted">Puedes cerrar esta ventana e intentarlo de nuevo.</div>
</div>
<script>
  (function () {
    try {
      if (window.opener && !window.opener.closed) {
        window.opener.postMessage({ type: 'ttt-telegram-widget-auth', error: ${escapeJs(message)} }, window.location.origin);
      }
    } catch (e) {}
  })();
</script>
</body></html>`;
}
