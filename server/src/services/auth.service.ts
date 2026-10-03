import type { FastifyInstance } from 'fastify';
import { prisma } from '../db/prisma';
import { env } from '../config/env';
import { randomToken, sha256 } from '../config/crypto';
import { normalizePermissions, type JwtPayload } from '../middleware/auth';

/**
 * Emision y rotacion de tokens (access + refresh).
 * El refresh token se guarda hasheado: si la BD se filtra no se pueden reusar.
 */

export async function issueTokens(
  app: FastifyInstance,
  userId: string,
  email: string,
  meta: { userAgent?: string; ip?: string } = {},
): Promise<{ accessToken: string; refreshToken: string; expiresIn: string; sessionId: string }> {
  const refreshToken = randomToken(48);
  const session = await prisma.authSession.create({
    data: {
      userId,
      refreshHash: sha256(refreshToken),
      userAgent: meta.userAgent ?? null,
      ip: meta.ip ?? null,
      expiresAt: new Date(Date.now() + env.REFRESH_EXPIRES_DAYS * 24 * 3600 * 1000),
    },
  });
  const accessToken = await signAccess(app, userId, email, session.id);
  return { accessToken, refreshToken, expiresIn: env.JWT_EXPIRES_IN, sessionId: session.id };
}

export async function signAccess(
  app: FastifyInstance,
  userId: string,
  email: string,
  sessionId: string,
): Promise<string> {
  const payload: Omit<JwtPayload, 'typ'> = { sub: userId, email, sid: sessionId };
  return app.jwt.sign({ ...payload, typ: 'access' satisfies JwtPayload['typ'] }, { expiresIn: env.JWT_EXPIRES_IN });
}

export async function revokeSession(sessionId: string): Promise<void> {
  await prisma.authSession.updateMany({ where: { id: sessionId }, data: { revokedAt: new Date() } });
}

export async function revokeAllSessions(userId: string, exceptSessionId?: string): Promise<void> {
  await prisma.authSession.updateMany({
    where: { userId, ...(exceptSessionId ? { id: { not: exceptSessionId } } : {}) },
    data: { revokedAt: new Date() },
  });
}

/** Serializa un usuario para la API (nunca expone hashes ni tokens). */
export function serializeUser(user: any) {
  return {
    id: user.id,
    email: user.email,
    fullName: user.fullName,
    isActive: user.isActive,
    role: user.role
      ? {
          id: user.role.id,
          key: user.role.key,
          name: user.role.name,
          permissions: normalizePermissions(user.role.permissions),
        }
      : null,
    managerId: user.managerId ?? null,
    managerName: user.manager?.fullName ?? null,
    telegramId: user.telegramId ?? null,
    telegramUsername: user.telegramUsername ?? null,
    telegramLinkedAt: user.telegramLinkedAt ? user.telegramLinkedAt.toISOString() : null,
    phone: user.phone ?? null,
    phoneVerifiedAt: user.phoneVerifiedAt ? user.phoneVerifiedAt.toISOString() : null,
    githubUsername: user.githubUsername ?? null,
    hasGithubToken: Boolean(user.githubToken),
    timezone: user.timezone,
    workDays: String(user.workDays ?? '1,2,3,4,5')
      .split(',')
      .map((d: string) => Number.parseInt(d, 10))
      .filter((n: number) => Number.isFinite(n)),
    workStart: user.workStart,
    workEnd: user.workEnd,
    idleAlertMin: user.idleAlertMin,
    dailyDigest: user.dailyDigest,
    lastLoginAt: user.lastLoginAt ? user.lastLoginAt.toISOString() : null,
    createdAt: user.createdAt.toISOString(),
  };
}
