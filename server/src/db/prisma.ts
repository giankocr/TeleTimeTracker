import type { PrismaClient } from '@prisma/client';
import { env } from '../config/env';

/**
 * Cliente Prisma unico, cargado de forma PEREZOSA.
 *
 * ¿Por que perezoso? El cliente de Prisma se genera PARA UN MOTOR concreto y se
 * guarda en `node_modules/.prisma/client`. La imagen Docker se compila con el
 * esquema base (SQLite); si en runtime se configura MySQL, ese cliente no sirve
 * y Prisma falla con «the URL must start with the protocol `file:`».
 *
 * El arranque (config/bootstrap.ts) regenera el cliente cuando detecta que no
 * corresponde al motor configurado. Para que esa regeneracion sea efectiva, el
 * paquete `@prisma/client` NO debe haberse importado antes: si ya se importo,
 * Node cachea el modulo y seguiria usando el cliente viejo. De ahi el Proxy:
 * el PrismaClient real solo se construye en el primer acceso a una propiedad.
 *
 * En dev ademas se reutiliza la instancia entre recargas (tsx watch).
 */
const globalForPrisma = globalThis as unknown as {
  prisma?: PrismaClient;
  prismaCtor?: typeof PrismaClient;
};

let instance: PrismaClient | null = null;

/** Construye (una sola vez) el cliente real. */
function client(): PrismaClient {
  if (globalForPrisma.prisma) return globalForPrisma.prisma;
  if (instance) return instance;

  // Importacion diferida: se resuelve DESPUES de un posible `prisma generate`.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const mod = require('@prisma/client') as typeof import('@prisma/client');
  const PrismaClientCtor = globalForPrisma.prismaCtor ?? mod.PrismaClient;

  instance = new PrismaClientCtor({
    datasources: { db: { url: env.DATABASE_URL } },
    log: env.isProd ? ['error'] : ['error', 'warn'],
  });

  if (!env.isProd) globalForPrisma.prisma = instance;
  return instance;
}

/**
 * Proxy que expone el cliente sin construirlo hasta el primer uso.
 * `prisma.user.findMany()` y `prisma.$queryRaw` funcionan igual que antes.
 */
export const prisma: PrismaClient = new Proxy({} as PrismaClient, {
  get(_target, prop, receiver) {
    const real = client() as unknown as Record<string | symbol, unknown>;
    const value = Reflect.get(real, prop, receiver);
    return typeof value === 'function' ? value.bind(real) : value;
  },
  has(_target, prop) {
    return prop in (client() as object);
  },
});

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

export type Prisma = PrismaClient;
