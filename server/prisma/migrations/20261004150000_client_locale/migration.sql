-- ===========================================================================
--  IDIOMA DEL REPORTE POR CLIENTE
--
--  Motivo: el reporte de horas se entrega al cliente, y hay clientes que lo
--  quieren en ingles. El idioma va en el CLIENTE y no en el usuario que genera
--  el documento: la misma persona emite reportes a clientes de idiomas
--  distintos, asi que el idioma es una propiedad del destinatario.
--
--  Columna nueva con DEFAULT: los clientes que ya existen quedan en espanol,
--  que es el idioma en el que se han emitido sus reportes hasta ahora.
-- ===========================================================================

ALTER TABLE "clients" ADD COLUMN "locale" TEXT NOT NULL DEFAULT 'es';
