import { buildApp } from './app';
import { env, telegramToken } from './config/env';
import { bootstrapDatabase } from './config/bootstrap';
import { prisma, applySqlitePragmas } from './db/prisma';
import { loadSettings } from './services/settings.service';
import { startScheduler, stopScheduler } from './services/alerts.service';
import { applyBotTokenFromSettings, startPolling, stopPolling } from './bot/telegram.controller';
import { setWebhook, getMe, getWebhookInfo, isConfigured } from './bot/telegram.api';
import { authenticate, requirePermission } from './middleware/auth';
import { PERMISSIONS } from '../../shared/types';

/**
 * Punto de entrada del contenedor.
 *
 * ORDEN IMPORTANTE (pensado para EasyPanel y otros PaaS):
 *  1. Se registran los diagnosticos y se abre el puerto PRIMERO. Asi el
 *     healthcheck responde y la plataforma no reinicia el contenedor en bucle
 *     mientras se aplican migraciones o mientras Telegram no responde.
 *  2. Despues se prepara la base de datos (migraciones + seed).
 *  3. Luego el bot y las alertas.
 *
 * Ningun fallo de los pasos 2-3 detiene el proceso: se registra el error y el
 * panel sigue en pie mostrando el diagnostico, en lugar de morir en silencio.
 */

const state = {
  databaseReady: false,
  databaseError: null as string | null,
  botStatus: 'deshabilitado' as 'deshabilitado' | 'conectado' | 'error',
  botDetail: null as string | null,
  startedAt: new Date().toISOString(),
};

/** Banner con el contexto minimo para diagnosticar un despliegue. */
function logStartupContext(): void {
  const dbKind = env.DATABASE_URL.startsWith('file:') ? 'SQLite (archivo)' : 'PostgreSQL/otro';
  console.log('─'.repeat(64));
  console.log('🚀 TeleTimeTracker arrancando');
  console.log(`   NODE_ENV        : ${env.NODE_ENV}`);
  console.log(`   Puerto / host   : ${env.PORT} / ${env.HOST}`);
  console.log(`   Directorio datos: ${env.DATA_DIR}`);
  console.log(`   Base de datos   : ${dbKind}`);
  console.log(`   Modo Telegram   : ${env.TELEGRAM_MODE}`);
  console.log(`   PUBLIC_URL      : ${env.PUBLIC_URL || '(sin definir)'}`);
  console.log(`   Bot token       : ${telegramToken() ? 'configurado' : 'NO configurado'}`);
  console.log(`   OpenAI key      : ${env.OPENAI_API_KEY ? 'configurada' : 'no configurada'}`);
  console.log(`   JWT_SECRET      : ${env.JWT_SECRET.length >= 24 ? 'ok' : '⚠ corto o por defecto'}`);
  console.log('─'.repeat(64));
}

/**
 * Registra el webhook y VERIFICA que Telegram pueda entregar.
 *
 * Motivo: en el primer despliegue el certificado TLS puede emitirse unos
 * minutos DESPUES de que el contenedor arranque. Si solo se registra una vez,
 * Telegram responde "certificate verify failed" y el bot queda mudo sin que
 * nadie se entere. Aqui se reintenta y se registra el estado real.
 */
async function registerWebhookWithRetry(url: string, attempt = 1): Promise<void> {
  const MAX_ATTEMPTS = 5;
  try {
    await setWebhook(url, env.TELEGRAM_WEBHOOK_SECRET || undefined);
    const info = await getWebhookInfo();
    if (info.last_error_message) {
      throw new Error(info.last_error_message);
    }
    console.log(`🔗 Webhook activo y verificado: ${url}`);
  } catch (err) {
    const message = (err as Error).message;
    console.warn(`⚠  Webhook no verificado (intento ${attempt}/${MAX_ATTEMPTS}): ${message}`);
    if (/certificate|SSL/i.test(message)) {
      console.warn('   Causa tipica: el certificado TLS del dominio aun no estaba emitido.');
      console.warn('   Revisa en EasyPanel que el dominio tenga HTTPS activo y el certificado emitido.');
    }
    if (attempt < MAX_ATTEMPTS) {
      const delayMs = 2 * 60 * 1000; // 2 minutos
      console.warn(`   Se reintentara en ${delayMs / 60000} minutos...`);
      const timer = setTimeout(() => void registerWebhookWithRetry(url, attempt + 1), delayMs);
      timer.unref?.();
    } else {
      console.error('   ❌ El bot no recibira mensajes por webhook.');
      console.error('   Alternativa inmediata: TELEGRAM_MODE=polling (no necesita dominio ni certificado).');
    }
  }
}

async function main(): Promise<void> {
  logStartupContext();

  const app = await buildApp();

  // Diagnostico para el panel (requiere sesion con permiso de configuracion).
  app.get('/api/diagnostics', { preHandler: [authenticate, requirePermission(PERMISSIONS.SETTINGS_READ)] }, async (_request, reply) => {
    let dbOk = false;
    let dbError: string | null = null;
    try {
      await prisma.$queryRaw`SELECT 1`;
      dbOk = true;
    } catch (err) {
      dbError = (err as Error).message.split('\n')[0]!;
    }
    return reply.send({
      status: dbOk ? 'ok' : 'degraded',
      database: { ready: dbOk, error: dbError, target: env.DATABASE_URL.startsWith('file:') ? env.SQLITE_FILE : 'remota' },
      telegram: { mode: env.TELEGRAM_MODE, status: state.botStatus, detail: state.botDetail, publicUrl: env.PUBLIC_URL || null },
      dataDir: env.DATA_DIR,
      startedAt: state.startedAt,
      node: process.version,
    });
  });

  // 1) Puerto abierto cuanto antes: el healthcheck manda sobre todo lo demas.
  await app.listen({ port: env.PORT, host: env.HOST });
  console.log(`✅ Servidor escuchando en http://${env.HOST}:${env.PORT}`);

  // 2) Base de datos (no fatal: si falla, se reporta y el panel sigue vivo).
  try {
    await bootstrapDatabase();
    await applySqlitePragmas();
    await loadSettings();
    await prisma.$queryRaw`SELECT 1`;
    state.databaseReady = true;
    console.log('✅ Base de datos lista');
  } catch (err) {
    const message = (err as Error).message.split('\n').slice(0, 3).join(' | ');
    state.databaseError = message;
    console.error('❌ La base de datos no quedo lista. El panel arrancara en modo degradado.');
    console.error(`   Motivo: ${message}`);
    console.error('   Revisa: DATA_DIR, permisos del volumen montado y DATABASE_URL.');
  }

  applyBotTokenFromSettings(telegramToken());

  // 3) Bot de Telegram.
  if (isConfigured() && env.TELEGRAM_MODE !== 'off') {
    try {
      const me = await getMe();
      state.botStatus = 'conectado';
      console.log(`🤖 Bot conectado: @${me.username} (${me.first_name})`);
      applyBotTokenFromSettings(telegramToken());

      // Menu de comandos de Telegram (aparece al escribir «/» en el chat).
      const { publishBotCommands } = await import('./bot/commands');
      const menu = await publishBotCommands();
      console.log(menu.ok ? '📋 Menú de comandos publicado en Telegram' : `⚠  No se pudo publicar el menú: ${menu.error}`);

      if (env.TELEGRAM_MODE === 'webhook') {
        if (env.PUBLIC_URL) {
          await registerWebhookWithRetry(`${env.PUBLIC_URL}/api/telegram/webhook`);
        } else {
          console.warn('⚠  TELEGRAM_MODE=webhook pero falta PUBLIC_URL.');
          console.warn('   → Opcion A: define PUBLIC_URL con tu dominio de EasyPanel (sin barra final).');
          console.warn('   → Opcion B: pon TELEGRAM_MODE=polling y no necesitas dominio ni webhook.');
          state.botDetail = 'Falta PUBLIC_URL para registrar el webhook';
        }
      } else if (env.TELEGRAM_MODE === 'polling') {
        void startPolling();
      }
    } catch (err) {
      state.botStatus = 'error';
      state.botDetail = (err as Error).message.split('\n')[0]!;
      console.error('⚠  No se pudo inicializar el bot:', state.botDetail);
      console.error('   El panel web funciona igual; corrige el token en Configuración y reinicia.');
    }
  } else {
    console.warn('ℹ  Bot deshabilitado (sin token o TELEGRAM_MODE=off). Se puede configurar desde el panel.');
  }

  // 4) Alertas.
  if (env.ALERTS_ENABLED) {
    try {
      startScheduler();
    } catch (err) {
      console.warn('⚠  No se pudo iniciar el planificador de alertas:', (err as Error).message);
    }
  }

  console.log(`   Datos persistentes en: ${env.DATA_DIR}`);
  console.log('────────────────────────────────────────────────────────────────');

  // 5) Apagado ordenado (SIGTERM al redeploy).
  const shutdown = async (signal: string): Promise<void> => {
    console.log(`${signal} recibido, cerrando...`);
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

// Si algo catastrofico pasa antes de escuchar, se registra con claridad para que
// el log de EasyPanel diga QUE fallo en lugar de un stack trace sin contexto.
main().catch((err) => {
  console.error('❌ Fallo critico al arrancar:', err);
  console.error('   Variables a revisar: PORT, DATA_DIR, DATABASE_URL, JWT_SECRET.');
  process.exit(1);
});
