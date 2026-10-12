-- ===========================================================================
--  TIQUETE Y CONTROL DE FACTURACIÓN
--
--  Motivo: el tiempo se registra por tarea (tiquete), pero no había forma de
--  saber qué trabajo ya se cobró ni de generar un reporte entregable al cliente
--  con el detalle de los tiquetes realizados.
--
--  Decisiones:
--   · El estado de facturación vive en la TAREA, no en cada tramo de tiempo: se
--     factura trabajo entregado y un tiquete agrupa varios tramos.
--   · `invoiceRef` (nº de factura) es lo que AGRUPA varias tareas en una misma
--     factura, sin necesidad de crear una entidad Factura aparte.
--   · `billedAmount` se CONGELA al facturar: si después se registran más horas
--     en la misma tarea, el importe ya cobrado no cambia bajo los pies.
--   · La tarifa se resuelve en cascada: tarea -> proyecto -> cliente.
--
--  Todo son columnas nuevas con DEFAULT o NULL, así que la migración es segura
--  sobre datos existentes (las tareas que ya había quedan PENDING, sin factura).
-- ===========================================================================

-- Tarifa por hora de referencia del cliente (respaldo de la del proyecto).
ALTER TABLE "clients" ADD COLUMN "hourlyRate" REAL;

-- Nº de tiquete con el que el cliente identifica el trabajo.
ALTER TABLE "tasks" ADD COLUMN "reference" TEXT;

-- Estado de facturación del tiquete.
ALTER TABLE "tasks" ADD COLUMN "billingStatus" TEXT NOT NULL DEFAULT 'PENDING';
ALTER TABLE "tasks" ADD COLUMN "billedAt" DATETIME;
ALTER TABLE "tasks" ADD COLUMN "paidAt" DATETIME;
ALTER TABLE "tasks" ADD COLUMN "invoiceRef" TEXT;
ALTER TABLE "tasks" ADD COLUMN "billedAmount" REAL;
ALTER TABLE "tasks" ADD COLUMN "hourlyRate" REAL;

-- CreateIndex
CREATE INDEX "tasks_clientId_billingStatus_idx" ON "tasks"("clientId", "billingStatus");

-- CreateIndex
CREATE INDEX "tasks_invoiceRef_idx" ON "tasks"("invoiceRef");
