#!/usr/bin/env node
/**
 * Genera `server/prisma/schema.mysql.prisma` a partir del esquema base.
 *
 * MOTIVO: el esquema base usa `provider = "sqlite"`, donde Prisma asigna
 * `TEXT` a los campos String (sin límite). En MySQL el equivalente por defecto
 * es `VARCHAR(191)`, que TRUNCARÍA campos que el sistema escribe más largos
 * (transcripciones del NLU, descripciones de hasta 4000 caracteres, listas de
 * permisos, etc.). Además MySQL no acepta tipos nativos con el provider sqlite,
 * así que no se pueden anotar en el esquema base sin romper el modo SQLite.
 *
 * SOLUCIÓN: un único origen de verdad (schema.prisma) y este generador que:
 *   1. cambia el provider a "mysql"
 *   2. añade las anotaciones @db.* necesarias
 *
 * Uso:  node scripts/generate-mysql-schema.mjs [--check]
 *       --check  falla si el archivo generado no coincide (para CI)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = path.join(root, 'server/prisma/schema.prisma');
const TARGET = path.join(root, 'server/prisma/schema.mysql.prisma');

/**
 * Campo -> tipo nativo de MySQL.
 * - Text     : contenido libre largo (sin límite práctico)
 * - VarChar  : cadenas con tamaño conocido; tamaño > 0 para poder indexarlas
 *              (MySQL limita las claves indexadas, de ahí los tamaños compactos)
 */
const NATIVE_TYPES = {
  // --- identidad y seguridad ---
  // `permissions` es la lista de permisos separada por comas (crece con el
  // catalogo) y lleva DEFAULT '': MySQL no admite DEFAULT literal en TEXT
  // (error 1101), asi que se usa VarChar con holgura.
  Role: { key: 'VarChar(40)', name: 'VarChar(80)', description: 'Text', permissions: 'VarChar(600)' },
  User: {
    email: 'VarChar(160)',
    passwordHash: 'VarChar(100)',
    fullName: 'VarChar(120)',
    telegramId: 'VarChar(32)',
    telegramUsername: 'VarChar(80)',
    telegramLinkCode: 'VarChar(16)',
    phone: 'VarChar(20)',
    otpCodeHash: 'VarChar(64)',
    githubUsername: 'VarChar(80)',
    githubToken: 'VarChar(300)',
    workDays: 'VarChar(20)',
    workStart: 'VarChar(5)',
    workEnd: 'VarChar(5)',
    timezone: 'VarChar(64)',
    locale: 'VarChar(8)',
  },
  AuthSession: { refreshHash: 'VarChar(64)', userAgent: 'VarChar(255)', ip: 'VarChar(64)' },

  // --- catálogo ---
  Client: { name: 'VarChar(120)', code: 'VarChar(40)', notes: 'Text' },
  ClientProject: {
    name: 'VarChar(120)',
    description: 'Text',
    githubRepos: 'Text',
  },
  ProjectMember: { role: 'VarChar(16)' },
  // `aliases` tambien lleva DEFAULT '' -> no puede ser TEXT (error 1101 de MySQL).
  Task: {
    title: 'VarChar(200)',
    description: 'Text',
    status: 'VarChar(16)',
    priority: 'VarChar(10)',
  },
  TaskType: { name: 'VarChar(60)', aliases: 'VarChar(300)', color: 'VarChar(9)' },

  // --- tiempos ---
  TimeEntry: {
    title: 'VarChar(180)',
    description: 'Text',
    status: 'VarChar(16)',
    source: 'VarChar(24)',
    closeReason: 'VarChar(24)',
    githubData: 'Text',
  },
  Pause: { reason: 'Text' },
  EntryTag: { tag: 'VarChar(60)' },

  // --- bot y auditoría ---
  PendingTask: { title: 'VarChar(200)', notes: 'Text', priority: 'VarChar(10)' },
  SystemSetting: { key: 'VarChar(80)', value: 'Text' },
  AlertLog: { type: 'VarChar(24)', payload: 'Text' },
  AuditLog: { action: 'VarChar(64)', entity: 'VarChar(32)', entityId: 'VarChar(64)', metadata: 'Text', ip: 'VarChar(64)' },
  BotMessage: {
    telegramId: 'VarChar(32)',
    chatId: 'VarChar(32)',
    kind: 'VarChar(16)',
    rawText: 'Text',
    transcript: 'Text',
    intent: 'VarChar(24)',
    entities: 'Text',
    reply: 'Text',
    error: 'Text',
  },
  BotContact: {
    telegramId: 'VarChar(32)',
    phone: 'VarChar(20)',
    firstName: 'VarChar(80)',
    lastName: 'VarChar(80)',
    username: 'VarChar(80)',
    status: 'VarChar(16)',
    note: 'Text',
  },
};

/** Modelos cuyo `id` es un cuid: cabe holgadamente en VarChar(32). */
const ID_MODELS = new Set(Object.keys(NATIVE_TYPES));

function generate(source) {
  const lines = source.split('\n');
  let currentModel = null;
  const out = [];

  for (const line of lines) {
    // Provider -> mysql
    if (/^\s*provider\s*=\s*"sqlite"/.test(line)) {
      out.push(line.replace('"sqlite"', '"mysql"'));
      continue;
    }

    const modelMatch = line.match(/^model\s+(\w+)\s*\{/);
    if (modelMatch) currentModel = modelMatch[1];
    if (/^\}/.test(line)) currentModel = null;

    // Solo se anotan líneas de campo dentro de un modelo conocido.
    const fieldMatch = currentModel ? line.match(/^(\s*)(\w+)(\s+)(String)(\??)(.*)$/) : null;
    if (fieldMatch && NATIVE_TYPES[currentModel]) {
      const [, indent, field, spaces, type, optional, rest] = fieldMatch;
      // El `id` de los modelos principales es un cuid.
      const native =
        field === 'id' && ID_MODELS.has(currentModel)
          ? 'VarChar(32)'
          : NATIVE_TYPES[currentModel][field];
      if (native && !rest.includes('@db.')) {
        out.push(`${indent}${field}${spaces}${type}${optional}${rest} @db.${native}`);
        continue;
      }
    }
    out.push(line);
  }

  const header = `// ⚠️ ARCHIVO GENERADO — no editar a mano.
// Se crea con: node scripts/generate-mysql-schema.mjs
// Origen de verdad: server/prisma/schema.prisma
// Usado por: prisma migrate (perfil MySQL). Ver README → Base de datos.

`;
  // El bloque de generator/datasource va primero: el comentario se inserta antes.
  return header + out.join('\n');
}

const result = generate(fs.readFileSync(SOURCE, 'utf8'));
const checkOnly = process.argv.includes('--check');

if (checkOnly) {
  const existing = fs.existsSync(TARGET) ? fs.readFileSync(TARGET, 'utf8') : '';
  if (existing !== result) {
    console.error('❌ server/prisma/schema.mysql.prisma está desactualizado.');
    console.error('   Ejecuta: node scripts/generate-mysql-schema.mjs');
    process.exit(1);
  }
  console.log('✅ schema.mysql.prisma está sincronizado con schema.prisma');
  process.exit(0);
}

fs.writeFileSync(TARGET, result);
const annotated = (result.match(/@db\./g) || []).length;
console.log(`✅ Generado ${path.relative(root, TARGET)} (${annotated} anotaciones @db.*)`);
