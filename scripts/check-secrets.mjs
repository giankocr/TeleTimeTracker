#!/usr/bin/env node
/**
 * Guardia anti-secretos para el repositorio.
 *
 * Uso como hook de Git (recomendado):
 *   ln -sf ../../scripts/check-secrets.mjs .git/hooks/pre-commit
 *
 * Uso manual (revisa todos los archivos versionados):
 *   node scripts/check-secrets.mjs            # solo archivos versionados
 *   node scripts/check-secrets.mjs --staged   # solo lo que esta en el indice (hook)
 *   node scripts/check-secrets.mjs --all      # todo el arbol menos lo ignorado
 *
 * Sale con codigo 1 y muestra el archivo:linea si encuentra algo sospechoso,
 * de modo que un commit con credenciales no llega nunca al repositorio.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const useStaged = args.includes('--staged');
const scanAll = args.includes('--all');

/** Patrones de credenciales reales (no placeholders). */
const PATTERNS = [
  { name: 'Telegram bot token', re: /\b\d{8,12}:[A-Za-z0-9_-]{30,}\b/ },
  { name: 'OpenAI API key', re: /\bsk-[A-Za-z0-9_-]{20,}\b/ },
  { name: 'Anthropic API key', re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/ },
  { name: 'GitHub token', re: /\b(gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})\b/ },
  { name: 'AWS access key', re: /\b(AKIA|ASIA)[A-Z0-9]{16}\b/ },
  { name: 'Google API key', re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { name: 'Stripe key', re: /\b(sk|rk)_(live|test)_[A-Za-z0-9]{20,}\b/ },
  { name: 'Slack token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { name: 'Private key block', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  // Webhook de deploy de EasyPanel: la URL lleva el token en la ruta.
  { name: 'EasyPanel deploy webhook', re: /\/api\/deploy\/[a-f0-9]{32,}/i },
  { name: 'Webhook de deploy (generic)', re: /https?:\/\/[^\s"']+\/deploy\/[A-Za-z0-9_-]{24,}/i },
  // Secretos "de este proyecto": cualquier valor no vacio con nombre reconocible.
  {
    name: 'Secreto asignado en un archivo',
    re: /\b(JWT_SECRET|SETTINGS_ENC_KEY|TELEGRAM_WEBHOOK_SECRET|API_SERVICE_SECRET|ADMIN_PASSWORD)\s*[=:]\s*["']?(?!<|\$\{|cambia-|CAMBIALO|changeme|your-|xxx|placeholder|valor enmascarado)([A-Za-z0-9_\-!@#$%^&*]{12,})/i,
  },
];

/** Archivos que nunca deben versionarse. */
const FORBIDDEN_FILES = [
  /(^|\/)\.env$/,
  /(^|\/)\.env\.(local|production|prod|development|dev)$/,
  /\.db$/,
  /\.db-wal$/,
  /\.db-shm$/,
  /\.pem$/,
  /(^|\/)id_rsa$/,
  /(^|\/)id_ed25519$/,
  /(^|\/)\.npmrc$/,
];

/** Archivos exentos de revisar (documentacion con ejemplos, tests, el propio script). */
const ALLOWLIST = [
  /^\.env\.example$/,
  /^README\.md$/,
  /^scripts\/check-secrets\.mjs$/,
  /\.example$/,
  /\.md$/,
];

const projectRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
process.chdir(projectRoot);

/** Ejecuta git y devuelve la lista de archivos (formato NUL: soporta espacios). */
function gitList(args) {
  const out = execFileSync('git', ['-c', 'core.quotepath=false', ...args, '-z'], { encoding: 'utf8' });
  return out.split('\0').filter(Boolean);
}

/** Archivos que entran en el commit (indice). */
const stagedFiles = () => gitList(['diff', '--cached', '--name-only', '--diff-filter=ACMR']);

/** Archivos ya versionados (HEAD). */
const trackedFiles = () => gitList(['ls-files']);

/** Todo lo relevante del arbol: versionado + nuevos no ignorados. */
const allFiles = () => gitList(['ls-files', '--cached', '--others', '--exclude-standard']);

const files = useStaged ? stagedFiles() : scanAll ? allFiles() : trackedFiles();

const findings = [];
const banned = [];

for (const file of files) {
  const isBinaryOrIgnored = /\.(png|jpe?g|gif|webp|ico|woff2?|ttf|eot|pdf|zip|gz|mp4|ogg|oga|mp3)$/i.test(file);
  if (FORBIDDEN_FILES.some((re) => re.test(file))) {
    banned.push(file);
    continue;
  }
  if (isBinaryOrIgnored) continue;

  let content;
  try {
    content = fs.readFileSync(file, 'utf8');
  } catch {
    continue;
  }
  if (content.length > 2_000_000) continue;

  const exempt = ALLOWLIST.some((re) => re.test(file));
  const lines = content.split('\n');
  lines.forEach((line, index) => {
    for (const pattern of PATTERNS) {
      if (!pattern.re.test(line)) continue;
      // Las plantillas (.env.example, *.example, documentacion) pueden mostrar
      // CUALQUIER valor de ejemplo: nunca deben llevar credenciales reales.
      // Los patrones de arriba (tokens de Telegram/OpenAI/GitHub, claves
      // privadas...) SI se revisan incluso ahi.
      if (exempt && /^[A-Z0-9_]+\s*=/.test(line.trim())) continue;
      if (exempt && /placeholder|ejemplo|example|cambia-esto|openssl rand|<[a-z-]+>/i.test(line)) continue;
      findings.push({ file, line: index + 1, name: pattern.name, text: line.trim().slice(0, 120) });
    }
  });
}

if (banned.length || findings.length) {
  console.error('\n❌ Commit bloqueado: se detectaron posibles secretos o archivos prohibidos.\n');
  if (banned.length) {
    console.error('Archivos que no deben versionarse:');
    for (const file of banned) console.error(`  - ${file}`);
    console.error('  → quitalos del indice con: git rm --cached <archivo>\n');
  }
  if (findings.length) {
    console.error('Coincidencias sospechosas:');
    for (const f of findings) console.error(`  - ${f.file}:${f.line}  [${f.name}]\n      ${f.text}`);
    console.error('\n  → mueve el valor a .env (ignorado por Git) o usa una variable de entorno.\n');
  }
  process.exit(1);
}

console.log(`✅ Sin secretos detectados (${files.length} archivo(s) revisado(s)).`);
