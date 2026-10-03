import path from 'node:path';
import fs from 'node:fs';
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import { ROLE_PRESETS } from '../../shared/types';
import { env, resolveDatabaseUrl } from '../src/config/env';
/**
 * Seed idempotente: crea roles de sistema, el usuario administrador inicial,
 * tipos de tarea por defecto y una configuracion base.
 * Se puede ejecutar con: npm run seed
 */

const prisma = new PrismaClient({ datasources: { db: { url: resolveDatabaseUrl(process.env.DATABASE_URL) } } });

const DEFAULT_TASK_TYPES = [
  { name: 'Desarrollo', aliases: 'dev, programacion, codigo, feature', color: '#6366f1' },
  { name: 'Maquetacion', aliases: 'front, html, css, ui, layout, landing', color: '#22c55e' },
  { name: 'Backend', aliases: 'api, endpoint, servicio, base de datos', color: '#0ea5e9' },
  { name: 'Reunion', aliases: 'meeting, daily, standup, call, llamada, sync', color: '#f59e0b' },
  { name: 'Soporte', aliases: 'support, ticket, incidente, atencion', color: '#ef4444' },
  { name: 'Bugfix', aliases: 'bug, error, fix, hotfix, correccion', color: '#dc2626' },
  { name: 'QA', aliases: 'testing, pruebas, test, qa', color: '#8b5cf6' },
  { name: 'Documentacion', aliases: 'doc, manual, readme, acta', color: '#64748b' },
  { name: 'Planificacion', aliases: 'estimacion, refinamiento, grooming, backlog', color: '#14b8a6' },
  { name: 'DevOps', aliases: 'deploy, despliegue, release, infra, pipeline', color: '#f97316' },
];

async function seedRoles(): Promise<Record<string, string>> {
  const map: Record<string, string> = {};
  for (const [key, preset] of Object.entries(ROLE_PRESETS)) {
    const role = await prisma.role.upsert({
      where: { key },
      create: {
        key,
        name: preset.name,
        description: preset.description,
        permissions: preset.permissions.join(','),
        isSystem: true,
      },
      update: { name: preset.name, description: preset.description, isSystem: true },
    });
    map[key] = role.id;
  }
  console.log(`✔ roles de sistema: ${Object.keys(map).join(', ')}`);
  return map;
}

async function seedTaskTypes(): Promise<void> {
  for (const type of DEFAULT_TASK_TYPES) {
    await prisma.taskType.upsert({
      where: { name: type.name },
      create: { name: type.name, aliases: type.aliases, color: type.color },
      update: { aliases: type.aliases, color: type.color, isActive: true },
    });
  }
  console.log(`✔ tipos de tarea: ${DEFAULT_TASK_TYPES.length}`);
}

async function seedAdmin(roleIds: Record<string, string>): Promise<void> {
  const email = env.ADMIN_EMAIL.toLowerCase();
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    console.log(`✔ admin ya existe: ${email}`);
    return;
  }
  const admin = await prisma.user.create({
    data: {
      email,
      fullName: env.ADMIN_NAME,
      passwordHash: await bcrypt.hash(env.ADMIN_PASSWORD, 10),
      roleId: roleIds.ADMIN!,
      timezone: env.DEFAULT_TIMEZONE,
      isActive: true,
    },
  });
  console.log(`✔ admin creado: ${admin.email}`);
  if (env.ADMIN_PASSWORD === 'Admin123!') {
    console.warn('⚠  Estas usando la contrasena por defecto. Cambiala en el panel (Perfil → Cambiar contrasena).');
  }
}

async function seedSettings(): Promise<void> {
  const defaults: Array<{ key: string; value: string }> = [
    { key: 'ui.company_name', value: 'TeleTimeTracker' },
    { key: 'alerts.enabled', value: env.ALERTS_ENABLED ? 'true' : 'false' },
    { key: 'alerts.digest_cron', value: env.DIGEST_CRON },
    { key: 'work.default_timezone', value: env.DEFAULT_TIMEZONE },
  ];
  for (const item of defaults) {
    await prisma.systemSetting.upsert({
      where: { key: item.key },
      create: { key: item.key, value: item.value },
      update: {},
    });
  }
  console.log('✔ configuracion base');
}

async function seedDemoData(roleIds: Record<string, string>): Promise<void> {
  const demo = process.env.SEED_DEMO === 'true' || process.env.SEED_DEMO === '1';
  if (!demo) return;

  const client = await prisma.client.upsert({
    where: { name: 'Cliente Demo' },
    create: { name: 'Cliente Demo', code: 'DEMO', notes: 'Datos de ejemplo creados por el seed.' },
    update: {},
  });
  const project = await prisma.clientProject.upsert({
    where: { clientId_name: { clientId: client.id, name: 'Portal Web' } },
    create: {
      clientId: client.id,
      name: 'Portal Web',
      description: 'Proyecto de ejemplo',
      githubRepos: process.env.SEED_DEMO_REPO ?? null,
      budgetHours: 120,
    },
    update: {},
  });

  const managerEmail = 'manager@teletimetracker.local';
  const manager = await prisma.user.findUnique({ where: { email: managerEmail } });
  if (!manager) {
    const created = await prisma.user.create({
      data: {
        email: managerEmail,
        fullName: 'Manager Demo',
        passwordHash: await bcrypt.hash('Manager123!', 10),
        roleId: roleIds.MANAGER!,
        timezone: env.DEFAULT_TIMEZONE,
      },
    });
    await prisma.projectMember.create({ data: { projectId: project.id, userId: created.id, role: 'OWNER' } });
    console.log(`✔ manager demo: ${managerEmail} / Manager123!`);
  }
  console.log('✔ datos demo listos (SEED_DEMO=true)');
}

async function main(): Promise<void> {
  // Asegura que el directorio del volumen exista antes de tocar la BD.
  if (!fs.existsSync(env.DATA_DIR)) fs.mkdirSync(env.DATA_DIR, { recursive: true });
  void path;

  console.log(`→ usando base de datos: ${env.DATABASE_URL}`);
  const roleIds = await seedRoles();
  await seedTaskTypes();
  await seedAdmin(roleIds);
  await seedSettings();
  await seedDemoData(roleIds);
  console.log('✅ seed completado');
}

main()
  .catch((err) => {
    console.error('❌ seed fallo:', err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
