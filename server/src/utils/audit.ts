import type { FastifyRequest } from 'fastify';
import { prisma } from '../db/prisma';

/** Registro de auditoria (nunca rompe la peticion del usuario si falla). */
export async function audit(
  request: FastifyRequest,
  entry: { action: string; entity?: string; entityId?: string; metadata?: unknown; userId?: string },
): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: {
        userId: entry.userId ?? request.auth?.userId ?? null,
        action: entry.action,
        entity: entry.entity ?? null,
        entityId: entry.entityId ?? null,
        metadata: entry.metadata ? JSON.stringify(entry.metadata) : null,
        ip: request.ip ?? null,
      },
    });
  } catch (err) {
    request.log.warn({ err }, 'no se pudo escribir el log de auditoria');
  }
}
