-- ===========================================================================
--  PERSONAL API TOKENS
--
--  Permite que usuarios autenticados creen tokens de acceso persistentes para
--  asistentes externos, scripts y llamadas a la API sin sesiones JWT rotativas.
--
--  Características:
--   · Tokens con prefijo reconocible (ttt_) y almacenados hasheados (SHA-256)
--   · Autenticación vía Authorization: Bearer <token>
--   · Heredan los permisos del usuario propietario
--   · Respetan el estado isActive del usuario
--   · Registro de último uso (lastUsedAt) y caducidad opcional (expiresAt)
--   · Compatible con autenticación JWT existente
--
--  El token en texto plano se muestra SOLO UNA VEZ al crearlo; después solo se
--  guarda el hash, por lo que un token perdido no se puede recuperar (hay que
--  revocar y crear uno nuevo).
-- ===========================================================================

-- CreateTable
CREATE TABLE "api_tokens" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "prefix" TEXT NOT NULL DEFAULT 'ttt_',
    "expiresAt" DATETIME,
    "lastUsedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "api_tokens_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "api_tokens_tokenHash_key" ON "api_tokens"("tokenHash");

-- CreateIndex
CREATE INDEX "api_tokens_userId_idx" ON "api_tokens"("userId");

-- CreateIndex
CREATE INDEX "api_tokens_tokenHash_idx" ON "api_tokens"("tokenHash");
