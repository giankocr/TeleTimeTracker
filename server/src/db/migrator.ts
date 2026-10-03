import fs from 'node:fs';
import path from 'node:path';

/**
 * Aplicador de migraciones SQL minimo y multi-motor.
 *
 * ¿POR QUE NO `prisma migrate deploy`?
 * Prisma busca SIEMPRE el directorio `migrations/` junto al esquema y compara su
 * `migration_lock.toml` con el provider del esquema. Como este proyecto necesita
 * DOS juegos de migraciones (SQLite y MySQL) con el mismo esquema, `migrate
 * deploy` falla con P3019 ("datasource provider `mysql` does not match the one
 * specified in the migration_lock.toml, `sqlite`"), y `prisma db push` (el
 * respaldo) no deja historial de migraciones.
 *
 * Este aplicador:
 *   1. crea la tabla de control `_app_migrations`
 *   2. descubre las migraciones (carpetas con migration.sql) en orden alfabetico
 *   3. ejecuta las pendientes dentro de una transaccion cada una
 *
 * El SQL se ejecuta TAL CUAL, asi que el historial de Prisma sigue siendo valido
 * para desarrollo local (`prisma migrate dev` con SQLite).
 */

export type SqlDialect = 'sqlite' | 'mysql' | 'postgresql' | 'other';

interface RunnerOptions {
  /** Directorio que contiene las carpetas de migracion. */
  migrationsDir: string;
  /** Ejecuta un bloque de SQL de varias sentencias. */
  execute: (sql: string) => Promise<void>;
  /** Devuelve las claves unicas ya aplicadas. */
  applied: () => Promise<Set<string>>;
  /** Registra una migracion como aplicada. */
  markApplied: (name: string, statements: number) => Promise<void>;
  log?: (message: string) => void;
}

export interface MigrateResult {
  applied: string[];
  skipped: string[];
  failed?: { name: string; error: string };
}

/** Descubre las migraciones disponibles, ordenadas por nombre. */
export function discoverMigrations(migrationsDir: string): Array<{ name: string; file: string }> {
  if (!fs.existsSync(migrationsDir)) return [];
  return fs
    .readdirSync(migrationsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({
      name: entry.name,
      file: path.join(migrationsDir, entry.name, 'migration.sql'),
    }))
    .filter((migration) => fs.existsSync(migration.file))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Divide un script SQL en sentencias.
 * Los archivos generados por Prisma no llevan procedimientos ni triggers con
 * `;` interno, pero se ignoran las lineas de comentario para no confundir.
 */
export function splitStatements(sql: string): string[] {
  return sql
    .split(/;\s*(?:\r?\n|$)/)
    .map((statement) =>
      statement
        .split('\n')
        .filter((line) => !line.trim().startsWith('--'))
        .join('\n')
        .trim(),
    )
    .filter((statement) => statement.length > 0);
}

/** Ejecuta las migraciones pendientes. */
export async function runMigrations(options: RunnerOptions): Promise<MigrateResult> {
  const log = options.log ?? (() => undefined);
  const migrations = discoverMigrations(options.migrationsDir);
  if (!migrations.length) {
    log(`[migrate] no hay migraciones en ${path.basename(options.migrationsDir)}`);
    return { applied: [], skipped: [] };
  }

  const done = await options.applied();
  const result: MigrateResult = { applied: [], skipped: [] };

  for (const migration of migrations) {
    if (done.has(migration.name)) {
      result.skipped.push(migration.name);
      continue;
    }
    const sql = fs.readFileSync(migration.file, 'utf8');
    const statements = splitStatements(sql);
    try {
      await options.execute(sql);
      await options.markApplied(migration.name, statements.length);
      result.applied.push(migration.name);
      log(`[migrate] aplicada ${migration.name} (${statements.length} sentencias)`);
    } catch (err) {
      result.failed = { name: migration.name, error: (err as Error).message };
      log(`[migrate] FALLO ${migration.name}: ${(err as Error).message}`);
      return result;
    }
  }

  if (!result.applied.length) log('[migrate] todo al dia');
  return result;
}
