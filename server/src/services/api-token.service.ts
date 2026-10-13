import { prisma } from '../db/prisma';
import { randomToken, sha256 } from '../config/crypto';

export interface ApiTokenInfo {
  id: string;
  name: string;
  prefix: string;
  maskedToken: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
}

/**
 * Genera un nuevo API token con formato ttt_<32 chars aleatorios>
 */
export function generateApiToken(): string {
  const randomPart = randomToken(24); // 32 caracteres en hex
  return `ttt_${randomPart}`;
}

/**
 * Crea un nuevo API token para un usuario.
 * Devuelve el token en texto plano (SOLO UNA VEZ) y la info del token guardado.
 */
export async function createApiToken(
  userId: string,
  name: string,
  expiresAt?: Date,
): Promise<{ token: string; info: ApiTokenInfo }> {
  const token = generateApiToken();
  const tokenHash = sha256(token);

  const apiToken = await prisma.apiToken.create({
    data: {
      userId,
      name,
      tokenHash,
      prefix: 'ttt_',
      expiresAt: expiresAt ?? null,
    },
  });

  return {
    token, // Texto plano - se muestra SOLO UNA VEZ
    info: serializeApiToken(apiToken),
  };
}

/**
 * Lista todos los tokens de un usuario.
 */
export async function listUserApiTokens(userId: string): Promise<ApiTokenInfo[]> {
  const tokens = await prisma.apiToken.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
  });

  return tokens.map(serializeApiToken);
}

/**
 * Revoca (elimina) un API token.
 */
export async function revokeApiToken(tokenId: string, userId: string): Promise<boolean> {
  const result = await prisma.apiToken.deleteMany({
    where: { id: tokenId, userId },
  });

  return result.count > 0;
}

/**
 * Serializa un token para la API (nunca expone el hash completo).
 */
function serializeApiToken(token: any): ApiTokenInfo {
  // Mostrar solo primeros 4 y ultimos 4 chars del hash
  const maskedHash = `${token.tokenHash.substring(0, 4)}${'•'.repeat(56)}${token.tokenHash.substring(60)}`;

  return {
    id: token.id,
    name: token.name,
    prefix: token.prefix,
    maskedToken: `${token.prefix}${'•'.repeat(24)}`,
    expiresAt: token.expiresAt ? token.expiresAt.toISOString() : null,
    lastUsedAt: token.lastUsedAt ? token.lastUsedAt.toISOString() : null,
    createdAt: token.createdAt.toISOString(),
  };
}
