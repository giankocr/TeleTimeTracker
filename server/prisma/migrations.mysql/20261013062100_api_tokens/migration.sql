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
CREATE TABLE `api_tokens` (
    `id` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `tokenHash` VARCHAR(191) NOT NULL,
    `prefix` VARCHAR(191) NOT NULL DEFAULT 'ttt_',
    `expiresAt` DATETIME(3) NULL,
    `lastUsedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `api_tokens_tokenHash_key`(`tokenHash`),
    INDEX `api_tokens_userId_idx`(`userId`),
    INDEX `api_tokens_tokenHash_idx`(`tokenHash`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `api_tokens` ADD CONSTRAINT `api_tokens_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
