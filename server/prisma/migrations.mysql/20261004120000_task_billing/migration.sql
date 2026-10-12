-- ===========================================================================
--  TIQUETE Y CONTROL DE FACTURACIÓN (versión MySQL).
--  Ver server/prisma/migrations/20261004120000_task_billing/migration.sql
--
--  El estado de facturación vive en la TAREA (el tiquete) y `invoiceRef` agrupa
--  varias tareas en una misma factura. `billedAmount` se congela al facturar.
--  Los tamaños siguen el criterio de schema.mysql.prisma (nada de TEXT sin
--  límite en columnas que se filtran o indexan).
-- ===========================================================================

-- Tarifa por hora de referencia del cliente (respaldo de la del proyecto).
ALTER TABLE `clients` ADD COLUMN `hourlyRate` DOUBLE NULL;

-- Nº de tiquete con el que el cliente identifica el trabajo.
ALTER TABLE `tasks` ADD COLUMN `reference` VARCHAR(80) NULL;

-- Estado de facturación del tiquete.
ALTER TABLE `tasks` ADD COLUMN `billingStatus` VARCHAR(16) NOT NULL DEFAULT 'PENDING';
ALTER TABLE `tasks` ADD COLUMN `billedAt` DATETIME(3) NULL;
ALTER TABLE `tasks` ADD COLUMN `paidAt` DATETIME(3) NULL;
ALTER TABLE `tasks` ADD COLUMN `invoiceRef` VARCHAR(60) NULL;
ALTER TABLE `tasks` ADD COLUMN `billedAmount` DOUBLE NULL;
ALTER TABLE `tasks` ADD COLUMN `hourlyRate` DOUBLE NULL;

CREATE INDEX `tasks_clientId_billingStatus_idx` ON `tasks`(`clientId`, `billingStatus`);

CREATE INDEX `tasks_invoiceRef_idx` ON `tasks`(`invoiceRef`);
