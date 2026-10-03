import { PrismaClient } from '@prisma/client';
import { env } from '../config/env';

/**
 * Cliente Prisma unico. En dev se reutiliza la instancia entre reloads (tsx watch)
 * para no agotar conexiones a SQLite.
 */
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

/**
 * URL de conexion.
 *
 * Importante: en SQLite NO se anaden parametros de query a la URL. El CLI de
 * Prisma (migrate deploy / db push) usa exactamente el mismo DATABASE_URL, y una
 * URL con "?parametros" puede resolverse a un archivo distinto al del servidor.
 * El ajuste fino de concurrencia se hace con PRAGMA (ver applySqlitePragmas).
 */
function connectionUrl(): string {
  return env.DATABASE_URL;
}

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    datasources: { db: { url: connectionUrl() } },
    log: env.isProd ? ['error'] : ['error', 'warn'],
  });

if (!env.isProd) globalForPrisma.prisma = prisma;

/**
 * PRAGMA iniciales (solo SQLite) para tolerar accesos concurrentes del bot
 * y del panel web. Se ejecuta una vez por proceso.
 *
 * Nota: `PRAGMA ...` devuelve filas, por lo que debe ejecutarse con
 * $queryRawUnsafe (con $executeRawUnsafe Prisma lanza "Execute returned results").
 */
let pragmasApplied = false;
export async function applySqlitePragmas(): Promise<void> {
  if (pragmasApplied || !env.DATABASE_URL.startsWith('file:')) return;
  pragmasApplied = true;
  try {
    await prisma.$queryRawUnsafe('PRAGMA journal_mode = WAL;');
    await prisma.$queryRawUnsafe('PRAGMA busy_timeout = 10000;');
    await prisma.$queryRawUnsafe('PRAGMA foreign_keys = ON;');
    await prisma.$queryRawUnsafe('PRAGMA synchronous = NORMAL;');
  } catch (err) {
    console.warn('[db] no se pudieron aplicar los PRAGMA de SQLite:', (err as Error).message);
  }
}

export type Prisma = typeof prisma;
