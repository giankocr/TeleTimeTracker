-- ===========================================================================
--  Limpieza de tareas DUPLICADAS que dejo el backfill no idempotente.
--
--  Ver la version SQLite (server/prisma/migrations/20261003020000_...) para la
--  explicacion completa. Regla conservadora: se borra una tarea solo si
--    (1) su id es 'tarea_<id de un registro existente>' y ese registro esta
--        enlazado a OTRA tarea (o a ninguna), y
--    (2) ningun registro apunta a ella.
--  Las tareas del bot/panel (ids cuid) y las que tienen registros se conservan.
--
--  Se usa una tabla TEMPORARY con la MISMA collation que `tasks`
--  (utf8mb4_unicode_ci): sin fijarla, MySQL falla con el error 1267
--  "Illegal mix of collations" al comparar con la tabla real.
-- ===========================================================================

DROP TEMPORARY TABLE IF EXISTS `_tareas_duplicadas`;
CREATE TEMPORARY TABLE `_tareas_duplicadas` (
    `id` VARCHAR(32) COLLATE utf8mb4_unicode_ci NOT NULL PRIMARY KEY
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

INSERT IGNORE INTO `_tareas_duplicadas` (`id`)
SELECT t.`id`
FROM `tasks` t
WHERE t.`id` LIKE 'tarea\_%'
  -- (1) el registro "dueno" del id ya esta en otra tarea
  AND EXISTS (
      SELECT 1 FROM `time_entries` e
      WHERE t.`id` = CONCAT('tarea_', e.`id`)
        AND (e.`taskId` IS NULL OR e.`taskId` <> t.`id`)
  )
  -- (2) ningun registro quedo enlazado a esta tarea
  AND NOT EXISTS (
      SELECT 1 FROM `time_entries` e2 WHERE e2.`taskId` = t.`id`
  );

DELETE t FROM `tasks` t
JOIN `_tareas_duplicadas` d ON d.`id` = t.`id`;

DROP TEMPORARY TABLE IF EXISTS `_tareas_duplicadas`;
