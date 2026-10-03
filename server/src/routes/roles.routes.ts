import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../db/prisma';
import { ALL_PERMISSIONS, PERMISSIONS } from '../../../shared/types';
import { authenticate, requirePermission } from '../middleware/auth';
import { audit } from '../utils/audit';

/** CRUD de roles (RBAC). Los roles de sistema no se pueden borrar ni renombrar su key. */
export default async function roleRoutes(app: FastifyInstance): Promise<void> {
  app.get('/', { preHandler: [authenticate] }, async (_request, reply) => {
    const roles = await prisma.role.findMany({
      orderBy: { key: 'asc' },
      include: { _count: { select: { users: true } } },
    });
    return reply.send({
      roles: roles.map((r) => ({
        id: r.id,
        key: r.key,
        name: r.name,
        description: r.description,
        permissions: r.permissions.split(',').map((p) => p.trim()).filter(Boolean),
        isSystem: r.isSystem,
        usersCount: r._count.users,
      })),
      availablePermissions: ALL_PERMISSIONS,
    });
  });

  app.post('/', { preHandler: [requirePermission(PERMISSIONS.ROLES_WRITE)] }, async (request, reply) => {
    const parsed = z
      .object({
        key: z.string().regex(/^[A-Z][A-Z0-9_]{1,29}$/, 'La clave debe ser MAYUSCULAS (ej. SUPERVISOR)'),
        name: z.string().min(2).max(80),
        description: z.string().max(240).optional(),
        permissions: z.array(z.string()).default([]),
      })
      .safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'Datos invalidos' });

    const exists = await prisma.role.findUnique({ where: { key: parsed.data.key } });
    if (exists) return reply.code(409).send({ error: 'Ya existe un rol con esa clave' });

    const role = await prisma.role.create({
      data: {
        key: parsed.data.key,
        name: parsed.data.name,
        description: parsed.data.description ?? null,
        permissions: parsed.data.permissions.join(','),
        isSystem: false,
      },
    });
    await audit(request, { action: 'role.create', entity: 'role', entityId: role.id, metadata: parsed.data });
    return reply.code(201).send({ role });
  });

  app.patch('/:id', { preHandler: [requirePermission(PERMISSIONS.ROLES_WRITE)] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = z
      .object({
        name: z.string().min(2).max(80).optional(),
        description: z.string().max(240).nullable().optional(),
        permissions: z.array(z.string()).optional(),
      })
      .safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'Datos invalidos' });

    const role = await prisma.role.findUnique({ where: { id } });
    if (!role) return reply.code(404).send({ error: 'Rol no encontrado' });
    if (role.key === 'ADMIN' && parsed.data.permissions && !parsed.data.permissions.includes('*')) {
      return reply.code(400).send({ error: 'El rol ADMIN siempre debe conservar el permiso "*"' });
    }

    const updated = await prisma.role.update({
      where: { id },
      data: {
        ...(parsed.data.name !== undefined ? { name: parsed.data.name } : {}),
        ...(parsed.data.description !== undefined ? { description: parsed.data.description } : {}),
        ...(parsed.data.permissions !== undefined ? { permissions: parsed.data.permissions.join(',') } : {}),
      },
    });
    await audit(request, { action: 'role.update', entity: 'role', entityId: id, metadata: parsed.data });
    return reply.send({ role: updated });
  });

  app.delete('/:id', { preHandler: [requirePermission(PERMISSIONS.ROLES_WRITE)] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const role = await prisma.role.findUnique({ where: { id }, include: { _count: { select: { users: true } } } });
    if (!role) return reply.code(404).send({ error: 'Rol no encontrado' });
    if (role.isSystem) return reply.code(400).send({ error: 'Los roles de sistema no se pueden eliminar' });
    if (role._count.users > 0) {
      return reply.code(400).send({ error: `Hay ${role._count.users} usuario(s) con este rol. Reasignalos primero.` });
    }
    await prisma.role.delete({ where: { id } });
    await audit(request, { action: 'role.delete', entity: 'role', entityId: id });
    return reply.send({ ok: true });
  });
}
