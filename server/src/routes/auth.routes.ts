import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { prisma } from '../db/prisma';
import { encryptSecret, generateLinkCode, randomToken, sha256 } from '../config/crypto';
import { env } from '../config/env';
import { authenticate, hashPassword, validatePasswordStrength, verifyPassword } from '../middleware/auth';
import { issueTokens, revokeAllSessions, serializeUser, signAccess } from '../services/auth.service';
import {
  loginConfig,
  normalizeTelegramPayload,
  parseTelegramAuthHash,
  requestPhoneOtp,
  resolveTelegramOAuth,
  verifyPhoneOtp,
} from '../services/telegram-auth.service';
import { audit } from '../utils/audit';
import { zEmail, zPassword } from '../utils/validators';
import { ALL_PERMISSIONS, ROLE_PRESETS } from '../../../shared/types';

/**
 * Autenticacion del panel. Tres vias, igual que en NosotrosConstruimos:
 *   1) Telegram OAuth / Login Widget  -> POST /api/auth/telegram/oauth
 *   2) Telefono + codigo por el bot   -> POST /api/auth/phone/request y /verify
 *   3) Correo + contrasena            -> POST /api/auth/login
 */
export default async function authRoutes(app: FastifyInstance): Promise<void> {
  /** Emite sesion y responde igual en las tres vias. */
  const completeLogin = async (
    request: FastifyRequest,
    reply: FastifyReply,
    user: any,
    method: 'telegram' | 'phone' | 'email',
  ) => {
    const tokens = await issueTokens(app, user.id, user.email, {
      userAgent: request.headers['user-agent'],
      ip: request.ip,
    });
    await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
    await audit(request, { action: `auth.login_${method}`, entity: 'user', entityId: user.id, userId: user.id });
    return reply.send({ ...tokens, user: serializeUser(user), method });
  };

  // -------------------------------------------------------------------------
  // GET /api/auth/config — configuracion publica para la pantalla de login
  // (nunca expone secretos; el bot_id es publico por diseño)
  // -------------------------------------------------------------------------
  app.get('/config', async (_request, reply) => {
    const config = await loginConfig();
    return reply.send({
      companyName: config.companyName,
      telegram: {
        enabled: config.telegramEnabled,
        botId: config.botId,
        botUsername: config.botUsername,
        loginMode: config.telegramLoginMode,
        // Client ID para la libreria telegram-login.js (es publico por diseño).
        clientId: config.loginClientId,
        clientIdFromBotFather: config.loginClientIdFromBotFather,
        oidcConfigured: config.oidcConfigured,
        // URL exacta que debe estar en BotFather -> Login Widget -> Allowed URLs
        webRedirectUri: config.webRedirectUri,
      },
      phoneOtp: { enabled: config.phoneOtpEnabled },
    });
  });

  // -------------------------------------------------------------------------
  // POST /api/auth/telegram/oauth — Telegram OAuth / Login Widget
  //
  // Acepta dos formas, igual que el proyecto de referencia:
  //   { hash: "#tgAuthResult=<base64(JSON)>" }  (redireccion OAuth: el hash solo
  //                                              lo ve el navegador, que lo reenvia)
  //   { id, first_name, auth_date, hash, ... }  (campos ya desglosados)
  // -------------------------------------------------------------------------
  app.post('/telegram/oauth', async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;

    const payload = typeof body.hash === 'string' && body.hash.startsWith('tgAuthResult')
      ? parseTelegramAuthHash(body.hash)
      : normalizeTelegramPayload(body);

    if (!payload) {
      return reply.code(400).send({ error: 'No recibimos los datos de Telegram. Intenta de nuevo.', code: 'TELEGRAM_AUTH_MALFORMED' });
    }

    const outcome = await resolveTelegramOAuth(payload);
    if (!outcome.ok || !outcome.user) {
      await audit(request, {
        action: 'auth.telegram_login_failed',
        metadata: { telegramId: String(payload.id), code: outcome.code, reason: outcome.error },
      });
      return reply.code(outcome.status).send({ error: outcome.error, code: outcome.code });
    }

    return completeLogin(request, reply, outcome.user, 'telegram');
  });

  /** Compatibilidad: el Login Widget clasico envia los campos directamente. */
  app.post('/telegram/login', async (request, reply) => {
    const payload = normalizeTelegramPayload((request.body ?? {}) as Record<string, unknown>);
    if (!payload) {
      return reply.code(400).send({ error: 'Datos de Telegram invalidos', code: 'TELEGRAM_AUTH_MALFORMED' });
    }
    const outcome = await resolveTelegramOAuth(payload);
    if (!outcome.ok || !outcome.user) {
      await audit(request, {
        action: 'auth.telegram_login_failed',
        metadata: { telegramId: String(payload.id), code: outcome.code, reason: outcome.error },
      });
      return reply.code(outcome.status).send({ error: outcome.error, code: outcome.code });
    }
    return completeLogin(request, reply, outcome.user, 'telegram');
  });

  // -------------------------------------------------------------------------
  // POST /api/auth/telegram/oidc — Telegram Login (libreria oficial / OIDC)
  //
  // La libreria `telegram-login.js` abre un popup y devuelve un **id_token**
  // (JWT firmado con RS256). Aqui se valida contra el JWKS de Telegram
  // (firma, iss, aud y exp) y, si la cuenta esta vinculada, se abre sesion.
  // -------------------------------------------------------------------------
  app.post('/telegram/oidc', async (request, reply) => {
    const parsed = z
      .object({
        idToken: z.string().min(10).optional(),
        id_token: z.string().min(10).optional(),
        nonce: z.string().max(200).optional(),
      })
      .safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Envia el id_token de Telegram', code: 'ID_TOKEN_MISSING' });
    }
    const idToken = parsed.data.idToken ?? parsed.data.id_token!;

    const { verifyTelegramIdToken, resolveUserFromClaims } = await import('../services/telegram-oidc.service');
    const verified = await verifyTelegramIdToken(idToken, { nonce: parsed.data.nonce });
    if (!verified.ok) {
      await audit(request, { action: 'auth.telegram_login_failed', metadata: { code: verified.code, reason: verified.error } });
      return reply.code(401).send({ error: verified.error, code: verified.code });
    }

    const outcome = await resolveUserFromClaims(verified.claims);
    if (!outcome.ok || !outcome.user) {
      await audit(request, {
        action: 'auth.telegram_login_failed',
        metadata: { telegramId: String(verified.claims.id ?? verified.claims.sub), code: outcome.code, reason: outcome.error },
      });
      return reply.code(outcome.status).send({ error: outcome.error, code: outcome.code });
    }

    await audit(request, {
      action: 'auth.login_telegram',
      entity: 'user',
      entityId: outcome.user.id,
      userId: outcome.user.id,
      metadata: { via: 'oidc' },
    });
    return completeLogin(request, reply, outcome.user, 'telegram');
  });

  // -------------------------------------------------------------------------
  // GET /api/auth/telegram/oidc/config — datos publicos del flujo OIDC
  // -------------------------------------------------------------------------
  app.get('/telegram/oidc/config', async (_request, reply) => {
    const { oidcConfig, telegramOidc } = await import('../services/telegram-oidc.service');
    const config = oidcConfig();
    return reply.send({
      clientId: config.effectiveClientId,
      configured: config.configured,
      scopes: ['openid', 'profile', 'phone'],
      endpoints: { issuer: telegramOidc.ISSUER, jwks: telegramOidc.JWKS_URL, authorization: telegramOidc.AUTH_ENDPOINT },
    });
  });

  // -------------------------------------------------------------------------
  // POST /api/auth/phone/request — envia un codigo de 6 digitos por el bot
  // -------------------------------------------------------------------------
  app.post('/phone/request', async (request, reply) => {
    const parsed = z.object({ phone: z.string().min(7).max(30) }).safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Escribe tu numero de telefono', code: 'PHONE_INVALID' });

    const result = await requestPhoneOtp(parsed.data.phone);
    if (!result.ok) {
      await audit(request, { action: 'auth.phone_otp_failed', metadata: { code: result.code } });
      return reply.code(result.status).send({
        error: result.error,
        code: result.code,
        needsTelegram: result.needsTelegram ?? false,
      });
    }

    await audit(request, { action: 'auth.phone_otp_sent', metadata: { phone: result.maskedPhone } });
    return reply.send({
      ok: true,
      phone: result.phone,
      maskedPhone: result.maskedPhone,
      expiresInMinutes: result.expiresInMinutes,
      message: 'Te enviamos un codigo de 6 numeros por Telegram.',
    });
  });

  // -------------------------------------------------------------------------
  // POST /api/auth/phone/verify — valida el codigo y abre sesion
  // -------------------------------------------------------------------------
  app.post('/phone/verify', async (request, reply) => {
    const parsed = z
      .object({ phone: z.string().min(7).max(30), code: z.string().trim().regex(/^\d{6}$/, 'El codigo debe tener 6 numeros') })
      .safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'Datos invalidos' });

    const outcome = await verifyPhoneOtp(parsed.data.phone, parsed.data.code);
    if (!outcome.ok || !outcome.user) {
      await audit(request, { action: 'auth.phone_otp_failed', metadata: { code: outcome.code } });
      return reply.code(outcome.status).send({ error: outcome.error, code: outcome.code });
    }

    return completeLogin(request, reply, outcome.user, 'phone');
  });

  // -------------------------------------------------------------------------
  // POST /api/auth/login — correo + contrasena
  // -------------------------------------------------------------------------
  app.post('/login', async (request, reply) => {
    const parsed = z.object({ email: zEmail, password: z.string().min(1) }).safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'Datos invalidos' });
    const { email, password } = parsed.data;

    const user = await prisma.user.findUnique({
      where: { email: email.toLowerCase() },
      include: { role: true, manager: { select: { fullName: true } } },
    });

    // Mensaje generico: no revelamos si el correo existe.
    const invalid = () => reply.code(401).send({ error: 'Credenciales invalidas', code: 'INVALID_CREDENTIALS' });
    if (!user) return invalid();
    if (!(await verifyPassword(password, user.passwordHash))) return invalid();
    if (!user.isActive) {
      return reply.code(403).send({ error: 'Usuario desactivado. Contacta al administrador.', code: 'USER_DISABLED' });
    }

    const tokens = await issueTokens(app, user.id, user.email, {
      userAgent: request.headers['user-agent'],
      ip: request.ip,
    });
    await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
    await audit(request, { action: 'auth.login', entity: 'user', entityId: user.id });

    return reply.send({ ...tokens, user: serializeUser(user) });
  });

  // -------------------------------------------------------------------------
  // POST /api/auth/refresh  (rotacion de refresh token)
  // -------------------------------------------------------------------------
  app.post('/refresh', async (request, reply) => {
    const body = z.object({ refreshToken: z.string().min(10) }).safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: 'refreshToken requerido' });

    const session = await prisma.authSession.findUnique({
      where: { refreshHash: sha256(body.data.refreshToken) },
      include: { user: { include: { role: true, manager: { select: { fullName: true } } } } },
    });
    if (!session || session.revokedAt || session.expiresAt < new Date()) {
      return reply.code(401).send({ error: 'Sesion expirada', code: 'SESSION_REVOKED' });
    }
    if (!session.user.isActive) return reply.code(403).send({ error: 'Usuario desactivado', code: 'USER_DISABLED' });

    const newRefresh = randomToken(48);
    await prisma.authSession.update({
      where: { id: session.id },
      data: {
        refreshHash: sha256(newRefresh),
        expiresAt: new Date(Date.now() + env.REFRESH_EXPIRES_DAYS * 24 * 3600 * 1000),
      },
    });

    const accessToken = await signAccess(app, session.userId, session.user.email, session.id);
    return reply.send({
      accessToken,
      refreshToken: newRefresh,
      expiresIn: env.JWT_EXPIRES_IN,
      user: serializeUser(session.user),
    });
  });

  // -------------------------------------------------------------------------
  // POST /api/auth/logout
  // -------------------------------------------------------------------------
  app.post('/logout', { preHandler: [authenticate] }, async (request, reply) => {
    await prisma.authSession.updateMany({
      where: { id: request.auth!.sessionId },
      data: { revokedAt: new Date() },
    });
    await audit(request, { action: 'auth.logout' });
    return reply.send({ ok: true });
  });

  // -------------------------------------------------------------------------
  // GET /api/auth/me
  // -------------------------------------------------------------------------
  app.get('/me', { preHandler: [authenticate] }, async (request, reply) => {
    const user = await prisma.user.findUnique({
      where: { id: request.auth!.userId },
      include: { role: true, manager: { select: { fullName: true } } },
    });
    if (!user) return reply.code(404).send({ error: 'Usuario no encontrado' });
    return reply.send({ user: serializeUser(user) });
  });

  // -------------------------------------------------------------------------
  // PATCH /api/auth/me — el usuario edita su propio perfil
  // -------------------------------------------------------------------------
  app.patch('/me', { preHandler: [authenticate] }, async (request, reply) => {
    const parsed = z
      .object({
        fullName: z.string().min(2).max(120).optional(),
        timezone: z.string().min(2).max(64).optional(),
        githubUsername: z.string().max(80).nullable().optional(),
        githubToken: z.string().max(300).nullable().optional(),
        workDays: z.array(z.number().int().min(0).max(6)).optional(),
        workStart: z.string().regex(/^\d{2}:\d{2}$/).optional(),
        workEnd: z.string().regex(/^\d{2}:\d{2}$/).optional(),
        idleAlertMin: z.number().int().min(5).max(480).optional(),
        dailyDigest: z.boolean().optional(),
        locale: z.string().max(8).optional(),
      })
      .safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'Datos invalidos' });
    const d = parsed.data;

    const updated = await prisma.user.update({
      where: { id: request.auth!.userId },
      data: {
        ...(d.fullName !== undefined ? { fullName: d.fullName } : {}),
        ...(d.timezone !== undefined ? { timezone: d.timezone } : {}),
        ...(d.githubUsername !== undefined ? { githubUsername: d.githubUsername } : {}),
        ...(d.githubToken !== undefined ? { githubToken: d.githubToken ? encryptSecret(d.githubToken) : null } : {}),
        ...(d.workDays !== undefined ? { workDays: d.workDays.join(',') } : {}),
        ...(d.workStart !== undefined ? { workStart: d.workStart } : {}),
        ...(d.workEnd !== undefined ? { workEnd: d.workEnd } : {}),
        ...(d.idleAlertMin !== undefined ? { idleAlertMin: d.idleAlertMin } : {}),
        ...(d.dailyDigest !== undefined ? { dailyDigest: d.dailyDigest } : {}),
        ...(d.locale !== undefined ? { locale: d.locale } : {}),
      },
      include: { role: true, manager: { select: { fullName: true } } },
    });
    await audit(request, { action: 'auth.profile_update', entity: 'user', entityId: updated.id });
    return reply.send({ user: serializeUser(updated) });
  });

  // -------------------------------------------------------------------------
  // POST /api/auth/change-password
  // -------------------------------------------------------------------------
  app.post('/change-password', { preHandler: [authenticate] }, async (request, reply) => {
    const parsed = z
      .object({ currentPassword: z.string().min(1), newPassword: zPassword })
      .safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'Datos invalidos' });

    const user = await prisma.user.findUnique({ where: { id: request.auth!.userId } });
    if (!user || !(await verifyPassword(parsed.data.currentPassword, user.passwordHash))) {
      return reply.code(400).send({ error: 'La contrasena actual no es correcta' });
    }
    const strength = validatePasswordStrength(parsed.data.newPassword);
    if (strength) return reply.code(400).send({ error: strength });

    await prisma.user.update({
      where: { id: user.id },
      data: { passwordHash: await hashPassword(parsed.data.newPassword) },
    });
    await revokeAllSessions(user.id, request.auth!.sessionId); // cierra el resto de dispositivos
    await audit(request, { action: 'auth.change_password', entity: 'user', entityId: user.id });
    return reply.send({ ok: true, message: 'Contrasena actualizada. Se cerraron las demas sesiones.' });
  });

  // -------------------------------------------------------------------------
  // GET /api/auth/permissions — catalogo para el editor de roles
  // -------------------------------------------------------------------------
  app.get('/permissions', { preHandler: [authenticate] }, async (_request, reply) =>
    reply.send({ permissions: ALL_PERMISSIONS, presets: ROLE_PRESETS }),
  );

  // -------------------------------------------------------------------------
  // POST /api/auth/telegram/link-code
  // -------------------------------------------------------------------------
  app.post('/telegram/link-code', { preHandler: [authenticate] }, async (request, reply) => {
    const code = generateLinkCode();
    const expiresAt = new Date(Date.now() + 30 * 60 * 1000);
    await prisma.user.update({
      where: { id: request.auth!.userId },
      data: { telegramLinkCode: code, telegramLinkExp: expiresAt },
    });
    await audit(request, { action: 'auth.telegram_link_code' });
    return reply.send({
      code,
      expiresAt: expiresAt.toISOString(),
      instructions: `Abre el bot de Telegram y envia: /vincular ${code}`,
    });
  });

  // -------------------------------------------------------------------------
  // DELETE /api/auth/telegram
  // -------------------------------------------------------------------------
  app.delete('/telegram', { preHandler: [authenticate] }, async (request, reply) => {
    await prisma.user.update({
      where: { id: request.auth!.userId },
      data: { telegramId: null, telegramUsername: null, telegramLinkedAt: null },
    });
    await audit(request, { action: 'auth.telegram_unlink' });
    return reply.send({ ok: true });
  });
}
