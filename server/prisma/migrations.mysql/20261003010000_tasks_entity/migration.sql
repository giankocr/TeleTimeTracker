-- ===========================================================================
--  TAREA como entidad propia (version MySQL).
--  Ver server/prisma/migrations/20261003010000_tasks_entity/migration.sql
--  Jerarquia: Cliente -> Proyecto -> Tarea -> Registro de tiempo
--  UNA TAREA PUEDE TENER VARIOS REGISTROS (tramos).
-- ===========================================================================

CREATE TABLE `tasks` (
    `id` VARCHAR(32) NOT NULL,
    `title` VARCHAR(200) NOT NULL,
    `description` TEXT NULL,
    `status` VARCHAR(16) NOT NULL DEFAULT 'OPEN',
    `projectId` VARCHAR(32) NULL,
    `clientId` VARCHAR(32) NULL,
    `taskTypeId` VARCHAR(32) NULL,
    `assigneeId` VARCHAR(32) NULL,
    `createdById` VARCHAR(32) NULL,
    `estimatedHours` DOUBLE NULL,
    `priority` VARCHAR(10) NOT NULL DEFAULT 'NORMAL',
    `dueDate` DATETIME(3) NULL,
    `totalSeconds` INTEGER NOT NULL DEFAULT 0,
    `entryCount` INTEGER NOT NULL DEFAULT 0,
    `firstWorkedAt` DATETIME(3) NULL,
    `lastWorkedAt` DATETIME(3) NULL,
    `completedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    INDEX `tasks_projectId_status_idx`(`projectId`, `status`),
    INDEX `tasks_assigneeId_status_idx`(`assigneeId`, `status`),
    INDEX `tasks_status_idx`(`status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `time_entries` ADD COLUMN `taskId` VARCHAR(32) NULL;
CREATE INDEX `time_entries_taskId_idx` ON `time_entries`(`taskId`);

-- Claves foraneas (SET NULL: borrar un proyecto no borra las tareas)
ALTER TABLE `tasks` ADD CONSTRAINT `tasks_projectId_fkey` FOREIGN KEY (`projectId`) REFERENCES `projects`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE `tasks` ADD CONSTRAINT `tasks_clientId_fkey` FOREIGN KEY (`clientId`) REFERENCES `clients`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE `tasks` ADD CONSTRAINT `tasks_taskTypeId_fkey` FOREIGN KEY (`taskTypeId`) REFERENCES `task_types`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE `tasks` ADD CONSTRAINT `tasks_assigneeId_fkey` FOREIGN KEY (`assigneeId`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE `tasks` ADD CONSTRAINT `tasks_createdById_fkey` FOREIGN KEY (`createdById`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE `time_entries` ADD CONSTRAINT `time_entries_taskId_fkey` FOREIGN KEY (`taskId`) REFERENCES `tasks`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- ===========================================================================
--  BACKFILL agrupado: los tramos que eran la misma tarea forman UNA tarea
--  (MySQL no permite agrupar por una columna y seleccionar otra no agregada,
--   asi que el titulo se toma con MIN y la descripcion con MAX)
-- ===========================================================================
INSERT INTO `tasks` (
    `id`, `title`, `description`, `status`, `projectId`, `clientId`, `taskTypeId`,
    `assigneeId`, `createdById`, `priority`,
    `totalSeconds`, `entryCount`, `firstWorkedAt`, `lastWorkedAt`,
    `completedAt`, `createdAt`, `updatedAt`
)
SELECT
    CONCAT('tarea_', MIN(`id`)),
    MIN(`title`),
    MAX(`description`),
    CASE WHEN MAX(CASE WHEN `status` IN ('RUNNING', 'PAUSED') THEN 1 ELSE 0 END) = 1
         THEN 'IN_PROGRESS' ELSE 'DONE' END,
    `projectId`,
    `clientId`,
    `taskTypeId`,
    `userId`,
    `userId`,
    'NORMAL',
    SUM(COALESCE(`durationSec`, 0)),
    COUNT(`id`),
    MIN(`startedAt`),
    MAX(COALESCE(`endedAt`, `startedAt`)),
    CASE WHEN MAX(CASE WHEN `status` IN ('RUNNING', 'PAUSED') THEN 1 ELSE 0 END) = 1
         THEN NULL ELSE MAX(COALESCE(`endedAt`, `startedAt`)) END,
    MIN(`createdAt`),
    MAX(`updatedAt`)
FROM `time_entries`
WHERE NOT EXISTS (
    SELECT 1 FROM `tasks` t WHERE t.`id` = CONCAT('tarea_', `time_entries`.`id`)
)
GROUP BY
    COALESCE(`title`, ''), `projectId`, `clientId`, `taskTypeId`, `userId`;

UPDATE `time_entries` e
SET e.`taskId` = (
    SELECT CONCAT('tarea_', MIN(e2.`id`))
    FROM (SELECT * FROM `time_entries`) e2
    WHERE COALESCE(e2.`title`, '') = COALESCE(e.`title`, '')
      AND COALESCE(e2.`projectId`, '') = COALESCE(e.`projectId`, '')
      AND COALESCE(e2.`clientId`, '') = COALESCE(e.`clientId`, '')
      AND COALESCE(e2.`taskTypeId`, '') = COALESCE(e.`taskTypeId`, '')
      AND e2.`userId` = e.`userId`
)
WHERE e.`taskId` IS NULL;
