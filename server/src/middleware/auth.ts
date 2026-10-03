import bcrypt from 'bcryptjs';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { prisma } from '../db/prisma';
import { env } from '../config/env';

/** Politica minima de contrasenas. */
export function validatePasswordStrength(password: string): string | null {
  if (!password || password.length < 8) return 'La contrasena debe tener al menos 8 caracteres.';
  if (!/[A-Za-z]/.test(password)) return 'La contrasena debe incluir al menos una letra.';
  if (!/[0-9]/.test(password)) return 'La contrasena debe incluir al menos un numero.';
  return null;
}

export const hashPassword = (plain: string): Promise<string> => bcrypt.hash(plain, 10);

export const verifyPassword = (plain: string, hash: string): Promise<boolean> =>
  bcrypt.compare(plain, hash).catch(() => false);

/**
 * Payload del access token.
 * Los permisos se resuelven SIEMPRE desde la BD en cada request (no se confian del token),
 * asi un cambio de rol tiene efecto inmediato; el token guarda solo identidad + sessionId.
 */
export interface JwtPayload {
  sub: string;
  email: string;
  sid: string;
  typ: 'access' | 'refresh';
}

export interface AuthContext {
  userId: string;
  email: string;
  fullName: string;
  roleKey: string;
  permissions: string[];
  sessionId: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    auth?: AuthContext;
  }
}

export function normalizePermissions(raw: string): string[] {
  return raw
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);
}

export function hasPermission(auth: AuthContext | undefined, permission: string): boolean {
  if (!auth) return false;
  if (auth.permissions.includes('*')) return true;
  if (auth.permissions.includes(permission)) return true;
  // Comodin por namespace: "entries:*" habilita "entries:read:own"
  const [ns] = permission.split(':');
  return auth.permissions.includes(`${ns}:*`);
}

/** Carga el usuario + rol desde la BD y construye el contexto RBAC. */
export async function buildAuthContext(userId: string, sessionId: string): Promise<AuthContext | null> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: { role: true },
  });
  if (!user || !user.isActive) return null;
  return {
    userId: user.id,
    email: user.email,
    fullName: user.fullName,
    roleKey: user.role.key,
    permissions: normalizePermissions(user.role.permissions),
    sessionId,
  };
}

/**
 * preHandler: exige JWT valido + sesion activa en BD.
 * Uso: { preHandler: [app.authenticate] }
 */
export async function authenticate(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  try {
    const payload = await request.jwtVerify<JwtPayload>();
    if (payload.typ !== 'access') throw new Error('tipo de token invalido');

    const session = await prisma.authSession.findUnique({ where: { id: payload.sid } });
    if (!session || session.revokedAt || session.expiresAt < new Date()) {
      return reply.code(401).send({ error: 'Sesion expirada o revocada', code: 'SESSION_REVOKED' });
    }

    const auth = await buildAuthContext(payload.sub, payload.sid);
    if (!auth) return reply.code(401).send({ error: 'Usuario inactivo o inexistente', code: 'USER_DISABLED' });

    request.auth = auth;
  } catch {
    return reply.code(401).send({ error: 'No autenticado', code: 'UNAUTHENTICATED' });
  }
}

/** preHandler factory: exige un permiso concreto. */
export function requirePermission(permission: string) {
  return async function permissionGuard(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    if (!request.auth) {
      await authenticate(request, reply);
      if (!request.auth) return;
    }
    if (!hasPermission(request.auth, permission)) {
      return reply.code(403).send({ error: `Permiso requerido: ${permission}`, code: 'FORBIDDEN' });
    }
  };
}

export function requireRole(...roles: string[]) {
  return async function roleGuard(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    if (!request.auth) {
      await authenticate(request, reply);
      if (!request.auth) return;
    }
    if (!roles.includes(request.auth.roleKey)) {
      return reply.code(403).send({ error: 'Rol insuficiente', code: 'FORBIDDEN' });
    }
  };
}

/**
 * Alcance de datos: ADMIN ve todo, MANAGER ve su equipo (reportes directos + el mismo),
 * USER solo lo suyo.
 */
export async function visibleUserIds(auth: AuthContext): Promise<{ all: boolean; ids: string[] }> {
  if (hasPermission(auth, 'reports:all') || auth.roleKey === 'ADMIN') return { all: true, ids: [] };

  const ids = new Set<string>([auth.userId]);
  if (hasPermission(auth, 'reports:team')) {
    const team = await prisma.user.findMany({
      where: {
        OR: [
          { managerId: auth.userId },
          { manager: { managerId: auth.userId } }, // segundo nivel
        ],
      },
      select: { id: true },
    });
    team.forEach((t) => ids.add(t.id));
  }
  return { all: false, ids: [...ids] };
}

export const securityConfig = {
  jwtExpiresIn: env.JWT_EXPIRES_IN,
  refreshExpiresDays: env.REFRESH_EXPIRES_DAYS,
};
