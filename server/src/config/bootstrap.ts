import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { env } from './env';

/**
 * Arranque del contenedor: aplica migraciones y seed antes de levantar el servidor.
 * Se ejecuta solo si AUTO_MIGRATE / AUTO_SEED estan activos, de modo que en
 * desarrollo local puedes controlarlo manualmente.
 */

const PRISMA_SCHEMA = path.resolve(process.cwd(), 'server/prisma/schema.prisma');
const PRISMA_CLI = path.resolve(process.cwd(), 'node_modules/prisma/build/index.js');
const SEED_FILE = path.resolve(process.cwd(), 'server/prisma/seed.ts');

function runLocalNode(args: string[]): { ok: boolean; output: string } {
  const result = spawnSync(process.execPath, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
    encoding: 'utf8',
  });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
  return { ok: result.status === 0, output };
}

function runPrisma(args: string[]): { ok: boolean; output: string } {
  const prismaEntry = fs.existsSync(PRISMA_CLI)
    ? PRISMA_CLI
    : (() => {
        try {
          return require.resolve('prisma/build/index.js');
        } catch {
          return null;
        }
      })();

  if (!prismaEntry) {
    return { ok: false, output: 'prisma CLI no encontrado en node_modules' };
  }
  return runLocalNode([prismaEntry, ...args]);
}

export async function bootstrapDatabase(): Promise<void> {
  // Nunca lanzar por el directorio: el arranque ya lo reporto y seguimos.
  try {
    if (!fs.existsSync(env.DATA_DIR)) fs.mkdirSync(env.DATA_DIR, { recursive: true });
  } catch (err) {
    console.error('[bootstrap] directorio de datos no disponible:', (err as Error).message);
    return;
  }

  if (env.AUTO_MIGRATE) {
    console.log('[bootstrap] aplicando migraciones (prisma migrate deploy)...');
    const result = runPrisma(['migrate', 'deploy', '--schema', PRISMA_SCHEMA]);
    if (!result.ok) {
      // En el primer arranque puede no haber migraciones registradas: se cae a db push.
      console.warn('[bootstrap] migrate deploy fallo, intentando prisma db push...');
      const push = runPrisma(['db', 'push', '--schema', PRISMA_SCHEMA, '--skip-generate', '--accept-data-loss']);
      if (!push.ok) {
        console.warn('[bootstrap] db push tambien fallo. Detalle:\n', push.output || result.output);
      } else {
        console.log('[bootstrap] esquema aplicado con db push');
      }
    } else {
      console.log('[bootstrap] migraciones al dia');
    }
  }

  if (env.AUTO_SEED) {
    console.log('[bootstrap] ejecutando seed...');
    // En la imagen final el seed ya viene compilado en dist/ y se ejecuta con node.
    // En desarrollo se usa tsx (require hook de CJS) para ejecutar el .ts directo.
    const compiledSeed = path.resolve(process.cwd(), 'dist/server/prisma/seed.js');
    const seedTarget = fs.existsSync(compiledSeed)
      ? [compiledSeed]
      : ['--require', 'tsx/cjs', SEED_FILE];
    const result = runLocalNode(seedTarget);
    if (!result.ok) {
      console.warn('[bootstrap] seed fallo (no es bloqueante):\n', result.output);
    } else {
      console.log(result.output);
    }
  }
}
