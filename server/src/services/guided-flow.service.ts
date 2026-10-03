import { prisma } from '../db/prisma';
import { normalize } from './resolve.service';

/**
 * Flujo guiado de alta desde el bot.
 *
 * Cuando un trabajador empieza una tarea y el cliente o el proyecto NO existen,
 * el bot no se limita a decir "no encontre el proyecto": guarda el estado de la
 * conversacion y le guia para crearlos, reutilizando lo que ya habia dicho
 * (proyecto, cliente, tipo de tarea y titulo) para arrancar el cronometro al
 * terminar el alta.
 *
 * El estado vive en memoria con caducidad: es una conversacion corta y, si el
 * proceso se reinicia, el usuario solo tiene que volver a escribir la tarea.
 */

export type FlowStep =
  | 'NONE'
  | 'ASK_CLIENT_NAME'
  | 'CONFIRM_PROJECT'
  | 'ASK_PROJECT_NAME'
  | 'ASK_TASKTYPE_NAME';

/** Que se pretendia al crear: solo el catalogo o iniciar una tarea despues. */
export type FlowMode = 'START_TASK' | 'CATALOG_CLIENT' | 'CATALOG_PROJECT' | 'CATALOG_TASKTYPE';

export interface GuidedFlow {
  step: FlowStep;
  /** Intencion del flujo (crear catalogo vs. arrancar la tarea al terminar). */
  mode?: FlowMode;
  /** Si tras crear el proyecto hay que arrancar el cronometro. */
  startAfterCreate?: boolean;
  /** Texto original que disparo la tarea (para reutilizarlo al iniciar). */
  originalText: string;
  projectName?: string;
  clientName?: string;
  taskTypeName?: string;
  title?: string;
  /** Cliente creado o elegido en el flujo. */
  clientId?: string;
  clientLabel?: string;
  createdAt: number;
}

const FLOWS = new Map<string, GuidedFlow>();
const FLOW_TTL_MS = 15 * 60 * 1000;

export function getFlow(userId: string): GuidedFlow | null {
  const flow = FLOWS.get(userId);
  if (!flow) return null;
  if (Date.now() - flow.createdAt > FLOW_TTL_MS) {
    FLOWS.delete(userId);
    return null;
  }
  return flow;
}

export function setFlow(userId: string, flow: Omit<GuidedFlow, 'createdAt'>): GuidedFlow {
  const stored: GuidedFlow = { ...flow, createdAt: Date.now() };
  FLOWS.set(userId, stored);
  return stored;
}

/**
 * Actualiza un flujo existente. Devuelve null si NO habia flujo: no lo crea.
 *
 * Ojo: para abrir un flujo nuevo hay que usar `setFlow` (o `startFlow`, que
 * crea-o-actualiza). Usar `updateFlow` sin flujo previo es un no-op silencioso,
 * que fue justo el error que impedia crear proyectos desde el menu.
 */
export function updateFlow(userId: string, patch: Partial<GuidedFlow>): GuidedFlow | null {
  const flow = getFlow(userId);
  if (!flow) return null;
  const updated = { ...flow, ...patch, createdAt: Date.now() };
  FLOWS.set(userId, updated);
  return updated;
}

/**
 * Crea el flujo si no existe o lo actualiza si ya estaba.
 * Es lo que quieren casi todos los puntos de entrada.
 */
export function startFlow(
  userId: string,
  initial: Pick<GuidedFlow, 'step'> & Partial<Omit<GuidedFlow, 'step'>>,
): GuidedFlow {
  const existing = getFlow(userId);
  return setFlow(userId, {
    originalText: '',
    startAfterCreate: false,
    ...(existing ?? {}),
    ...initial,
  });
}

export function clearFlow(userId: string): void {
  FLOWS.delete(userId);
}

// ---------------------------------------------------------------------------
// Alta de cliente y proyecto
// ---------------------------------------------------------------------------
export interface CreatedClient {
  id: string;
  name: string;
  created: boolean;
}

/**
 * Busca el cliente por nombre (tolerante a mayusculas/acentos) y lo crea si no
 * existe. Si ya existe no lo duplica: devuelve el existente con created=false.
 */
export async function findOrCreateClient(name: string): Promise<CreatedClient> {
  const clean = name.trim().replace(/\s+/g, ' ');
  if (clean.length < 2) throw new Error('El nombre del cliente es demasiado corto');

  const all = await prisma.client.findMany({ select: { id: true, name: true, code: true } });
  const normalizedQuery = normalize(clean);
  const found = all.find(
    (c) => normalize(c.name) === normalizedQuery || (c.code && normalize(c.code) === normalizedQuery),
  );
  if (found) {
    // Si estaba desactivado, se reactiva: el usuario lo esta usando ahora.
    const client = await prisma.client.update({ where: { id: found.id }, data: { isActive: true } });
    return { id: client.id, name: client.name, created: false };
  }

  const client = await prisma.client.create({ data: { name: clean } });
  return { id: client.id, name: client.name, created: true };
}

export interface CreatedProject {
  id: string;
  name: string;
  clientId: string;
  clientName: string;
  githubRepos: string | null;
  created: boolean;
}

/** Crea el proyecto dentro del cliente (o devuelve el existente si ya estaba). */
export async function findOrCreateProject(clientId: string, name: string, userId?: string): Promise<CreatedProject> {
  const clean = name.trim().replace(/\s+/g, ' ');
  if (clean.length < 2) throw new Error('El nombre del proyecto es demasiado corto');

  const existing = await prisma.clientProject.findFirst({
    where: { clientId, name: { equals: clean } },
    include: { client: { select: { name: true } } },
  });

  if (existing) {
    const project = await prisma.clientProject.update({
      where: { id: existing.id },
      data: { isActive: true },
      include: { client: { select: { name: true } } },
    });
    if (userId) await ensureMembership(project.id, userId);
    return {
      id: project.id,
      name: project.name,
      clientId: project.clientId,
      clientName: project.client.name,
      githubRepos: project.githubRepos,
      created: false,
    };
  }

  const project = await prisma.clientProject.create({
    data: { clientId, name: clean },
    include: { client: { select: { name: true } } },
  });
  // El creador queda como miembro para que lo vea en sus proximos mensajes.
  if (userId) await ensureMembership(project.id, userId, 'OWNER');

  return {
    id: project.id,
    name: project.name,
    clientId: project.clientId,
    clientName: project.client.name,
    githubRepos: project.githubRepos,
    created: true,
  };
}

async function ensureMembership(projectId: string, userId: string, role = 'MEMBER'): Promise<void> {
  const exists = await prisma.projectMember.findUnique({
    where: { projectId_userId: { projectId, userId } },
  });
  if (exists) return;
  await prisma.projectMember.create({ data: { projectId, userId, role } });
}

/** Cliente visible para el usuario: los activos, ordenados por uso reciente. */
export async function recentClients(limit = 8) {
  return prisma.client.findMany({
    where: { isActive: true },
    orderBy: { updatedAt: 'desc' },
    take: limit,
    select: { id: true, name: true, _count: { select: { projects: true } } },
  });
}
