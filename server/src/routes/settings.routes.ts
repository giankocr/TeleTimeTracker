import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../db/prisma';
import { PERMISSIONS } from '../../../shared/types';
import { authenticate, requirePermission } from '../middleware/auth';
import {
  SECRET_SETTING_KEYS,
  SETTING_KEYS,
  clearSetting,
  getSetting,
  listSettingsForUI,
  setSettings,
} from '../services/settings.service';
import { getMe as telegramGetMe, isConfigured as telegramConfigured, setWebhook, getWebhookInfo, deleteWebhook } from '../bot/telegram.api';
import { transcriptionProvider } from '../services/audio.service';
import { audit } from '../utils/audit';
import { env } from '../config/env';

/**
 * Configuracion del sistema: tokens de API, horarios por defecto y estado del bot.
 * Los secretos se guardan cifrados y nunca se devuelven en claro al panel.
 */
export default async function settingsRoutes(app: FastifyInstance): Promise<void> {
  // -------------------------------------------------------------------------
  // GET /api/settings
  // -------------------------------------------------------------------------
  app.get('/', { preHandler: [authenticate] }, async (request, reply) => {
    const auth = request.auth!;
    const canSeeSettings = auth.permissions.includes('*') || auth.permissions.includes(PERMISSIONS.SETTINGS_READ);

    const rows = listSettingsForUI();
    // Un usuario normal solo ve la configuracion no sensible (marca, mensajes).
    const visible = canSeeSettings ? rows : rows.filter((r) => !r.isSecret && r.key === SETTING_KEYS.COMPANY_NAME);

    const [webhook, botInfo] = await Promise.all([
      canSeeSettings ? getWebhookInfo().catch(() => null) : Promise.resolve(null),
      canSeeSettings && telegramConfigured() ? telegramGetMe().catch(() => null) : Promise.resolve(null),
    ]);

    return reply.send({
      settings: visible,
      secretsHidden: !canSeeSettings,
      integration: {
        telegramConfigured: telegramConfigured(),
        telegramMode: env.TELEGRAM_MODE,
        bot: botInfo ? { id: botInfo.id, username: botInfo.username, name: botInfo.first_name } : null,
        webhook: webhook ?? null,
        publicUrl: env.PUBLIC_URL || null,
        telegramLoginMode: getSetting(SETTING_KEYS.TELEGRAM_LOGIN_MODE, 'oidc'),
        loginOidcConfigured: (await import('../services/telegram-oidc.service')).oidcConfig().configured,
        loginClientId: (await import('../services/telegram-oidc.service')).oidcConfig().effectiveClientId,
        loginClientIdFromBotFather: (await import('../services/telegram-oidc.service')).oidcConfig().clientIdFromBotFather,
        webRedirectUri: (await import('../services/telegram-oidc.service')).webLoginRedirectUri(),
        openaiConfigured: Boolean(getSetting(SETTING_KEYS.OPENAI_API_KEY) || env.OPENAI_API_KEY),
        groqConfigured: Boolean(getSetting(SETTING_KEYS.GROQ_API_KEY) || env.GROQ_API_KEY),
        // Proveedor efectivo de voz/NLU (Groq tiene prioridad si hay clave).
        aiProvider: transcriptionProvider().provider,
        transcriptionModel: transcriptionProvider().model,
        githubConfigured: Boolean(getSetting(SETTING_KEYS.GITHUB_TOKEN) || env.GITHUB_TOKEN),
      },
    });
  });

  // -------------------------------------------------------------------------
  // PUT /api/settings — actualizacion parcial (key/value)
  // -------------------------------------------------------------------------
  app.put('/', { preHandler: [requirePermission(PERMISSIONS.SETTINGS_WRITE)] }, async (request, reply) => {
    const parsed = z
      .object({
        settings: z.record(z.string().min(3).max(80), z.union([z.string(), z.number(), z.boolean(), z.null()])),
      })
      .safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'Datos invalidos' });

    const entries: Record<string, string> = {};
    const toClear: string[] = [];
    for (const [key, value] of Object.entries(parsed.data.settings)) {
      // null = "no cambiar" (el panel no toco el campo).
      if (value === null) continue;
      const asString = typeof value === 'boolean' ? String(value) : String(value);
      if (SECRET_SETTING_KEYS.includes(key)) {
        // La mascara (contiene •) significa "dejar como esta".
        if (asString.includes('••••')) continue;
        // Cadena vacia = borrar el valor guardado y volver al del entorno (.env).
        if (asString.trim() === '') {
          toClear.push(key);
          continue;
        }
      }
      entries[key] = asString;
    }

    await setSettings(entries);
    for (const key of toClear) await clearSetting(key);
    await audit(request, {
      action: 'settings.update',
      metadata: Object.keys(entries).map((k) => (SECRET_SETTING_KEYS.includes(k) ? `${k}=***` : k)),
    });

    // Refresca el token del bot en caliente si cambio (y el @username del login widget).
    if (entries[SETTING_KEYS.TELEGRAM_BOT_TOKEN]) {
      const { applyBotTokenFromSettings } = await import('../bot/telegram.controller');
      applyBotTokenFromSettings(entries[SETTING_KEYS.TELEGRAM_BOT_TOKEN]!);
      const { invalidateBotUsernameCache } = await import('../services/telegram-auth.service');
      invalidateBotUsernameCache();
    }

    return reply.send({
      ok: true,
      settings: listSettingsForUI(),
      message: entries[SETTING_KEYS.TELEGRAM_BOT_TOKEN] ? 'Guardado. Reinicia el webhook desde el panel si cambiaste el token.' : 'Configuracion guardada.',
    });
  });

  // -------------------------------------------------------------------------
  // POST /api/settings/ai/test — valida las claves de IA (Groq / OpenAI)
  // Comprueba que la clave responde y QUE MODELOS ofrece, porque un modelo
  // retirado o mal escrito es la causa habitual de que falle la voz.
  // -------------------------------------------------------------------------
  app.post('/ai/test', { preHandler: [requirePermission(PERMISSIONS.SETTINGS_WRITE)] }, async (request, reply) => {
    const { nluProvider } = await import('../services/nlu.service');
    const { groqKey, openaiKey, env: appEnv } = await import('../config/env');

    const check = async (
      provider: 'groq' | 'openai',
      apiKey: string,
      baseUrl: string,
    ): Promise<{ provider: string; ok: boolean; error?: string; keyPreview?: string; models?: string[] }> => {
      const preview = apiKey ? `${apiKey.slice(0, 6)}…${apiKey.slice(-4)} (${apiKey.length} caracteres)` : '';
      try {
        const res = await fetch(`${baseUrl}/models`, { headers: { Authorization: `Bearer ${apiKey}` } });
        if (!res.ok) {
          const body = await res.text().catch(() => '');
          return { provider, ok: false, keyPreview: preview, error: `HTTP ${res.status}: ${body.slice(0, 200)}` };
        }
        const json = (await res.json()) as { data?: Array<{ id: string }> };
        return { provider, ok: true, keyPreview: preview, models: (json.data ?? []).map((m) => m.id).sort() };
      } catch (err) {
        return { provider, ok: false, keyPreview: preview, error: (err as Error).message };
      }
    };

    const active = transcriptionProvider();
    const results: Array<Record<string, unknown>> = [];

    if (groqKey()) {
      results.push({
        ...(await check('groq', groqKey(), appEnv.GROQ_BASE_URL)),
        active: active.provider === 'groq',
        transcriptionModel: getSetting(SETTING_KEYS.GROQ_WHISPER_MODEL, appEnv.GROQ_WHISPER_MODEL),
        chatModel: getSetting(SETTING_KEYS.GROQ_LLM_MODEL, appEnv.GROQ_LLM_MODEL),
      });
    }
    if (openaiKey()) {
      results.push({
        ...(await check('openai', openaiKey(), 'https://api.openai.com/v1')),
        active: active.provider === 'openai',
        transcriptionModel: getSetting(SETTING_KEYS.WHISPER_MODEL, appEnv.WHISPER_MODEL),
        chatModel: getSetting(SETTING_KEYS.NLU_MODEL, appEnv.NLU_MODEL),
      });
    }

    if (!results.length) {
      return reply.code(400).send({
        ok: false,
        error: 'No hay ninguna clave de IA configurada. Pega GROQ_API_KEY (recomendado) y guarda.',
      });
    }

    await audit(request, { action: 'settings.ai_test', metadata: { providers: results.map((r) => r.provider) } });
    return reply.send({
      ok: results.every((r) => r.ok),
      transcriptionProvider: active.provider,
      nluProvider: nluProvider(),
      results,
    });
  });

  // -------------------------------------------------------------------------
  // POST /api/settings/telegram/test — valida el token contra la API
  // -------------------------------------------------------------------------
  app.post('/telegram/test', { preHandler: [requirePermission(PERMISSIONS.SETTINGS_WRITE)] }, async (_request, reply) => {
    if (!telegramConfigured()) return reply.code(400).send({ ok: false, error: 'No hay TELEGRAM_BOT_TOKEN configurado' });
    try {
      const me = await telegramGetMe();
      return reply.send({ ok: true, bot: { id: me.id, username: me.username, name: me.first_name } });
    } catch (err) {
      return reply.code(400).send({ ok: false, error: (err as Error).message });
    }
  });

  // -------------------------------------------------------------------------
  // POST /api/settings/telegram/commands — publica el menu de comandos
  // -------------------------------------------------------------------------
  app.post('/telegram/commands', { preHandler: [requirePermission(PERMISSIONS.BOT_ADMIN)] }, async (request, reply) => {
    const { publishBotCommands, BOT_COMMANDS } = await import('../bot/commands');
    const result = await publishBotCommands();
    await audit(request, { action: 'settings.telegram_publish_commands', metadata: { ok: result.ok } });
    if (!result.ok) return reply.code(400).send({ ok: false, error: result.error });
    return reply.send({ ok: true, commands: BOT_COMMANDS, message: 'Menú de comandos actualizado en Telegram.' });
  });

  // -------------------------------------------------------------------------
  // POST /api/settings/telegram/webhook — registra el webhook en Telegram
  // -----------------------------------------------------------------------
  app.post('/telegram/webhook', { preHandler: [requirePermission(PERMISSIONS.BOT_ADMIN)] }, async (request, reply) => {
    const parsed = z.object({ publicUrl: z.string().url().optional() }).safeParse(request.body ?? {});
    const base = parsed.success && parsed.data.publicUrl ? parsed.data.publicUrl.replace(/\/$/, '') : env.PUBLIC_URL;
    if (!base) {
      return reply.code(400).send({
        error: 'Configura PUBLIC_URL en las variables de entorno (o enviala en el body) para registrar el webhook.',
      });
    }
    const secret = getSetting(SETTING_KEYS.TELEGRAM_WEBHOOK_SECRET, env.TELEGRAM_WEBHOOK_SECRET) || undefined;
    try {
      await setWebhook(`${base}/api/telegram/webhook`, secret);
      const info = await getWebhookInfo();
      await audit(request, { action: 'settings.telegram_set_webhook', metadata: { url: `${base}/api/telegram/webhook` } });
      return reply.send({ ok: true, webhook: info });
    } catch (err) {
      return reply.code(400).send({ ok: false, error: (err as Error).message });
    }
  });

  // -------------------------------------------------------------------------
  // DELETE /api/settings/telegram/webhook — borra el webhook (modo polling)
  // -------------------------------------------------------------------------
  app.delete('/telegram/webhook', { preHandler: [requirePermission(PERMISSIONS.BOT_ADMIN)] }, async (request, reply) => {
    try {
      await deleteWebhook(true);
      await audit(request, { action: 'settings.telegram_delete_webhook' });
      return reply.send({ ok: true, message: 'Webhook eliminado. Usa TELEGRAM_MODE=polling si quieres long polling.' });
    } catch (err) {
      return reply.code(400).send({ ok: false, error: (err as Error).message });
    }
  });

  // -------------------------------------------------------------------------
  // GET /api/settings/audit — ultimos eventos de auditoria
  // -------------------------------------------------------------------------
  app.get('/audit', { preHandler: [requirePermission(PERMISSIONS.AUDIT_READ)] }, async (request, reply) => {
    const q = z.object({ take: z.coerce.number().int().min(1).max(200).optional() }).safeParse(request.query);
    const logs = await prisma.auditLog.findMany({
      include: { user: { select: { fullName: true, email: true } } },
      orderBy: { createdAt: 'desc' },
      take: q.success ? q.data.take ?? 50 : 50,
    });
    return reply.send({ logs });
  });

  // -------------------------------------------------------------------------
  // GET /api/settings/bot-messages — trazabilidad del NLU
  // -------------------------------------------------------------------------
  app.get('/bot-messages', { preHandler: [requirePermission(PERMISSIONS.BOT_ADMIN)] }, async (request, reply) => {
    const q = z.object({ take: z.coerce.number().int().min(1).max(200).optional() }).safeParse(request.query);
    const messages = await prisma.botMessage.findMany({
      include: { user: { select: { fullName: true } } },
      orderBy: { createdAt: 'desc' },
      take: q.success ? q.data.take ?? 50 : 50,
    });
    return reply.send({ messages });
  });
}
