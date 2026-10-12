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
  /** Ver el control de facturación y generar el reporte entregable al cliente. */
  BILLING_READ: 'billing:read',
  /** Marcar tiquetes como facturados/pagados y editar sus datos de cobro. */
  BILLING_WRITE: 'billing:write',
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
      PERMISSIONS.BILLING_READ,
      PERMISSIONS.BILLING_WRITE,
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
  /** Tarea a la que pertenece este tramo (una tarea agrupa varios registros). */
  taskId?: string | null;
  taskTitle?: string | null;
  taskStatus?: string | null;
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

// ---------------------------------------------------------------------------
// Facturación: estado del tiquete (tarea) y moneda
//
// El estado vive en la TAREA porque se factura trabajo entregado, y un tiquete
// puede acumular varios tramos de tiempo. `invoiceRef` (nº de factura) es lo que
// agrupa varias tareas en una misma factura.
// ---------------------------------------------------------------------------
export const BILLING_STATUSES = ['PENDING', 'BILLED', 'PAID'] as const;
export type BillingStatus = (typeof BILLING_STATUSES)[number];

export const BILLING_STATUS_LABEL: Record<string, string> = {
  PENDING: 'Pendiente de facturar',
  BILLED: 'Facturado',
  PAID: 'Pagado',
};

/** Etiqueta corta para tablas y badges. */
export const BILLING_STATUS_SHORT: Record<string, string> = {
  PENDING: 'Pendiente',
  BILLED: 'Facturado',
  PAID: 'Pagado',
};

/** De donde salio la tarifa aplicada a un tiquete. */
export type RateSource = 'TASK' | 'PROJECT' | 'CLIENT';

export const RATE_SOURCE_LABEL: Record<string, string> = {
  TASK: 'Tarifa del tiquete',
  PROJECT: 'Tarifa del proyecto',
  CLIENT: 'Tarifa del cliente',
};

export interface CurrencyOption {
  code: string;
  label: string;
  /** Decimales con los que se presenta la moneda (COP y CLP no usan centavos). */
  decimals: number;
}

export const CURRENCIES: CurrencyOption[] = [
  { code: 'COP', label: 'Peso colombiano (COP)', decimals: 0 },
  { code: 'USD', label: 'Dólar estadounidense (USD)', decimals: 2 },
  { code: 'EUR', label: 'Euro (EUR)', decimals: 2 },
  { code: 'MXN', label: 'Peso mexicano (MXN)', decimals: 2 },
  { code: 'PEN', label: 'Sol peruano (PEN)', decimals: 2 },
  { code: 'CLP', label: 'Peso chileno (CLP)', decimals: 0 },
  { code: 'ARS', label: 'Peso argentino (ARS)', decimals: 2 },
  { code: 'BRL', label: 'Real brasileño (BRL)', decimals: 2 },
  { code: 'UYU', label: 'Peso uruguayo (UYU)', decimals: 2 },
  { code: 'PYG', label: 'Guaraní paraguayo (PYG)', decimals: 0 },
  { code: 'BOB', label: 'Boliviano (BOB)', decimals: 2 },
  { code: 'GTQ', label: 'Quetzal guatemalteco (GTQ)', decimals: 2 },
  { code: 'CRC', label: 'Colón costarricense (CRC)', decimals: 2 },
  { code: 'DOP', label: 'Peso dominicano (DOP)', decimals: 2 },
  { code: 'PAB', label: 'Balboa panameño (PAB)', decimals: 2 },
  { code: 'CAD', label: 'Dólar canadiense (CAD)', decimals: 2 },
  { code: 'GBP', label: 'Libra esterlina (GBP)', decimals: 2 },
];

export const DEFAULT_CURRENCY = 'COP';

/** Decimales de una moneda (2 si no esta en el catalogo). */
export const currencyDecimals = (code: string | null | undefined): number =>
  CURRENCIES.find((c) => c.code === (code ?? '').toUpperCase())?.decimals ?? 2;

/** Redondeo monetario con los decimales de la moneda. */
export const roundMoney = (value: number, currency: string | null | undefined): number => {
  const factor = 10 ** currencyDecimals(currency);
  return Math.round(value * factor) / factor;
};

// ---------------------------------------------------------------------------
// DTOs del reporte de horas entregable al cliente ("estado de horas")
// ---------------------------------------------------------------------------
export interface StatementTotals {
  seconds: number;
  hours: number;
  /** Importe valorado con la tarifa vigente (para lo ya facturado, el congelado). */
  amount: number;
}

export interface StatementEntry {
  id: string;
  startedAt: string;
  endedAt: string | null;
  userName: string;
  title: string | null;
  description: string | null;
  seconds: number;
  hours: number;
  billable: boolean;
}

/** Un tiquete (tarea) tal como se le presenta al cliente. */
export interface StatementTicket {
  id: string;
  /** Nº de tiquete con el que el cliente lo identifica. */
  reference: string | null;
  title: string;
  description: string | null;
  /** Estado de la tarea: OPEN | IN_PROGRESS | DONE | CANCELLED */
  status: string;
  statusLabel: string;
  projectId: string | null;
  projectName: string | null;
  taskTypeName: string | null;
  /** Personas que trabajaron en el tiquete. */
  assignees: string[];
  seconds: number;
  hours: number;
  billableSeconds: number;
  entryCount: number;
  firstWorkedAt: string | null;
  lastWorkedAt: string | null;
  /** Tarifa por hora aplicada y de donde salio. */
  rate: number | null;
  rateSource: RateSource | null;
  /** Horas x tarifa (lo que vale el trabajo de este tiquete). */
  amount: number | null;
  billingStatus: string;
  billedAt: string | null;
  paidAt: string | null;
  invoiceRef: string | null;
  /** Importe congelado al facturar (null si nunca se facturo). */
  billedAmount: number | null;
  /** Importe efectivamente cobrado (congelado si existe, si no el calculado). */
  chargedAmount: number | null;
  /** Detalle de tramos; solo si se pidio `withEntries`. */
  entries?: StatementEntry[];
}

export interface StatementProjectGroup {
  projectId: string | null;
  projectName: string;
  tickets: number;
  seconds: number;
  hours: number;
  amount: number;
}

export interface ClientStatement {
  client: { id: string; name: string; code: string | null };
  /** Emisor del reporte (lo que se configura en Ajustes). */
  company: { name: string; taxId: string | null };
  currency: string;
  range: { from: string; to: string; label: string };
  generatedAt: string;
  /** true si el reporte incluye horas que ya estaban facturadas. */
  includeBilled: boolean;
  /** Alcance de usuarios incluido (para que el reporte sea honesto). */
  scope: 'me' | 'team' | 'all';
  totals: {
    /** Todo el trabajo del periodo, se cobre o no. */
    all: StatementTotals;
    pending: StatementTotals;
    billed: StatementTotals;
    paid: StatementTotals;
    /** Facturado y aun no cobrado. */
    receivable: number;
    tickets: number;
    entries: number;
    users: number;
  };
  byProject: StatementProjectGroup[];
  tickets: StatementTicket[];
  /**
   * Horas registradas SIN tiquete: no se pueden agrupar ni facturar por tiquete,
   * asi que se informan aparte para que el reporte cuadre con lo trabajado.
   */
  unticketed: { seconds: number; hours: number; entries: number };
}

// ---------------------------------------------------------------------------
// DTOs del control de facturación (pantalla "Facturación")
// ---------------------------------------------------------------------------
export interface BillingTicketRow {
  id: string;
  reference: string | null;
  title: string;
  status: string;
  statusLabel: string;
  clientId: string | null;
  clientName: string | null;
  projectId: string | null;
  projectName: string | null;
  taskTypeName: string | null;
  assigneeName: string | null;
  seconds: number;
  hours: number;
  entryCount: number;
  rate: number | null;
  rateSource: RateSource | null;
  amount: number | null;
  billingStatus: string;
  billedAt: string | null;
  paidAt: string | null;
  invoiceRef: string | null;
  billedAmount: number | null;
  chargedAmount: number | null;
  firstWorkedAt: string | null;
  lastWorkedAt: string | null;
}

export interface BillingClientGroup {
  clientId: string | null;
  clientName: string;
  tickets: number;
  seconds: number;
  hours: number;
  amount: number;
  pendingHours: number;
  pendingAmount: number;
  billedHours: number;
  billedAmount: number;
  paidHours: number;
  paidAmount: number;
}

/** Una factura = el conjunto de tiquetes marcados con el mismo nº de factura. */
export interface InvoiceGroup {
  invoiceRef: string;
  clientNames: string[];
  tickets: number;
  seconds: number;
  hours: number;
  amount: number;
  /** PENDING si algun tiquete sigue pendiente; PAID si todos estan pagados. */
  billingStatus: string;
  billedAt: string | null;
  paidAt: string | null;
  taskIds: string[];
}

export interface BillingOverview {
  range: { from: string; to: string; label: string };
  currency: string;
  scope: 'me' | 'team' | 'all';
  tickets: BillingTicketRow[];
  total: number;
  totals: {
    all: StatementTotals;
    pending: StatementTotals;
    billed: StatementTotals;
    paid: StatementTotals;
    receivable: number;
    tickets: number;
    pendingTickets: number;
    billedTickets: number;
    paidTickets: number;
  };
  byClient: BillingClientGroup[];
  invoices: InvoiceGroup[];
  unticketed: { seconds: number; hours: number; entries: number };
  /**
   * Pendiente de facturar en TODO el historial (ignora el periodo elegido).
   * Es la red de seguridad para no perder trabajo sin cobrar de meses pasados
   * cuando la pantalla está acotada a un periodo.
   */
  historicalPending: StatementTotals & { tickets: number };
}

export const formatHours = (seconds: number, digits = 2): number =>
  Math.round((seconds / 3600) * 10 ** digits) / 10 ** digits;

export const formatDuration = (seconds: number): string => {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
};
