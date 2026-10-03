import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../db/prisma';
import { PERMISSIONS } from '../../../shared/types';
import { authenticate, hasPermission, requirePermission } from '../middleware/auth';
import { audit } from '../utils/audit';

/**
 * CRUD de clientes y sus proyectos.
 * Cada proyecto puede tener: repos de GitHub, presupuesto de horas, tarifa
 * y un equipo de miembros (ProjectMember).
 */
export default async function clientRoutes(app: FastifyInstance): Promise<void> {
  // =========================================================================
  // CLIENTES
  // =========================================================================
  app.get('/clients', { preHandler: [authenticate] }, async (request, reply) => {
    const q = z
      .object({
        search: z.string().max(120).optional(),
        isActive: z.enum(['true', 'false']).optional(),
        withStats: z.enum(['true', 'false']).optional(),
      })
      .safeParse(request.query);
    const filters = q.success ? q.data : {};

    const clients = await prisma.client.findMany({
      where: {
        ...(filters.isActive ? { isActive: filters.isActive === 'true' } : {}),
        ...(filters.search ? { name: { contains: filters.search } } : {}),
      },
      include: {
        _count: { select: { projects: true, entries: true } },
        projects: { select: { id: true, name: true, isActive: true } },
      },
      orderBy: { name: 'asc' },
    });

    // Horas acumuladas por cliente (ultimos 30 dias) para el panel.
    let hoursByClient: Record<string, number> = {};
    if (filters.withStats === 'true') {
      const since = new Date(Date.now() - 30 * 24 * 3600 * 1000);
      const grouped = await prisma.timeEntry.groupBy({
        by: ['clientId'],
        where: { startedAt: { gte: since }, status: { not: 'CANCELLED' } },
        _sum: { durationSec: true },
      });
      hoursByClient = Object.fromEntries(grouped.map((g) => [g.clientId ?? 'none', Math.round(((g._sum.durationSec ?? 0) / 3600) * 100) / 100]));
    }

    return reply.send({
      clients: clients.map((c) => ({
        id: c.id,
        name: c.name,
        code: c.code,
        notes: c.notes,
        isActive: c.isActive,
        projectsCount: c._count.projects,
        entriesCount: c._count.entries,
        projects: c.projects,
        hours30d: hoursByClient[c.id] ?? 0,
        createdAt: c.createdAt.toISOString(),
      })),
    });
  });

  app.post('/clients', { preHandler: [requirePermission(PERMISSIONS.CLIENTS_WRITE)] }, async (request, reply) => {
    const parsed = z
      .object({
        name: z.string().min(2).max(120),
        code: z.string().max(40).nullable().optional(),
        notes: z.string().max(1000).nullable().optional(),
        isActive: z.boolean().optional(),
      })
      .safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'Datos invalidos' });

    const dup = await prisma.client.findUnique({ where: { name: parsed.data.name } });
    if (dup) return reply.code(409).send({ error: 'Ya existe un cliente con ese nombre' });

    const client = await prisma.client.create({ data: parsed.data });
    await audit(request, { action: 'client.create', entity: 'client', entityId: client.id });
    return reply.code(201).send({ client });
  });

  app.patch('/clients/:id', { preHandler: [requirePermission(PERMISSIONS.CLIENTS_WRITE)] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = z
      .object({
        name: z.string().min(2).max(120).optional(),
        code: z.string().max(40).nullable().optional(),
        notes: z.string().max(1000).nullable().optional(),
        isActive: z.boolean().optional(),
      })
      .safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'Datos invalidos' });

    const client = await prisma.client.update({ where: { id }, data: parsed.data });
    await audit(request, { action: 'client.update', entity: 'client', entityId: id, metadata: parsed.data });
    return reply.send({ client });
  });

  app.delete('/clients/:id', { preHandler: [requirePermission(PERMISSIONS.CLIENTS_DELETE)] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const { hard } = request.query as { hard?: string };
    const entries = await prisma.timeEntry.count({ where: { clientId: id } });

    if (hard === '1') {
      await prisma.client.delete({ where: { id } });
      await audit(request, { action: 'client.delete_hard', entity: 'client', entityId: id });
      return reply.send({ ok: true, deleted: true });
    }
    await prisma.client.update({ where: { id }, data: { isActive: false } });
    await audit(request, { action: 'client.deactivate', entity: 'client', entityId: id });
    return reply.send({ ok: true, deactivated: true, hint: entries ? `Este cliente tiene ${entries} registros de tiempo asociados.` : undefined });
  });

  // =========================================================================
  // PROYECTOS
  // =========================================================================
  app.get('/projects', { preHandler: [authenticate] }, async (request, reply) => {
    const q = z
      .object({
        clientId: z.string().optional(),
        search: z.string().max(120).optional(),
        isActive: z.enum(['true', 'false']).optional(),
        mine: z.enum(['true', 'false']).optional(),
      })
      .safeParse(request.query);
    const filters = q.success ? q.data : {};
    const auth = request.auth!;

    const projects = await prisma.clientProject.findMany({
      where: {
        ...(filters.clientId ? { clientId: filters.clientId } : {}),
        ...(filters.isActive ? { isActive: filters.isActive === 'true' } : {}),
        ...(filters.search ? { name: { contains: filters.search } } : {}),
        ...(filters.mine === 'true' ? { members: { some: { userId: auth.userId } } } : {}),
      },
      include: {
        client: { select: { id: true, name: true, isActive: true } },
        members: {
          include: { user: { select: { id: true, fullName: true, email: true } } },
        },
        _count: { select: { entries: true } },
      },
      orderBy: [{ client: { name: 'asc' } }, { name: 'asc' }],
    });

    const since = new Date(Date.now() - 30 * 24 * 3600 * 1000);
    const grouped = await prisma.timeEntry.groupBy({
      by: ['projectId'],
      where: { startedAt: { gte: since }, status: { not: 'CANCELLED' } },
      _sum: { durationSec: true },
    });
    const hoursByProject = Object.fromEntries(
      grouped.map((g) => [g.projectId ?? 'none', Math.round(((g._sum.durationSec ?? 0) / 3600) * 100) / 100]),
    );

    return reply.send({
      projects: projects.map((p) => ({
        id: p.id,
        name: p.name,
        description: p.description,
        isActive: p.isActive,
        clientId: p.clientId,
        clientName: p.client.name,
        githubRepos: p.githubRepos,
        budgetHours: p.budgetHours,
        hourlyRate: p.hourlyRate,
        entriesCount: p._count.entries,
        hours30d: hoursByProject[p.id] ?? 0,
        members: p.members.map((m) => ({ id: m.user.id, fullName: m.user.fullName, email: m.user.email, role: m.role })),
      })),
    });
  });

  app.post('/projects', { preHandler: [requirePermission(PERMISSIONS.PROJECTS_WRITE)] }, async (request, reply) => {
    const parsed = z
      .object({
        clientId: z.string().min(1),
        name: z.string().min(2).max(120),
        description: z.string().max(1000).nullable().optional(),
        githubRepos: z.string().max(500).nullable().optional(),
        budgetHours: z.number().positive().nullable().optional(),
        hourlyRate: z.number().nonnegative().nullable().optional(),
        memberIds: z.array(z.string()).optional(),
        isActive: z.boolean().optional(),
      })
      .safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'Datos invalidos' });
    const d = parsed.data;

    const client = await prisma.client.findUnique({ where: { id: d.clientId } });
    if (!client) return reply.code(400).send({ error: 'Cliente inexistente' });

    const project = await prisma.clientProject.create({
      data: {
        clientId: d.clientId,
        name: d.name,
        description: d.description ?? null,
        githubRepos: d.githubRepos ?? null,
        budgetHours: d.budgetHours ?? null,
        hourlyRate: d.hourlyRate ?? null,
        isActive: d.isActive ?? true,
        ...(d.memberIds?.length
          ? { members: { create: d.memberIds.map((userId) => ({ userId })) } }
          : {}),
      },
      include: { client: true, members: { include: { user: { select: { id: true, fullName: true } } } } },
    });

    // Si el creador tiene permiso de escritura y no es admin, se agrega como miembro.
    const auth = request.auth!;
    if (!hasPermission(auth, PERMISSIONS.REPORTS_ALL)) {
      await prisma.projectMember.upsert({
        where: { projectId_userId: { projectId: project.id, userId: auth.userId } },
        create: { projectId: project.id, userId: auth.userId, role: 'OWNER' },
        update: { role: 'OWNER' },
      });
    }

    await audit(request, { action: 'project.create', entity: 'project', entityId: project.id });
    return reply.code(201).send({ project });
  });

  app.patch('/projects/:id', { preHandler: [requirePermission(PERMISSIONS.PROJECTS_WRITE)] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = z
      .object({
        name: z.string().min(2).max(120).optional(),
        description: z.string().max(1000).nullable().optional(),
        githubRepos: z.string().max(500).nullable().optional(),
        budgetHours: z.number().positive().nullable().optional(),
        hourlyRate: z.number().nonnegative().nullable().optional(),
        isActive: z.boolean().optional(),
        memberIds: z.array(z.string()).optional(),
      })
      .safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'Datos invalidos' });
    const d = parsed.data;

    if (d.memberIds) {
      await prisma.projectMember.deleteMany({ where: { projectId: id, userId: { notIn: d.memberIds } } });
      for (const userId of d.memberIds) {
        await prisma.projectMember.upsert({
          where: { projectId_userId: { projectId: id, userId } },
          create: { projectId: id, userId },
          update: {},
        });
      }
    }

    const project = await prisma.clientProject.update({
      where: { id },
      data: {
        ...(d.name !== undefined ? { name: d.name } : {}),
        ...(d.description !== undefined ? { description: d.description } : {}),
        ...(d.githubRepos !== undefined ? { githubRepos: d.githubRepos } : {}),
        ...(d.budgetHours !== undefined ? { budgetHours: d.budgetHours } : {}),
        ...(d.hourlyRate !== undefined ? { hourlyRate: d.hourlyRate } : {}),
        ...(d.isActive !== undefined ? { isActive: d.isActive } : {}),
      },
      include: { client: true, members: { include: { user: { select: { id: true, fullName: true } } } } },
    });
    await audit(request, { action: 'project.update', entity: 'project', entityId: id });
    return reply.send({ project });
  });

  app.delete('/projects/:id', { preHandler: [requirePermission(PERMISSIONS.PROJECTS_DELETE)] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const { hard } = request.query as { hard?: string };
    if (hard === '1') {
      await prisma.clientProject.delete({ where: { id } });
      await audit(request, { action: 'project.delete_hard', entity: 'project', entityId: id });
      return reply.send({ ok: true, deleted: true });
    }
    await prisma.clientProject.update({ where: { id }, data: { isActive: false } });
    await audit(request, { action: 'project.deactivate', entity: 'project', entityId: id });
    return reply.send({ ok: true, deactivated: true });
  });

  // =========================================================================
  // TIPOS DE TAREA (globales, alimentan el NLU del bot)
  // =========================================================================
  app.get('/task-types', { preHandler: [authenticate] }, async (_request, reply) => {
    const types = await prisma.taskType.findMany({ orderBy: { name: 'asc' } });
    return reply.send({ taskTypes: types });
  });

  app.post('/task-types', { preHandler: [requirePermission(PERMISSIONS.TASKTYPES_WRITE)] }, async (request, reply) => {
    const parsed = z
      .object({
        name: z.string().min(2).max(60),
        aliases: z.string().max(300).optional(),
        color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
        billable: z.boolean().optional(),
      })
      .safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'Datos invalidos' });

    const type = await prisma.taskType.create({
      data: {
        name: parsed.data.name,
        aliases: parsed.data.aliases ?? '',
        color: parsed.data.color ?? '#6366f1',
        billable: parsed.data.billable ?? true,
      },
    });
    await audit(request, { action: 'tasktype.create', entity: 'taskType', entityId: type.id });
    return reply.code(201).send({ taskType: type });
  });

  app.patch('/task-types/:id', { preHandler: [requirePermission(PERMISSIONS.TASKTYPES_WRITE)] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = z
      .object({
        name: z.string().min(2).max(60).optional(),
        aliases: z.string().max(300).optional(),
        color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
        billable: z.boolean().optional(),
        isActive: z.boolean().optional(),
      })
      .safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'Datos invalidos' });

    const type = await prisma.taskType.update({ where: { id }, data: parsed.data });
    await audit(request, { action: 'tasktype.update', entity: 'taskType', entityId: id });
    return reply.send({ taskType: type });
  });

  app.delete('/task-types/:id', { preHandler: [requirePermission(PERMISSIONS.TASKTYPES_WRITE)] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    await prisma.taskType.update({ where: { id }, data: { isActive: false } });
    await audit(request, { action: 'tasktype.deactivate', entity: 'taskType', entityId: id });
    return reply.send({ ok: true });
  });

  // =========================================================================
  // TAREAS PENDIENTES (alimentan la alerta diaria del bot)
  // =========================================================================
  app.get('/pending-tasks', { preHandler: [authenticate] }, async (request, reply) => {
    const q = z.object({ userId: z.string().optional(), includeDone: z.enum(['true', 'false']).optional() }).safeParse(request.query);
    const auth = request.auth!;
    const targetUserId = q.success && q.data.userId ? q.data.userId : auth.userId;

    if (targetUserId !== auth.userId && !hasPermission(auth, PERMISSIONS.REPORTS_TEAM)) {
      return reply.code(403).send({ error: 'Sin acceso a las tareas de otro usuario' });
    }

    const tasks = await prisma.pendingTask.findMany({
      where: {
        userId: targetUserId,
        ...(q.success && q.data.includeDone === 'true' ? {} : { isDone: false }),
      },
      orderBy: [{ isDone: 'asc' }, { priority: 'desc' }, { dueDate: 'asc' }],
      take: 200,
    });
    return reply.send({ tasks });
  });

  app.post('/pending-tasks', { preHandler: [authenticate] }, async (request, reply) => {
    const parsed = z
      .object({
        title: z.string().min(2).max(200),
        notes: z.string().max(1000).nullable().optional(),
        projectId: z.string().nullable().optional(),
        priority: z.enum(['LOW', 'NORMAL', 'HIGH']).optional(),
        dueDate: z.string().nullable().optional(),
        userId: z.string().optional(),
      })
      .safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'Datos invalidos' });
    const auth = request.auth!;
    const userId = parsed.data.userId ?? auth.userId;
    if (userId !== auth.userId && !hasPermission(auth, PERMISSIONS.REPORTS_TEAM)) {
      return reply.code(403).send({ error: 'No puedes crear tareas para otro usuario' });
    }

    const task = await prisma.pendingTask.create({
      data: {
        userId,
        title: parsed.data.title,
        notes: parsed.data.notes ?? null,
        projectId: parsed.data.projectId ?? null,
        priority: parsed.data.priority ?? 'NORMAL',
        dueDate: parsed.data.dueDate ? new Date(parsed.data.dueDate) : null,
      },
    });
    return reply.code(201).send({ task });
  });

  app.patch('/pending-tasks/:id', { preHandler: [authenticate] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = z
      .object({
        title: z.string().min(2).max(200).optional(),
        notes: z.string().max(1000).nullable().optional(),
        priority: z.enum(['LOW', 'NORMAL', 'HIGH']).optional(),
        dueDate: z.string().nullable().optional(),
        projectId: z.string().nullable().optional(),
        isDone: z.boolean().optional(),
      })
      .safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'Datos invalidos' });

    const existing = await prisma.pendingTask.findUnique({ where: { id } });
    if (!existing) return reply.code(404).send({ error: 'Tarea no encontrada' });
    if (existing.userId !== request.auth!.userId && !hasPermission(request.auth!, PERMISSIONS.REPORTS_TEAM)) {
      return reply.code(403).send({ error: 'Sin acceso' });
    }

    const task = await prisma.pendingTask.update({
      where: { id },
      data: {
        ...(parsed.data.title !== undefined ? { title: parsed.data.title } : {}),
        ...(parsed.data.notes !== undefined ? { notes: parsed.data.notes } : {}),
        ...(parsed.data.priority !== undefined ? { priority: parsed.data.priority } : {}),
        ...(parsed.data.projectId !== undefined ? { projectId: parsed.data.projectId } : {}),
        ...(parsed.data.dueDate !== undefined ? { dueDate: parsed.data.dueDate ? new Date(parsed.data.dueDate) : null } : {}),
        ...(parsed.data.isDone !== undefined
          ? { isDone: parsed.data.isDone, completedAt: parsed.data.isDone ? new Date() : null }
          : {}),
      },
    });
    return reply.send({ task });
  });

  app.delete('/pending-tasks/:id', { preHandler: [authenticate] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const existing = await prisma.pendingTask.findUnique({ where: { id } });
    if (!existing) return reply.code(404).send({ error: 'Tarea no encontrada' });
    if (existing.userId !== request.auth!.userId && !hasPermission(request.auth!, PERMISSIONS.REPORTS_TEAM)) {
      return reply.code(403).send({ error: 'Sin acceso' });
    }
    await prisma.pendingTask.delete({ where: { id } });
    return reply.send({ ok: true });
  });
}
