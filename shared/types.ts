/**
 * Contratos compartidos entre backend y panel web.
 * Fuente unica de verdad para permisos, intents del bot y DTOs.
 */

// ---------------------------------------------------------------------------
// RBAC
// ---------------------------------------------------------------------------
export const PERMISSIONS = {
  USERS_READ: 'users:read',
  USERS_WRITE: 'users:write',
  USERS_DELETE: 'users:delete',
  ROLES_READ: 'roles:read',
  ROLES_WRITE: 'roles:write',
  CLIENTS_READ: 'clients:read',
  CLIENTS_WRITE: 'clients:write',
  CLIENTS_DELETE: 'clients:delete',
  PROJECTS_READ: 'projects:read',
  PROJECTS_WRITE: 'projects:write',
  PROJECTS_DELETE: 'projects:delete',
  TASKTYPES_READ: 'tasktypes:read',
  TASKTYPES_WRITE: 'tasktypes:write',
  ENTRIES_READ_OWN: 'entries:read:own',
  ENTRIES_READ_ALL: 'entries:read:all',
  ENTRIES_WRITE: 'entries:write',
  ENTRIES_DELETE: 'entries:delete',
  REPORTS_OWN: 'reports:own',
  REPORTS_TEAM: 'reports:team',
  REPORTS_ALL: 'reports:all',
  SETTINGS_READ: 'settings:read',
  SETTINGS_WRITE: 'settings:write',
  AUDIT_READ: 'audit:read',
  BOT_ADMIN: 'bot:admin',
} as const;

export type Permission = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

export const ALL_PERMISSIONS: Permission[] = Object.values(PERMISSIONS);

export const ROLE_PRESETS: Record<string, { name: string; description: string; permissions: string[] }> = {
  ADMIN: {
    name: 'Administrador',
    description: 'Acceso total al sistema, usuarios, configuracion y reportes globales.',
    permissions: ['*'],
  },
  MANAGER: {
    name: 'Manager / Supervisor',
    description: 'Gestiona clientes, proyectos y reportes de su equipo.',
    permissions: [
      PERMISSIONS.USERS_READ,
      PERMISSIONS.ROLES_READ,
      PERMISSIONS.CLIENTS_READ,
      PERMISSIONS.CLIENTS_WRITE,
      PERMISSIONS.PROJECTS_READ,
      PERMISSIONS.PROJECTS_WRITE,
      PERMISSIONS.TASKTYPES_READ,
      PERMISSIONS.TASKTYPES_WRITE,
      PERMISSIONS.ENTRIES_READ_OWN,
      PERMISSIONS.ENTRIES_READ_ALL,
      PERMISSIONS.ENTRIES_WRITE,
      PERMISSIONS.REPORTS_OWN,
      PERMISSIONS.REPORTS_TEAM,
      PERMISSIONS.SETTINGS_READ,
    ],
  },
  USER: {
    name: 'Empleado',
    description: 'Consulta su propio historial, edita su perfil y vincula su Telegram.',
    permissions: [
      PERMISSIONS.CLIENTS_READ,
      PERMISSIONS.PROJECTS_READ,
      PERMISSIONS.TASKTYPES_READ,
      PERMISSIONS.ENTRIES_READ_OWN,
      PERMISSIONS.ENTRIES_WRITE,
      PERMISSIONS.REPORTS_OWN,
    ],
  },
};

// ---------------------------------------------------------------------------
// Bot: intents reconocidos por el NLU
// ---------------------------------------------------------------------------
export type BotIntent =
  | 'START'
  | 'STOP'
  | 'PAUSE'
  | 'RESUME'
  | 'SWITCH'
  | 'STATUS'
  | 'REPORT'
  | 'AGENDA'
  | 'LINK'
  | 'HELP'
  | 'UNKNOWN';

export interface ParsedEntities {
  clientName?: string;
  projectName?: string;
  taskTypeName?: string;
  title?: string;
  description?: string;
  tag?: string;
  /** ISO date: usado en "reporte de ayer" o "que hice el lunes" */
  date?: string;
}

export interface ParsedCommand {
  intent: BotIntent;
  confidence: number;
  entities: ParsedEntities;
  engine: 'openai' | 'heuristic';
  rawText: string;
}

// ---------------------------------------------------------------------------
// DTOs API
// ---------------------------------------------------------------------------
export interface ApiUser {
  id: string;
  email: string;
  fullName: string;
  isActive: boolean;
  role: { id: string; key: string; name: string; permissions: string[] };
  managerId: string | null;
  managerName?: string | null;
  telegramId: string | null;
  telegramUsername: string | null;
  telegramLinkedAt: string | null;
  githubUsername: string | null;
  hasGithubToken: boolean;
  timezone: string;
  workDays: number[];
  workStart: string;
  workEnd: string;
  idleAlertMin: number;
  dailyDigest: boolean;
  createdAt: string;
}

export interface ApiTimeEntry {
  id: string;
  userId: string;
  userName?: string;
  clientId: string | null;
  clientName?: string | null;
  projectId: string | null;
  projectName?: string | null;
  taskTypeId: string | null;
  taskTypeName?: string | null;
  title: string | null;
  description: string | null;
  startedAt: string;
  endedAt: string | null;
  durationSec: number;
  status: 'RUNNING' | 'PAUSED' | 'FINISHED' | 'CANCELLED';
  billable: boolean;
  source: string;
  closeReason: string | null;
  tags: string[];
}

export interface ReportBucket {
  key: string;
  label: string;
  /** Horas decimales (para graficos y tablas del panel). */
  hours: number;
  /** Segundos exactos (para mensajes del bot y duraciones cortas). */
  seconds: number;
  billableHours: number;
  billableSeconds: number;
  entries: number;
}

export interface DashboardReport {
  range: { from: string; to: string };
  totals: {
    /** Horas decimales (redondeadas a 2 digitos). */
    totalHours: number;
    /** Segundos exactos: evita perder precision en duraciones cortas. */
    totalSeconds: number;
    billableHours: number;
    entries: number;
    users: number;
    runningNow: number;
    avgHoursPerUser: number;
  };
  byClient: ReportBucket[];
  byProject: ReportBucket[];
  byUser: ReportBucket[];
  byTaskType: ReportBucket[];
  daily: { date: string; hours: number; billableHours: number }[];
}

export const formatHours = (seconds: number, digits = 2): number =>
  Math.round((seconds / 3600) * 10 ** digits) / 10 ** digits;

export const formatDuration = (seconds: number): string => {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
};
