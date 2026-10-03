import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { env } from './env';

/**
 * Arranque del contenedor: aplica migraciones y seed antes de levantar el servidor.
 * Se ejecuta solo si AUTO_MIGRATE / AUTO_SEED estan activos, de modo que en
 * desarrollo local puedes controlarlo manualmente.
 *
 * PERFILES DE BASE DE DATOS
 * -------------------------
 * El SQL de las migraciones es especifico del motor, asi que hay dos juegos:
 *
 *   - SQLite (por defecto) -> server/prisma/migrations       + schema.prisma
 *   - MySQL                -> server/prisma/migrations.mysql + schema.mysql.prisma
 *
 * El perfil se elige mirando DATABASE_URL, de modo que el MISMO contenedor
 * funciona con SQLite o con MySQL sin cambiar nada mas.
 */

const SQLITE_SCHEMA = path.resolve(process.cwd(), 'server/prisma/schema.prisma');
const MYSQL_SCHEMA = path.resolve(process.cwd(), 'server/prisma/schema.mysql.prisma');
const SQLITE_MIGRATIONS = path.resolve(process.cwd(), 'server/prisma/migrations');
const MYSQL_MIGRATIONS = path.resolve(process.cwd(), 'server/prisma/migrations.mysql');
const PRISMA_CLI = path.resolve(process.cwd(), 'node_modules/prisma/build/index.js');
const SEED_FILE = path.resolve(process.cwd(), 'server/prisma/seed.ts');

export interface DbProfile {
  engine: 'sqlite' | 'mysql' | 'postgresql' | 'other';
  schema: string;
  migrations: string;
}

/** Perfil activo segun DATABASE_URL. */
export function dbProfile(databaseUrl: string = env.DATABASE_URL): DbProfile {
  if (databaseUrl.startsWith('mysql://') || databaseUrl.startsWith('mysqls://')) {
    return { engine: 'mysql', schema: MYSQL_SCHEMA, migrations: MYSQL_MIGRATIONS };
  }
  if (databaseUrl.startsWith('postgres://') || databaseUrl.startsWith('postgresql://')) {
    return { engine: 'postgresql', schema: SQLITE_SCHEMA, migrations: SQLITE_MIGRATIONS };
  }
  if (databaseUrl.startsWith('file:')) {
    return { engine: 'sqlite', schema: SQLITE_SCHEMA, migrations: SQLITE_MIGRATIONS };
  }
  return { engine: 'other', schema: SQLITE_SCHEMA, migrations: SQLITE_MIGRATIONS };
}

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

  const profile = dbProfile();
  console.log(
    `[bootstrap] motor: ${profile.engine} · migraciones: ${path.basename(profile.migrations)} · esquema: ${path.basename(profile.schema)}`,
  );

  if (profile.engine === 'mysql' && !fs.existsSync(profile.migrations)) {
    console.error('[bootstrap] falta el juego de migraciones de MySQL (server/prisma/migrations.mysql).');
    console.error('           Genera el esquema con: node scripts/generate-mysql-schema.mjs');
  }

  if (env.AUTO_MIGRATE) {
    console.log('[bootstrap] aplicando migraciones (prisma migrate deploy)...');
    const result = runPrisma(['migrate', 'deploy', '--schema', profile.schema]);
    if (!result.ok) {
      // En el primer arranque puede no haber migraciones registradas: se cae a db push.
      console.warn('[bootstrap] migrate deploy fallo, intentando prisma db push...');
      const push = runPrisma(['db', 'push', '--schema', profile.schema, '--skip-generate', '--accept-data-loss']);
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
