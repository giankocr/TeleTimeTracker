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

/**
 * Comprueba si el cliente Prisma generado corresponde al motor en uso.
 *
 * En la imagen Docker el cliente se genera en la etapa de build con el esquema
 * base (SQLite). Si en runtime se configura MySQL, ese cliente NO sirve y
 * Prisma falla con: 'the URL must start with the protocol `file:`'.
 * Como el cliente se genera por motor, hay que regenerarlo al arrancar.
 */
function clientMatchesEngine(profile: DbProfile): { ok: boolean; detail: string } {
  try {
    const clientEntry = require.resolve('@prisma/client');
    const clientDir = path.dirname(clientEntry);
    const candidates = [
      path.join(clientDir, 'index.js'),
      path.join(clientDir, 'default.js'),
      path.join(process.cwd(), 'node_modules/.prisma/client/index.js'),
      path.join(process.cwd(), 'node_modules/.prisma/client/default.js'),
    ];
    for (const file of candidates) {
      if (!fs.existsSync(file)) continue;
      const source = fs.readFileSync(file, 'utf8');
      const mentionsSqlite = /provider\s*[:=]\s*["']sqlite["']/.test(source) || source.includes('"sqlite"');
      const mentionsMysql = /provider\s*[:=]\s*["']mysql["']/.test(source) || source.includes('"mysql"');
      if (profile.engine === 'mysql') {
        if (mentionsMysql && !mentionsSqlite) return { ok: true, detail: `${path.basename(file)}: mysql` };
        if (mentionsSqlite) return { ok: false, detail: `${path.basename(file)}: sqlite` };
      }
      if (profile.engine === 'sqlite') {
        if (mentionsSqlite) return { ok: true, detail: `${path.basename(file)}: sqlite` };
      }
    }
  } catch (err) {
    return { ok: false, detail: `no se pudo inspeccionar el cliente: ${(err as Error).message}` };
  }
  return { ok: true, detail: 'no concluyente (se asume correcto)' };
}

/**
 * Copia el cliente Prisma empaquetado en la imagen para el motor indicado.
 *
 * El Dockerfile genera los dos y guarda el de MySQL en `/prisma-client-mysql`.
 * Usarlo evita ejecutar el CLI (mas lento) y no necesita red.
 */
function useBundledClient(engine: DbProfile['engine']): boolean {
  const origen = engine === 'mysql' ? '/prisma-client-mysql' : '/prisma-client-sqlite';
  const destino = path.resolve(process.cwd(), 'node_modules/.prisma/client');
  try {
    if (!fs.existsSync(origen)) return false;
    if (fs.existsSync(destino)) fs.rmSync(destino, { recursive: true, force: true });
    fs.mkdirSync(destino, { recursive: true });
    for (const entry of fs.readdirSync(origen)) {
      if (entry === 'schema.prisma' || entry.endsWith('.tmp')) continue; // el esquema lo pone el CLI
      fs.cpSync(path.join(origen, entry), path.join(destino, entry), { recursive: true });
    }
    console.log(`[bootstrap] cliente Prisma de ${engine} copiado desde ${origen}`);
    return true;
  } catch (err) {
    console.warn(`[bootstrap] no se pudo copiar el cliente de ${origen}: ${(err as Error).message}`);
    return false;
  }
}

/**
 * Aplica las migraciones de MySQL con el aplicador propio.
 * Ver server/src/db/migrator.ts para el motivo (P3019 de Prisma).
 */
async function migrateWithRunner(profile: DbProfile): Promise<void> {
  try {
    const { runMigrations, splitStatements, discoverMigrations } = await import('../db/migrator');
    const { prisma: db } = await import('../db/prisma');

    // Tabla de control (sintaxis MySQL).
    await db.$executeRawUnsafe(
      'CREATE TABLE IF NOT EXISTS `_app_migrations` (' +
        '`name` VARCHAR(191) NOT NULL, ' +
        '`statements` INT NOT NULL DEFAULT 0, ' +
        '`appliedAt` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, ' +
        'PRIMARY KEY (`name`))',
    );

    // Base creada por una version anterior (o migrada desde SQLite) sin
    // historial: se registran las migraciones como aplicadas sin re-ejecutarlas.
    const existing = (await db.$queryRawUnsafe(
      "SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name IN ('users','time_entries','roles')",
    )) as Array<{ n: bigint | number }>;
    if (Number(existing[0]?.n ?? 0) > 0) {
      const registradas = new Set(
        ((await db.$queryRawUnsafe('SELECT `name` FROM `_app_migrations`')) as Array<{ name: string }>).map((r) => r.name),
      );
      const faltantes = discoverMigrations(profile.migrations).filter((m) => !registradas.has(m.name));
      if (faltantes.length) {
        console.warn(
          `[bootstrap] la base ya tiene tablas: se registran ${faltantes.length} migracion(es) como aplicadas sin re-ejecutarlas`,
        );
        for (const migracion of faltantes) {
          await db.$executeRawUnsafe(
            'INSERT INTO `_app_migrations` (`name`, `statements`) VALUES (?, ?)',
            migracion.name,
            0,
          );
        }
      }
    }

    const result = await runMigrations({
      migrationsDir: profile.migrations,
      execute: async (sql) => {
        // MySQL no admite varias sentencias en una llamada: se ejecutan una a una.
        for (const statement of splitStatements(sql)) {
          await db.$executeRawUnsafe(statement);
        }
      },
      applied: async () => {
        const rows = (await db.$queryRawUnsafe('SELECT `name` FROM `_app_migrations`')) as Array<{ name: string }>;
        return new Set(rows.map((row) => row.name));
      },
      markApplied: async (name, statements) => {
        await db.$executeRawUnsafe(
          'INSERT INTO `_app_migrations` (`name`, `statements`) VALUES (?, ?)',
          name,
          statements,
        );
      },
      log: console.log,
    });

    if (result.failed) {
      console.error(`[bootstrap] migracion fallida: ${result.failed.name}`);
      console.error(`   ${result.failed.error.split('\n')[0]}`);
    } else {
      console.log(
        `[bootstrap] migraciones: ${result.applied.length} aplicadas, ${result.skipped.length} ya estaban`,
      );
    }
  } catch (err) {
    console.error('[bootstrap] no se pudieron aplicar las migraciones:', (err as Error).message);
  }
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

  // El cliente generado en build apunta a SQLite. Si el motor real es MySQL hay
  // que cambiarlo ANTES de migrar y sembrar (esos pasos lo necesitan). Se
  // prefiere la copia ya generada que trae la imagen; solo si no existe se
  // regenera con el CLI.
  const match = clientMatchesEngine(profile);
  if (!match.ok) {
    console.log(`[bootstrap] el cliente Prisma generado no corresponde a ${profile.engine} (${match.detail})`);
    if (!useBundledClient(profile.engine)) {
      console.log('[bootstrap] regenerando Prisma Client con el CLI...');
      const gen = runPrisma(['generate', '--schema', profile.schema]);
      if (gen.ok) {
        console.log(`[bootstrap] Prisma Client regenerado para ${profile.engine}`);
      } else {
        console.error('[bootstrap] no se pudo preparar el cliente Prisma:');
        console.error(gen.output.split('\n').slice(0, 6).join('\n'));
      }
    }
  }

  if (profile.engine === 'mysql' && !fs.existsSync(profile.migrations)) {
    console.error('[bootstrap] falta el juego de migraciones de MySQL (server/prisma/migrations.mysql).');
    console.error('           Genera el esquema con: node scripts/generate-mysql-schema.mjs');
  }


  if (env.AUTO_MIGRATE) {
    if (profile.engine === 'mysql') {
      // MySQL: se usa el aplicador propio porque `prisma migrate deploy` solo
      // admite el directorio `migrations/` junto al esquema y choca con la
      // convivencia de SQLite y MySQL (error P3019).
      await migrateWithRunner(profile);
    } else {
      // SQLite (y otros): se usa el migrador oficial de Prisma, que si soporta
      // este caso porque el esquema base y el directorio `migrations/` coinciden.
      console.log('[bootstrap] aplicando migraciones (prisma migrate deploy)...');
      const result = runPrisma(['migrate', 'deploy', '--schema', profile.schema]);
      if (result.ok) {
        console.log('[bootstrap] migraciones al dia');
      } else {
        console.warn('[bootstrap] migrate deploy fallo, intentando prisma db push...');
        const push = runPrisma(['db', 'push', '--schema', profile.schema, '--skip-generate', '--accept-data-loss']);
        if (!push.ok) {
          console.warn('[bootstrap] db push tambien fallo. Detalle:\n', push.output || result.output);
        } else {
          console.log('[bootstrap] esquema aplicado con db push');
        }
      }
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
