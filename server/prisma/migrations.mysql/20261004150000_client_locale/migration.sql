-- ===========================================================================
--  IDIOMA DEL REPORTE POR CLIENTE (version MySQL).
--  Ver server/prisma/migrations/20261004150000_client_locale/migration.sql
--
--  El idioma del reporte vive en el cliente (es el destinatario del documento),
--  no en el usuario que lo genera. DEFAULT 'es' para que los clientes que ya
--  existen conserven el idioma con el que se les ha venido reportando.
-- ===========================================================================

ALTER TABLE `clients` ADD COLUMN `locale` VARCHAR(8) NOT NULL DEFAULT 'es';
