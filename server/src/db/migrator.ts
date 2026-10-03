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
  /** Migraciones registradas pero sin sentencias aplicadas (adoptadas). */
  unverified?: Set<string>;
  /** Registra una migracion como aplicada. */
  markApplied: (name: string, statements: number) => Promise<void>;
  log?: (message: string) => void;
  /** Se invoca con la migracion y el error para poder registrarlo con detalle. */
  onStatementError?: (migration: string, error: string) => void;
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
    // Una migracion registrada con 0 sentencias significa que fue ADOPTADA por
    // una version anterior (se marco como aplicada sin ejecutarla) o que su
    // contenido no se pudo aplicar. En ambos casos hay que intentarla de nuevo:
    // el aplicador es idempotente, asi que si ya estaba hecha no pasa nada.
    const adoptadaSinEjecutar = options.unverified?.has(migration.name) ?? false;
    if (done.has(migration.name) && !adoptadaSinEjecutar) {
      result.skipped.push(migration.name);
      continue;
    }
    if (adoptadaSinEjecutar) {
      log(`[migrate] ${migration.name} figuraba aplicada sin ejecutarse: se verifica`);
    }
    const sql = fs.readFileSync(migration.file, 'utf8');
    const statements = splitStatements(sql);
    try {
      await options.execute(sql);
      await options.markApplied(migration.name, statements.length);
      result.applied.push(migration.name);
      log(`[migrate] aplicada ${migration.name} (${statements.length} sentencias)`);
    } catch (err) {
      const mensaje = (err as Error).message;
      result.failed = { name: migration.name, error: mensaje };
      log(`[migrate] FALLO ${migration.name}: ${mensaje}`);
      // Se registra la sentencia concreta: sin esto, un fallo de migracion deja
      // la base a medias y el error solo aparece despues como 500 en la API.
      if (options.onStatementError) options.onStatementError(migration.name, mensaje);
      return result;
    }
  }

  if (!result.applied.length) log('[migrate] todo al dia');
  return result;
}

// ---------------------------------------------------------------------------
// Verificacion del esquema
// ---------------------------------------------------------------------------

export interface SchemaCheck {
  ok: boolean;
  /** Tablas o columnas que faltan respecto al modelo actual. */
  missing: string[];
}

/**
 * Comprueba que la base tenga lo que el modelo necesita.
 *
 * Motivo: si una migracion falla (o la imagen se construye con el modelo nuevo
 * pero la BD no migra), Prisma empieza a devolver P2021/P2022 en cada consulta y
 * el panel se llena de 500 mientras `/health` sigue diciendo "ok". Aqui se
 * detecta ANTES de servir trafico, para poder repararlo y avisar.
 */
export async function verifySchema(
  query: (sql: string) => Promise<unknown[]>,
  dialect: SqlDialect,
): Promise<SchemaCheck> {
  const missing: string[] = [];

  // Tablas que debe tener el modelo actual.
  const requiredTables = [
    'roles', 'users', 'clients', 'projects', 'task_types', 'tasks',
    'time_entries', 'pauses', 'system_settings', 'auth_sessions',
  ];

  if (dialect === 'mysql') {
    const filas = (await query(
      'SELECT table_name AS t FROM information_schema.tables WHERE table_schema = DATABASE()',
    )) as Array<{ t: string }>;
    const existentes = new Set(filas.map((f) => String(f.t).toLowerCase()));
    for (const tabla of requiredTables) {
      if (!existentes.has(tabla)) missing.push(`tabla:${tabla}`);
    }
    const columnas = (await query(
      'SELECT table_name AS t, column_name AS c FROM information_schema.columns WHERE table_schema = DATABASE()',
    )) as Array<{ t: string; c: string }>;
    const tiene = (tabla: string, col: string) =>
      columnas.some((k) => String(k.t).toLowerCase() === tabla && String(k.c).toLowerCase() === col);
    if (!tiene('time_entries', 'taskid')) missing.push('columna:time_entries.taskId');
  } else {
    // SQLite: sqlite_master para tablas y PRAGMA para columnas.
    const tablas = (await query(
      "SELECT name AS t FROM sqlite_master WHERE type = 'table'",
    )) as Array<{ t: string }>;
    const existentes = new Set(tablas.map((f) => String(f.t).toLowerCase()));
    for (const tabla of requiredTables) {
      if (!existentes.has(tabla)) missing.push(`tabla:${tabla}`);
    }
    if (existentes.has('time_entries')) {
      const cols = (await query('PRAGMA table_info(time_entries)')) as Array<{ name: string }>;
      if (!cols.some((c) => String(c.name).toLowerCase() === 'taskid')) missing.push('columna:time_entries.taskId');
    }
  }

  return { ok: missing.length === 0, missing };
}


// ---------------------------------------------------------------------------
// Aplicacion idempotente
// ---------------------------------------------------------------------------

export interface IdempotentOptions {
  /** Ejecuta una sentencia SQL. */
  run: (sql: string) => Promise<void>;
  /** Devuelve true si ese objeto ya existe (tabla, columna o indice). */
  exists: (kind: 'table' | 'column' | 'index', name: string) => Promise<boolean>;
  log?: (message: string) => void;
}

/**
 * Ejecuta las sentencias de una migracion saltando las que ya estan aplicadas.
 *
 * Por que: la adopcion de una base ya creada marca las migraciones como
 * aplicadas sin conocer sus efectos, y si esa base estaba a medias (por ejemplo
 * sin la tabla `tasks`) la migracion no se reintentaba NUNCA: el panel quedaba
 * en 500 permanente mientras `/health` decia "ok". Siendo idempotente, la
 * migracion se puede reejecutar y repara el esquema por si sola.
 *
 * Se reconocen las formas que genera Prisma:
 *   CREATE TABLE [IF NOT EXISTS] `x` / "x"   ·  ALTER TABLE `t` ADD COLUMN `c`
 *   CREATE [UNIQUE] INDEX `i` ON `t`(...)    ·  ALTER TABLE `t` ADD CONSTRAINT `i`
 */
export async function applyMigrationIdempotent(sql: string, options: IdempotentOptions): Promise<{ run: number; skipped: number }> {
  const log = options.log ?? (() => undefined);
  const statements = splitStatements(sql);
  let ejecutadas = 0;
  let saltadas = 0;

  for (const statement of statements) {
    const nombre = (patron: RegExp): string | null => {
      const m = statement.match(patron);
      return m ? m[1]! : null;
    };

    const crearTabla = nombre(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?[`"]?([\w.]+)[`"]?/i);
    if (crearTabla && (await options.exists('table', crearTabla))) {
      saltadas++;
      continue;
    }

    const agregarColumna = statement.match(/ALTER\s+TABLE\s+[`"]?([\w.]+)[`"]?\s+ADD\s+(?:COLUMN\s+)?[`"]?([\w.]+)[`"]?/i);
    if (agregarColumna && !/ADD\s+CONSTRAINT|ADD\s+FOREIGN/i.test(statement)) {
      if (await options.exists('column', `${agregarColumna[1]}.${agregarColumna[2]}`)) {
        saltadas++;
        continue;
      }
    }

    const crearIndice =
      nombre(/CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?[`"]?([\w.]+)[`"]?/i) ??
      nombre(/ALTER\s+TABLE\s+[`"]?[\w.]+[`"]?\s+ADD\s+CONSTRAINT\s+[`"]?([\w.]+)[`"]?/i);
    if (crearIndice && (await options.exists('index', crearIndice))) {
      saltadas++;
      continue;
    }

    await options.run(statement);
    ejecutadas++;
  }

  log(`[migrate] ${ejecutadas} sentencia(s) aplicadas, ${saltadas} ya estaban`);
  return { run: ejecutadas, skipped: saltadas };
}
