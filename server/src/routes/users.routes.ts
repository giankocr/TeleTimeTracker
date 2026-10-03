import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../db/prisma';
import { PERMISSIONS } from '../../../shared/types';
import { authenticate, hasPermission, hashPassword, requirePermission, validatePasswordStrength, visibleUserIds } from '../middleware/auth';
import { encryptSecret, generateLinkCode, randomToken } from '../config/crypto';
import { formatPhone, normalizePhone } from '../services/telegram-auth.service';
import { revokeAllSessions, serializeUser } from '../services/auth.service';
import { audit } from '../utils/audit';
import { zEmail, zPassword } from '../utils/validators';

/**
 * CRUD de usuarios + asignacion de rol/jerarquia + gestion de Telegram y GitHub.
 * Toda la gestion de cuentas ajenas exige permiso users:write.
 */
export default async function userRoutes(app: FastifyInstance): Promise<void> {
  // -------------------------------------------------------------------------
  // GET /api/users — listado (con alcance por rol)
  // -------------------------------------------------------------------------
  app.get('/', { preHandler: [authenticate] }, async (request, reply) => {
    const query = z
      .object({
        search: z.string().max(120).optional(),
        roleId: z.string().optional(),
        isActive: z.enum(['true', 'false']).optional(),
        scope: z.enum(['all', 'team', 'me']).optional(),
        take: z.coerce.number().int().min(1).max(500).optional(),
        skip: z.coerce.number().int().min(0).optional(),
      })
      .safeParse(request.query);

    const auth = request.auth!;
    const filters = query.success ? query.data : {};
    const canReadAll = hasPermission(auth, PERMISSIONS.USERS_READ);

    const visible = await visibleUserIds(auth);
    const scopeFilter =
      filters.scope === 'me'
        ? { id: auth.userId }
        : canReadAll && (filters.scope === 'all' || visible.all)
          ? {}
          : { id: { in: visible.ids } };

    const where = {
      ...scopeFilter,
      ...(filters.roleId ? { roleId: filters.roleId } : {}),
      ...(filters.isActive ? { isActive: filters.isActive === 'true' } : {}),
      ...(filters.search
        ? {
            OR: [
              { fullName: { contains: filters.search } },
              { email: { contains: filters.search } },
              { telegramUsername: { contains: filters.search } },
            ],
          }
        : {}),
    };

    const [users, total] = await Promise.all([
      prisma.user.findMany({
        where,
        include: { role: true, manager: { select: { fullName: true } } },
        orderBy: [{ isActive: 'desc' }, { fullName: 'asc' }],
        take: filters.take ?? 100,
        skip: filters.skip ?? 0,
      }),
      prisma.user.count({ where }),
    ]);

    return reply.send({ users: users.map(serializeUser), total });
  });

  // -------------------------------------------------------------------------
  // GET /api/users/:id
  // -------------------------------------------------------------------------
  app.get('/:id', { preHandler: [authenticate] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const auth = request.auth!;
    const visible = await visibleUserIds(auth);
    if (!visible.all && !visible.ids.includes(id)) {
      return reply.code(403).send({ error: 'Sin acceso a este usuario' });
    }
    const user = await prisma.user.findUnique({
      where: { id },
      include: {
        role: true,
        manager: { select: { id: true, fullName: true } },
        reports: { select: { id: true, fullName: true, email: true } },
        _count: { select: { timeEntries: true, pendingTasks: true } },
      },
    });
    if (!user) return reply.code(404).send({ error: 'Usuario no encontrado' });
    return reply.send({
      user: serializeUser(user),
      team: user.reports,
      stats: { entries: user._count.timeEntries, pendingTasks: user._count.pendingTasks },
    });
  });

  // -------------------------------------------------------------------------
  // POST /api/users — crear
  // -------------------------------------------------------------------------
  app.post('/', { preHandler: [requirePermission(PERMISSIONS.USERS_WRITE)] }, async (request, reply) => {
    const parsed = z
      .object({
        email: zEmail,
        fullName: z.string().min(2).max(120),
        password: zPassword,
        roleId: z.string().min(1),
        managerId: z.string().nullable().optional(),
        phone: z.string().min(7).max(30).nullable().optional(),
        telegramId: z.string().max(32).nullable().optional(),
        githubUsername: z.string().max(80).nullable().optional(),
        githubToken: z.string().max(300).nullable().optional(),
        timezone: z.string().max(64).optional(),
        workDays: z.array(z.number().int().min(0).max(6)).optional(),
        workStart: z.string().regex(/^\d{2}:\d{2}$/).optional(),
        workEnd: z.string().regex(/^\d{2}:\d{2}$/).optional(),
        idleAlertMin: z.number().int().min(5).max(480).optional(),
        dailyDigest: z.boolean().optional(),
        isActive: z.boolean().optional(),
        sendLinkCode: z.boolean().optional(),
      })
      .safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'Datos invalidos' });
    const d = parsed.data;

    const exists = await prisma.user.findUnique({ where: { email: d.email } });
    if (exists) return reply.code(409).send({ error: 'Ya existe un usuario con ese correo' });

    const role = await prisma.role.findUnique({ where: { id: d.roleId } });
    if (!role) return reply.code(400).send({ error: 'Rol inexistente' });

    if (d.telegramId) {
      const taken = await prisma.user.findUnique({ where: { telegramId: d.telegramId } });
      if (taken) return reply.code(409).send({ error: 'Ese Telegram ID ya esta vinculado a otro usuario' });
    }

    // El telefono se normaliza a E.164: es la clave del acceso "Telefono + codigo".
    const phone = d.phone ? normalizePhone(d.phone) : null;
    if (d.phone && !phone) return reply.code(400).send({ error: 'Numero de telefono invalido' });
    if (phone) {
      const taken = await prisma.user.findUnique({ where: { phone } });
      if (taken) return reply.code(409).send({ error: 'Ese telefono ya esta registrado en otro usuario' });
    }

    const linkCode = d.sendLinkCode === false ? null : generateLinkCode();
    const user = await prisma.user.create({
      data: {
        email: d.email,
        fullName: d.fullName,
        passwordHash: await hashPassword(d.password),
        roleId: d.roleId,
        managerId: d.managerId ?? null,
        phone,
        phoneVerifiedAt: phone ? new Date() : null,
        telegramId: d.telegramId ?? null,
        githubUsername: d.githubUsername ?? null,
        githubToken: d.githubToken ? encryptSecret(d.githubToken) : null,
        timezone: d.timezone ?? 'America/Bogota',
        workDays: d.workDays ? d.workDays.join(',') : '1,2,3,4,5',
        workStart: d.workStart ?? '09:00',
        workEnd: d.workEnd ?? '18:00',
        idleAlertMin: d.idleAlertMin ?? 45,
        dailyDigest: d.dailyDigest ?? true,
        isActive: d.isActive ?? true,
        telegramLinkCode: linkCode,
        telegramLinkExp: linkCode ? new Date(Date.now() + 7 * 24 * 3600 * 1000) : null,
      },
      include: { role: true },
    });

    await audit(request, { action: 'user.create', entity: 'user', entityId: user.id, metadata: { email: user.email, role: role.key } });
    return reply.code(201).send({ user: serializeUser(user), telegramLinkCode: linkCode });
  });

  // -------------------------------------------------------------------------
  // PATCH /api/users/:id — editar
  // -------------------------------------------------------------------------
  app.patch('/:id', { preHandler: [requirePermission(PERMISSIONS.USERS_WRITE)] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = z
      .object({
        email: zEmail.optional(),
        fullName: z.string().min(2).max(120).optional(),
        roleId: z.string().optional(),
        managerId: z.string().nullable().optional(),
        phone: z.string().min(7).max(30).nullable().optional(),
        telegramId: z.string().max(32).nullable().optional(),
        githubUsername: z.string().max(80).nullable().optional(),
        githubToken: z.string().max(300).nullable().optional(),
        timezone: z.string().max(64).optional(),
        workDays: z.array(z.number().int().min(0).max(6)).optional(),
        workStart: z.string().regex(/^\d{2}:\d{2}$/).optional(),
        workEnd: z.string().regex(/^\d{2}:\d{2}$/).optional(),
        idleAlertMin: z.number().int().min(5).max(480).optional(),
        dailyDigest: z.boolean().optional(),
        isActive: z.boolean().optional(),
      })
      .safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'Datos invalidos' });
    const d = parsed.data;

    const target = await prisma.user.findUnique({ where: { id }, include: { role: true } });
    if (!target) return reply.code(404).send({ error: 'Usuario no encontrado' });

    // Evita que un admin se quite a si mismo el acceso.
    if (id === request.auth!.userId && d.isActive === false) {
      return reply.code(400).send({ error: 'No puedes desactivar tu propia cuenta' });
    }
    if (id === request.auth!.userId && d.roleId) {
      const newRole = await prisma.role.findUnique({ where: { id: d.roleId } });
      if (newRole && newRole.key !== 'ADMIN' && target.role.key === 'ADMIN') {
        const admins = await prisma.user.count({ where: { role: { key: 'ADMIN' }, isActive: true } });
        if (admins <= 1) return reply.code(400).send({ error: 'Debe existir al menos un administrador activo' });
      }
    }

    if (d.email && d.email !== target.email) {
      const dup = await prisma.user.findUnique({ where: { email: d.email } });
      if (dup) return reply.code(409).send({ error: 'Ese correo ya esta en uso' });
    }
    if (d.telegramId) {
      const dup = await prisma.user.findUnique({ where: { telegramId: d.telegramId } });
      if (dup && dup.id !== id) return reply.code(409).send({ error: 'Ese Telegram ID ya esta vinculado' });
    }

    const user = await prisma.user.update({
      where: { id },
      data: {
        ...(d.email !== undefined ? { email: d.email } : {}),
        ...(d.fullName !== undefined ? { fullName: d.fullName } : {}),
        ...(d.roleId !== undefined ? { roleId: d.roleId } : {}),
        ...(d.managerId !== undefined ? { managerId: d.managerId } : {}),
        ...(d.phone !== undefined
          ? { phone: d.phone ? normalizePhone(d.phone) : null, phoneVerifiedAt: d.phone ? new Date() : null }
          : {}),
        ...(d.telegramId !== undefined
          ? { telegramId: d.telegramId, telegramLinkedAt: d.telegramId ? new Date() : null }
          : {}),
        ...(d.githubUsername !== undefined ? { githubUsername: d.githubUsername } : {}),
        ...(d.githubToken !== undefined ? { githubToken: d.githubToken ? encryptSecret(d.githubToken) : null } : {}),
        ...(d.timezone !== undefined ? { timezone: d.timezone } : {}),
        ...(d.workDays !== undefined ? { workDays: d.workDays.join(',') } : {}),
        ...(d.workStart !== undefined ? { workStart: d.workStart } : {}),
        ...(d.workEnd !== undefined ? { workEnd: d.workEnd } : {}),
        ...(d.idleAlertMin !== undefined ? { idleAlertMin: d.idleAlertMin } : {}),
        ...(d.dailyDigest !== undefined ? { dailyDigest: d.dailyDigest } : {}),
        ...(d.isActive !== undefined ? { isActive: d.isActive } : {}),
      },
      include: { role: true, manager: { select: { fullName: true } } },
    });

    // Desactivar o cambiar de rol invalida las sesiones abiertas.
    if (d.isActive === false || d.roleId !== undefined) await revokeAllSessions(user.id);

    await audit(request, { action: 'user.update', entity: 'user', entityId: user.id, metadata: d });
    return reply.send({ user: serializeUser(user) });
  });

  // -------------------------------------------------------------------------
  // POST /api/users/:id/reset-password — reseteo por administrador
  // -------------------------------------------------------------------------
  app.post('/:id/reset-password', { preHandler: [requirePermission(PERMISSIONS.USERS_WRITE)] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = z.object({ newPassword: zPassword.optional(), mustChange: z.boolean().optional() }).safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'Datos invalidos' });

    // Si no se envia contrasena se genera una temporal segura.
    const temp = parsed.data.newPassword ?? `${Math.random().toString(36).slice(2, 8)}${Math.floor(Math.random() * 9000 + 1000)}Aa`;
    const strength = validatePasswordStrength(temp);
    if (strength) return reply.code(400).send({ error: strength });

    const user = await prisma.user.update({
      where: { id },
      data: { passwordHash: await hashPassword(temp) },
    });
    await revokeAllSessions(user.id);
    await audit(request, { action: 'user.reset_password', entity: 'user', entityId: id });
    return reply.send({ ok: true, temporaryPassword: temp, message: 'Contrasena reseteada. Compartela por un canal seguro.' });
  });

  // -------------------------------------------------------------------------
  // POST /api/users/:id/telegram/link-code — regenerar codigo de vinculacion
  // -------------------------------------------------------------------------
  app.post('/:id/telegram/link-code', { preHandler: [requirePermission(PERMISSIONS.USERS_WRITE)] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const code = generateLinkCode();
    const expiresAt = new Date(Date.now() + 7 * 24 * 3600 * 1000);
    await prisma.user.update({
      where: { id },
      data: { telegramLinkCode: code, telegramLinkExp: expiresAt },
    });
    await audit(request, { action: 'user.telegram_link_code', entity: 'user', entityId: id });
    return reply.send({ code, expiresAt: expiresAt.toISOString(), instructions: `El usuario debe enviar al bot: /vincular ${code}` });
  });

  // -------------------------------------------------------------------------
  // DELETE /api/users/:id/telegram — quitar vinculacion
  // -------------------------------------------------------------------------
  app.delete('/:id/telegram', { preHandler: [requirePermission(PERMISSIONS.USERS_WRITE)] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    await prisma.user.update({
      where: { id },
      data: { telegramId: null, telegramUsername: null, telegramLinkedAt: null, telegramLinkCode: null },
    });
    await audit(request, { action: 'user.telegram_unlink', entity: 'user', entityId: id });
    return reply.send({ ok: true });
  });

  // -------------------------------------------------------------------------
  // DELETE /api/users/:id — desactivar (soft) o eliminar (hard=1, solo admin)
  // -------------------------------------------------------------------------
  app.delete('/:id', { preHandler: [requirePermission(PERMISSIONS.USERS_DELETE)] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const { hard } = request.query as { hard?: string };

    if (id === request.auth!.userId) return reply.code(400).send({ error: 'No puedes eliminar tu propia cuenta' });

    const target = await prisma.user.findUnique({ where: { id }, include: { role: true } });
    if (!target) return reply.code(404).send({ error: 'Usuario no encontrado' });

    if (target.role.key === 'ADMIN') {
      const admins = await prisma.user.count({ where: { role: { key: 'ADMIN' }, isActive: true } });
      if (admins <= 1) return reply.code(400).send({ error: 'Debe existir al menos un administrador activo' });
    }

    if (hard === '1') {
      // El historial de tiempo se conserva: se reasigna a nadie -> se borra en cascada,
      // por eso se exige confirmacion explicita via query param.
      await prisma.user.delete({ where: { id } });
      await audit(request, { action: 'user.delete_hard', entity: 'user', entityId: id, metadata: { email: target.email } });
      return reply.send({ ok: true, deleted: true });
    }

    await prisma.user.update({ where: { id }, data: { isActive: false, telegramLinkCode: null } });
    await revokeAllSessions(id);
    await audit(request, { action: 'user.deactivate', entity: 'user', entityId: id });
    return reply.send({ ok: true, deactivated: true });
  });

  // =========================================================================
  // SOLICITUDES DE ACCESO DESDE EL BOT
  // Quien comparte su telefono y no tiene cuenta queda aqui en estado PENDING.
  // =========================================================================
  app.get('/bot-contacts', { preHandler: [requirePermission(PERMISSIONS.USERS_READ)] }, async (request, reply) => {
    const q = z
      .object({ status: z.enum(['PENDING', 'LINKED', 'REJECTED', 'all']).optional() })
      .safeParse(request.query);
    const status = q.success ? q.data.status ?? 'PENDING' : 'PENDING';

    const contacts = await prisma.botContact.findMany({
      where: status === 'all' ? {} : { status },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });

    // Se marca si ya existe una cuenta con ese telefono (aprobacion en un clic).
    const phones = contacts.map((c) => c.phone);
    const users = phones.length
      ? await prisma.user.findMany({ where: { phone: { in: phones } }, select: { id: true, phone: true, email: true, fullName: true } })
      : [];
    const byPhone = new Map(users.map((u) => [u.phone, u]));

    return reply.send({
      contacts: contacts.map((c) => ({
        ...c,
        createdAt: c.createdAt.toISOString(),
        updatedAt: c.updatedAt.toISOString(),
        existingUser: byPhone.get(c.phone) ?? null,
      })),
    });
  });

  /** Aprobar (crea el usuario y lo vincula al instante) o rechazar una solicitud. */
  app.patch(
    '/bot-contacts/:id',
    { preHandler: [requirePermission(PERMISSIONS.USERS_WRITE)] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const parsed = z
        .object({
          action: z.enum(['APPROVE', 'REJECT']),
          roleId: z.string().optional(),
          fullName: z.string().min(2).max(120).optional(),
          password: zPassword.optional(),
          managerId: z.string().nullable().optional(),
        })
        .safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'Datos invalidos' });

      const contact = await prisma.botContact.findUnique({ where: { id } });
      if (!contact) return reply.code(404).send({ error: 'Solicitud no encontrada' });

      if (parsed.data.action === 'REJECT') {
        await prisma.botContact.update({ where: { id }, data: { status: 'REJECTED' } });
        await audit(request, { action: 'botcontact.reject', entity: 'botContact', entityId: id });
        return reply.send({ ok: true, rejected: true });
      }

      // --- APROBAR ---
      const existing = await prisma.user.findUnique({ where: { phone: contact.phone }, include: { role: true } });
      if (existing) {
        // Ya hay cuenta con ese telefono: solo se vincula el Telegram.
        const user = await prisma.user.update({
          where: { id: existing.id },
          data: {
            telegramId: contact.telegramId,
            telegramUsername: contact.username ?? null,
            telegramLinkedAt: new Date(),
            phoneVerifiedAt: new Date(),
            isActive: true,
          },
          include: { role: true },
        });
        await prisma.botContact.update({ where: { id }, data: { status: 'LINKED', userId: user.id } });
        await audit(request, { action: 'botcontact.link_existing', entity: 'user', entityId: user.id });
        return reply.send({ ok: true, user: serializeUser(user), linked: true });
      }

      const roleId = parsed.data.roleId;
      if (!roleId) return reply.code(400).send({ error: 'Indica el rol para crear la cuenta (roleId)' });
      const role = await prisma.role.findUnique({ where: { id: roleId } });
      if (!role) return reply.code(400).send({ error: 'Rol inexistente' });

      const taken = await prisma.user.findUnique({ where: { telegramId: contact.telegramId } });
      if (taken) return reply.code(409).send({ error: 'Ese Telegram ya esta vinculado a otro usuario' });

      const tempPassword = parsed.data.password ?? `${randomToken(6)}Aa1`;
      const strength = validatePasswordStrength(tempPassword);
      if (strength) return reply.code(400).send({ error: strength });

      const fullName =
        parsed.data.fullName?.trim() ||
        [contact.firstName, contact.lastName].filter(Boolean).join(' ').trim() ||
        `Usuario ${formatPhone(contact.phone)}`;

      // El correo debe ser unico: se genera uno interno editable despues.
      const email = `${contact.telegramId}@telegram.local`;

      const user = await prisma.user.create({
        data: {
          email,
          fullName,
          passwordHash: await hashPassword(tempPassword),
          roleId,
          managerId: parsed.data.managerId ?? null,
          phone: contact.phone,
          phoneVerifiedAt: new Date(),
          telegramId: contact.telegramId,
          telegramUsername: contact.username ?? null,
          telegramLinkedAt: new Date(),
        },
        include: { role: true },
      });
      await prisma.botContact.update({ where: { id }, data: { status: 'LINKED', userId: user.id } });
      await audit(request, { action: 'botcontact.approve', entity: 'user', entityId: user.id, metadata: { role: role.key } });

      return reply.code(201).send({
        ok: true,
        user: serializeUser(user),
        temporaryPassword: tempPassword,
        message: 'Usuario creado y Telegram vinculado. Comparte la clave temporal por un canal seguro.',
      });
    },
  );

  app.delete('/bot-contacts/:id', { preHandler: [requirePermission(PERMISSIONS.USERS_DELETE)] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    await prisma.botContact.delete({ where: { id } }).catch(() => null);
    return reply.send({ ok: true });
  });
}
