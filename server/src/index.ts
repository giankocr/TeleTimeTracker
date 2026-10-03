import { buildApp } from './app';
import { env, telegramToken } from './config/env';
import { bootstrapDatabase } from './config/bootstrap';
import { prisma, applySqlitePragmas } from './db/prisma';
import { loadSettings } from './services/settings.service';
import { startScheduler, stopScheduler } from './services/alerts.service';
import { applyBotTokenFromSettings, startPolling, stopPolling } from './bot/telegram.controller';
import { setWebhook, getMe, getWebhookInfo, isConfigured } from './bot/telegram.api';

/**
 * Punto de entrada del contenedor.
 *  1. Migra + seed de la base de datos (volumen persistente).
 *  2. Carga la configuracion guardada (tokens del panel).
 *  3. Levanta la API + panel web.
 *  4. Arranca el bot: webhook (recomendado) o long polling.
 *  5. Programa las alertas.
 */
async function main(): Promise<void> {
  console.log('🚀 TeleTimeTracker arrancando...');

  await bootstrapDatabase();

  const app = await buildApp();
  await applySqlitePragmas();
  await loadSettings();
  applyBotTokenFromSettings(telegramToken());

  // --- Bot de Telegram ---
  if (isConfigured() && env.TELEGRAM_MODE !== 'off') {
    try {
      const me = await getMe();
      console.log(`🤖 Bot conectado: @${me.username} (${me.first_name})`);
      applyBotTokenFromSettings(telegramToken());

      if (env.TELEGRAM_MODE === 'webhook') {
        if (env.PUBLIC_URL) {
          await setWebhook(`${env.PUBLIC_URL}/api/telegram/webhook`, env.TELEGRAM_WEBHOOK_SECRET || undefined);
          const info = await getWebhookInfo();
          console.log(`🔗 Webhook registrado en ${env.PUBLIC_URL}/api/telegram/webhook`, info.last_error_message ? `(ultimo error: ${info.last_error_message})` : '');
        } else {
          console.warn('⚠  TELEGRAM_MODE=webhook pero falta PUBLIC_URL: el bot no recibira mensajes. Usa TELEGRAM_MODE=polling o define PUBLIC_URL.');
        }
      } else if (env.TELEGRAM_MODE === 'polling') {
        // Long polling en segundo plano (util sin dominio publico).
        void startPolling();
      }
    } catch (err) {
      console.error('⚠  No se pudo inicializar el bot de Telegram:', (err as Error).message);
    }
  } else {
    console.warn('ℹ  Bot de Telegram deshabilitado (sin token o TELEGRAM_MODE=off). Configura el token desde el panel.');
  }

  // --- Alertas ---
  if (env.ALERTS_ENABLED) startScheduler();

  // --- Servidor HTTP ---
  await app.listen({ port: env.PORT, host: env.HOST });
  console.log(`✅ Panel y API disponibles en http://${env.HOST}:${env.PORT}`);
  console.log(`   Datos persistentes en: ${env.DATA_DIR}`);

  // --- Apagado ordenado ---
  const shutdown = async (signal: string): Promise<void> => {
    console.log(`\n${signal} recibido, cerrando...`);
    stopPolling();
    stopScheduler();
    await app.close().catch(() => undefined);
    await prisma.$disconnect().catch(() => undefined);
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('unhandledRejection', (reason) => console.error('unhandledRejection:', reason));
}

main().catch((err) => {
  console.error('❌ Fallo al arrancar:', err);
  process.exit(1);
});
