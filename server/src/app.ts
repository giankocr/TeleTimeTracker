import path from 'node:path';
import fs from 'node:fs';
import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import { env, dataDirStatus } from './config/env';
import { prisma } from './db/prisma';

import authRoutes from './routes/auth.routes';
import userRoutes from './routes/users.routes';
import roleRoutes from './routes/roles.routes';
import clientRoutes from './routes/clients.routes';
import entryRoutes from './routes/entries.routes';
import reportRoutes from './routes/reports.routes';
import settingsRoutes from './routes/settings.routes';
import telegramRoutes from './routes/telegram.routes';

/**
 * Construye la aplicacion Fastify: API del panel + webhook de Telegram + SPA.
 */
export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: env.isProd
      ? { level: env.LOG_LEVEL }
      : {
          level: env.LOG_LEVEL,
          transport: { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' } },
        },
    trustProxy: true,
    bodyLimit: 10 * 1024 * 1024,
  });

  // ---------------------------------------------------------------------
  // Plugins base
  // ---------------------------------------------------------------------
  await app.register(cors, {
    origin: env.CORS_ORIGINS.includes('*') ? true : env.CORS_ORIGINS,
    credentials: true,
  });
  await app.register(cookie, { secret: env.JWT_SECRET });
  await app.register(jwt, { secret: env.JWT_SECRET });
  await app.register(multipart, { limits: { fileSize: 25 * 1024 * 1024 } });

  // ---------------------------------------------------------------------
  // Health / readiness
  // ---------------------------------------------------------------------
  // Healthcheck del contenedor: responde 200 mientras el proceso viva (asi la
  // plataforma no reinicia en bucle mientras se migra). El detalle va aparte.
  app.get('/health', async () => ({
    status: 'ok',
    uptime: Math.round(process.uptime()),
    version: '1.0.0',
    dataDir: { path: env.DATA_DIR, writable: dataDirStatus.writable, error: dataDirStatus.error },
  }));

  app.get('/api/health', async (_request, reply) => {
    try {
      await prisma.$queryRaw`SELECT 1`;
      return reply.send({ status: 'ok', db: 'up', mode: env.TELEGRAM_MODE });
    } catch (err) {
      return reply.code(503).send({ status: 'degraded', db: 'down', error: (err as Error).message });
    }
  });

  // ---------------------------------------------------------------------
  // Rutas de la API
  // ---------------------------------------------------------------------
  await app.register(authRoutes, { prefix: '/api/auth' });
  await app.register(userRoutes, { prefix: '/api/users' });
  await app.register(roleRoutes, { prefix: '/api/roles' });
  await app.register(clientRoutes, { prefix: '/api' }); // /api/clients, /api/projects, /api/task-types
  await app.register(entryRoutes, { prefix: '/api/entries' });
  await app.register(reportRoutes, { prefix: '/api/reports' });
  await app.register(settingsRoutes, { prefix: '/api/settings' });
  await app.register(telegramRoutes, { prefix: '/api/telegram' });

  // ---------------------------------------------------------------------
  // SPA (panel web compilado con Vite) — fallback a index.html
  // ---------------------------------------------------------------------
  const webDir = path.resolve(process.cwd(), 'web/dist');
  if (fs.existsSync(webDir)) {
    await app.register(fastifyStatic, { root: webDir, prefix: '/', wildcard: false });
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith('/api') || request.url.startsWith('/health')) {
        return reply.code(404).send({ error: 'Ruta no encontrada', path: request.url });
      }
      return reply.sendFile('index.html');
    });
    app.log.info(`Panel web servido desde ${webDir}`);
  } else {
    app.log.warn('No se encontro web/dist: el panel no esta compilado (ejecuta npm run build:web).');
    app.get('/', async (_request, reply) =>
      reply
        .type('text/html')
        .send('<h1>TeleTimeTracker API</h1><p>El panel no esta compilado. Endpoints disponibles en <code>/api/*</code>.</p>'),
    );
  }

  // ---------------------------------------------------------------------
  // Manejo central de errores
  // ---------------------------------------------------------------------
  app.setErrorHandler((error, request, reply) => {
    const status = error.statusCode ?? 500;
    if (status >= 500) request.log.error({ err: error }, 'Error no controlado');
    return reply.code(status).send({
      error: status >= 500 && env.isProd ? 'Error interno del servidor' : error.message,
      code: error.code ?? undefined,
    });
  });

  return app;
}
