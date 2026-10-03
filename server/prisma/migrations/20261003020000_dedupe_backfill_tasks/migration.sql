-- ===========================================================================
--  Limpieza de tareas DUPLICADAS que dejo el backfill no idempotente.
--
--  Contexto
--  --------
--  El backfill de 20261003010000_tasks_entity agrupa los registros de tiempo
--  que representan la misma tarea (mismo titulo, proyecto, cliente, tipo y
--  usuario) y crea UNA tarea por grupo, con el id 'tarea_<id del registro mas
--  antiguo del grupo>'. Su guard se evaluaba POR FILA en lugar de por GRUPO, de
--  modo que al reejecutarse creaba tareas extra con el id del siguiente registro
--  del grupo ('tarea_<id del 2o registro>'), que quedaban huerfanas: el UPDATE
--  del backfill deja todos los registros enlazados a la tarea del grupo.
--
--  Regla de borrado (conservadora)
--  -------------------------------
--  Se borra una tarea solo si:
--    (1) su id tiene la forma 'tarea_<id de un registro que EXISTE>
--        y ademas ese registro esta enlazado a OTRA tarea, o no esta enlazado;
--    (2) ningun registro apunta a ella.
--
--  Es decir: una tarea con id de backfill, huerfana, cuyo registro "dueno" del
--  id ya pertenece a otra tarea. Nunca se toca una tarea creada por el bot o el
--  panel (ids cuid, no empiezan por 'tarea_'), ni una tarea con registros
--  enlazados. Si hay cualquier duda, se conserva.
--
--  Es idempotente: una segunda ejecucion no encuentra nada que borrar.
-- ===========================================================================

DELETE FROM "tasks"
WHERE "id" LIKE 'tarea_%'
  -- (1) el registro "dueno" del id ya esta en otra tarea
  AND EXISTS (
      SELECT 1 FROM "time_entries" e
      WHERE "tasks"."id" = 'tarea_' || e."id"
        AND (e."taskId" IS NULL OR e."taskId" <> "tasks"."id")
  )
  -- (2) ningun registro quedo enlazado a esta tarea
  AND NOT EXISTS (
      SELECT 1 FROM "time_entries" e2 WHERE e2."taskId" = "tasks"."id"
  );
