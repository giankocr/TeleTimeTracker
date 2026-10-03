import type { FastifyInstance, FastifyRequest } from 'fastify';
import { env } from '../config/env';
import { prisma } from '../db/prisma';
import { processUpdate } from '../bot/telegram.controller';
import { getSetting, SETTING_KEYS } from '../services/settings.service';
import type { TgUpdate } from '../bot/telegram.api';
import { authenticate, requirePermission } from '../middleware/auth';
import { PERMISSIONS } from '../../../shared/types';

/**
 * Endpoints de Telegram.
 *  - POST /api/telegram/webhook  -> lo llama Telegram (sin JWT, validado por secret_token)
 *  - GET  /api/telegram/status   -> diagnostico para el panel
 */
export default async function telegramRoutes(app: FastifyInstance): Promise<void> {
  // -------------------------------------------------------------------------
  // Webhook publico
  // -------------------------------------------------------------------------
  app.post('/webhook', async (request, reply) => {
    const expectedSecret = (getSetting(SETTING_KEYS.TELEGRAM_WEBHOOK_SECRET, env.TELEGRAM_WEBHOOK_SECRET) || '').trim();
    if (expectedSecret) {
      const received = String(request.headers['x-telegram-bot-api-secret-token'] ?? '');
      if (received !== expectedSecret) {
        request.log.warn('Webhook de Telegram con secret_token invalido');
        return reply.code(401).send({ ok: false });
      }
    }

    const update = request.body as TgUpdate | undefined;
    if (!update || typeof update.update_id !== 'number') {
      // Telegram reintenta si devolvemos error, pero un body invalido no se arregla reintentando.
      return reply.send({ ok: true, ignored: true });
    }

    // Se responde 200 inmediatamente y se procesa en segundo plano: Telegram
    // reintenta si tardamos mas de unos segundos (la transcripcion de audio tarda).
    void processUpdate(update).catch((err) => request.log.error({ err }, 'Error procesando update de Telegram'));

    return reply.send({ ok: true });
  });

  // -------------------------------------------------------------------------
  // Estado del webhook (panel)
  // -------------------------------------------------------------------------
  app.get('/status', { preHandler: [authenticate, requirePermission(PERMISSIONS.BOT_ADMIN)] }, async (request: FastifyRequest, reply) => {
    const { getWebhookInfo, getMe, isConfigured } = await import('../bot/telegram.api');
    if (!isConfigured()) {
      return reply.send({ configured: false, message: 'TELEGRAM_BOT_TOKEN no configurado' });
    }
    const [info, me] = await Promise.all([
      getWebhookInfo().catch((e) => ({ error: (e as Error).message })),
      getMe().catch((e) => ({ error: (e as Error).message })),
    ]);
    const linked = await prisma.user.count({ where: { telegramId: { not: null } } });
    void request;
    return reply.send({
      configured: true,
      mode: env.TELEGRAM_MODE,
      bot: me,
      webhook: info,
      expectedWebhookUrl: env.PUBLIC_URL ? `${env.PUBLIC_URL}/api/telegram/webhook` : null,
      linkedUsers: linked,
    });
  });

  // -------------------------------------------------------------------------
  // POST /api/telegram/simulate — probar el NLU sin Telegram (solo admin)
  // -------------------------------------------------------------------------
  app.post('/simulate', { preHandler: [authenticate, requirePermission(PERMISSIONS.BOT_ADMIN)] }, async (request, reply) => {
    const body = request.body as { text?: string; userId?: string } | undefined;
    const text = (body?.text ?? '').trim();
    if (!text) return reply.code(400).send({ error: 'Envia "text" para simular' });

    const { parseCommand } = await import('../services/nlu.service');
    const { nluContext } = await import('../services/assistant.service');
    const user = body?.userId
      ? await prisma.user.findUnique({ where: { id: body.userId }, include: { role: true } })
      : await prisma.user.findFirst({ where: { isActive: true }, include: { role: true } });

    if (!user) return reply.code(400).send({ error: 'No hay usuarios para simular' });
    const context = await nluContext(user.id, user.role.key);
    const parsed = await parseCommand(text, context);
    return reply.send({ parsed, context });
  });
}
