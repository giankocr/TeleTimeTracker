import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticate } from '../middleware/auth';
import { createApiToken, listUserApiTokens, revokeApiToken } from '../services/api-token.service';
import { audit } from '../utils/audit';

/**
 * Rutas de gestion de API tokens personales.
 * Los usuarios pueden crear, listar y revocar sus propios tokens.
 */
export default async function apiTokensRoutes(app: FastifyInstance): Promise<void> {
  // -------------------------------------------------------------------------
  // GET /api/tokens — lista los tokens del usuario actual
  // -------------------------------------------------------------------------
  app.get('/', { preHandler: [authenticate] }, async (request, reply) => {
    const tokens = await listUserApiTokens(request.auth!.userId);
    return reply.send({ tokens });
  });

  // -------------------------------------------------------------------------
  // POST /api/tokens — crea un nuevo token
  // -------------------------------------------------------------------------
  app.post('/', { preHandler: [authenticate] }, async (request, reply) => {
    const parsed = z
      .object({
        name: z.string().min(1).max(100),
        expiresInDays: z.number().int().min(1).max(365).optional(),
      })
      .safeParse(request.body);

    if (!parsed.success) {
      return reply.code(400).send({
        error: parsed.error.issues[0]?.message ?? 'Datos invalidos',
        code: 'INVALID_REQUEST',
      });
    }

    const { name, expiresInDays } = parsed.data;
    const expiresAt = expiresInDays
      ? new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000)
      : undefined;

    const { token, info } = await createApiToken(request.auth!.userId, name, expiresAt);

    await audit(request, {
      action: 'api_tokens.create',
      entity: 'api_token',
      entityId: info.id,
      metadata: { name, expiresAt: info.expiresAt },
    });

    return reply.code(201).send({
      token, // ⚠️ SOLO UNA VEZ - el usuario debe copiarlo
      info,
      message: 'Token creado. Copialo ahora, no volveras a verlo.',
    });
  });

  // -------------------------------------------------------------------------
  // DELETE /api/tokens/:id — revoca (elimina) un token
  // -------------------------------------------------------------------------
  app.delete('/:id', { preHandler: [authenticate] }, async (request, reply) => {
    const parsed = z.object({ id: z.string().min(1) }).safeParse(request.params);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'ID de token invalido', code: 'INVALID_TOKEN_ID' });
    }

    const revoked = await revokeApiToken(parsed.data.id, request.auth!.userId);
    if (!revoked) {
      return reply.code(404).send({ error: 'Token no encontrado', code: 'TOKEN_NOT_FOUND' });
    }

    await audit(request, {
      action: 'api_tokens.revoke',
      entity: 'api_token',
      entityId: parsed.data.id,
    });

    return reply.send({ ok: true, message: 'Token revocado' });
  });
}
