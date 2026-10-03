-- ===========================================================================
--  TAREA como entidad propia.
--
--  Antes: time_entries.title guardaba el nombre de la tarea, asi que la tarea
--  no existia como entidad y no podia acumular varios tramos.
--  Ahora: Cliente -> Proyecto -> Tarea -> Registro de tiempo, donde UNA TAREA
--  PUEDE TENER VARIOS REGISTROS (cada vez que se retoma, un tramo nuevo).
--
--  BACKFILL: los registros existentes se agrupan por (titulo + proyecto + tipo +
--  usuario), es decir por lo que era "la misma tarea", y se crea UNA tarea por
--  grupo con sus acumulados. El id es 'tarea_' || MIN(id del grupo),
--  determinista, para que reejecutar la migracion no duplique nada.
-- ===========================================================================

-- CreateTable
CREATE TABLE "tasks" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "projectId" TEXT,
    "clientId" TEXT,
    "taskTypeId" TEXT,
    "assigneeId" TEXT,
    "createdById" TEXT,
    "estimatedHours" REAL,
    "priority" TEXT NOT NULL DEFAULT 'NORMAL',
    "dueDate" DATETIME,
    "totalSeconds" INTEGER NOT NULL DEFAULT 0,
    "entryCount" INTEGER NOT NULL DEFAULT 0,
    "firstWorkedAt" DATETIME,
    "lastWorkedAt" DATETIME,
    "completedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "tasks_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "tasks_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "clients" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "tasks_taskTypeId_fkey" FOREIGN KEY ("taskTypeId") REFERENCES "task_types" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "tasks_assigneeId_fkey" FOREIGN KEY ("assigneeId") REFERENCES "users" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "tasks_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- AlterTable: cada registro apunta ya a su tarea
ALTER TABLE "time_entries" ADD COLUMN "taskId" TEXT;

-- CreateIndex
CREATE INDEX "tasks_projectId_status_idx" ON "tasks"("projectId", "status");
CREATE INDEX "tasks_assigneeId_status_idx" ON "tasks"("assigneeId", "status");
CREATE INDEX "tasks_status_idx" ON "tasks"("status");
CREATE INDEX "time_entries_taskId_idx" ON "time_entries"("taskId");

-- ===========================================================================
--  BACKFILL agrupado: los tramos que eran la misma tarea forman UNA tarea
--  (el guard con NOT IN hace la migracion idempotente)
-- ===========================================================================
INSERT INTO "tasks" (
    "id", "title", "description", "status", "projectId", "clientId", "taskTypeId",
    "assigneeId", "createdById", "priority",
    "totalSeconds", "entryCount", "firstWorkedAt", "lastWorkedAt",
    "completedAt", "createdAt", "updatedAt"
)
SELECT
    'tarea_' || MIN("id"),
    MIN("title"),
    MAX("description"),
    CASE WHEN MAX(CASE WHEN "status" IN ('RUNNING', 'PAUSED') THEN 1 ELSE 0 END) = 1
         THEN 'IN_PROGRESS' ELSE 'DONE' END,
    "projectId",
    "clientId",
    "taskTypeId",
    "userId",
    "userId",
    'NORMAL',
    SUM(COALESCE("durationSec", 0)),
    COUNT("id"),
    MIN("startedAt"),
    MAX(COALESCE("endedAt", "startedAt")),
    CASE WHEN MAX(CASE WHEN "status" IN ('RUNNING', 'PAUSED') THEN 1 ELSE 0 END) = 1
         THEN NULL ELSE MAX(COALESCE("endedAt", "startedAt")) END,
    MIN("createdAt"),
    MAX("updatedAt")
FROM "time_entries"
WHERE NOT EXISTS (
    SELECT 1 FROM "tasks" t WHERE t."id" = 'tarea_' || "time_entries"."id"
)
GROUP BY
    COALESCE("title", ''), "projectId", "clientId", "taskTypeId", "userId";

-- Enlazar cada registro con la tarea de su grupo
UPDATE "time_entries"
SET "taskId" = (
    SELECT 'tarea_' || MIN(e2."id")
    FROM "time_entries" e2
    WHERE COALESCE(e2."title", '') = COALESCE("time_entries"."title", '')
      AND COALESCE(e2."projectId", '') = COALESCE("time_entries"."projectId", '')
      AND COALESCE(e2."clientId", '') = COALESCE("time_entries"."clientId", '')
      AND COALESCE(e2."taskTypeId", '') = COALESCE("time_entries"."taskTypeId", '')
      AND e2."userId" = "time_entries"."userId"
)
WHERE "taskId" IS NULL;
