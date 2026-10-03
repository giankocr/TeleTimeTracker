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
        openaiConfigured: Boolean(getSetting(SETTING_KEYS.OPENAI_API_KEY) || env.OPENAI_API_KEY),
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
  // POST /api/settings/telegram/webhook — registra el webhook en Telegram
  // -------------------------------------------------------------------------
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
