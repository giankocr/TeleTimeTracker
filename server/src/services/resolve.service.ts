import { prisma } from '../db/prisma';

/**
 * Resolucion de entidades por nombre (para el bot de voz/texto y el panel).
 * Estrategia: normalizacion + matching exacto -> prefijo -> contiene -> fuzzy (Levenshtein).
 */

export function normalize(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const curr = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    prev = curr;
  }
  return prev[b.length];
}

export function similarity(a: string, b: string): number {
  const na = normalize(a);
  const nb = normalize(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  const dist = levenshtein(na, nb);
  const ratio = 1 - dist / Math.max(na.length, nb.length);
  if (na.includes(nb) || nb.includes(na)) return Math.max(ratio, 0.85);
  return ratio;
}

export interface Candidate {
  id: string;
  name: string;
  aliases?: string[];
}

export interface MatchResult<T extends Candidate> {
  item: T | null;
  score: number;
  ambiguous: T[];
}

export function bestMatch<T extends Candidate>(query: string, candidates: T[], threshold = 0.62): MatchResult<T> {
  if (!query || !candidates.length) return { item: null, score: 0, ambiguous: [] };
  const scored = candidates
    .map((item) => {
      const scores = [similarity(query, item.name), ...(item.aliases ?? []).map((a) => similarity(query, a))];
      return { item, score: Math.max(...scores) };
    })
    .sort((a, b) => b.score - a.score);

  const best = scored[0]!;
  const ambiguous = scored.filter((s) => s !== best && s.score >= threshold && best.score - s.score < 0.08).map((s) => s.item);
  return { item: best.score >= threshold ? best.item : null, score: best.score, ambiguous };
}

// ---------------------------------------------------------------------------
// Resolucion contra la BD
// ---------------------------------------------------------------------------
export interface ResolvedProject {
  id: string;
  name: string;
  clientId: string;
  clientName: string;
  githubRepos: string | null;
}

/** Proyectos visibles para el usuario (miembro o todos si es admin/manager global). */
export async function listVisibleProjects(userId: string, roleKey: string) {
  const isPrivileged = roleKey === 'ADMIN' || roleKey === 'MANAGER';
  const projects = await prisma.clientProject.findMany({
    where: {
      isActive: true,
      client: { isActive: true },
      ...(isPrivileged ? {} : { members: { some: { userId } } }),
    },
    // `code` se usa para que el bot reconozca tambien el codigo corto del proyecto.
    include: { client: true },
    orderBy: { name: 'asc' },
  });
  // Si un empleado no tiene membresias asignadas, se le permite ver todo (evita bloqueos).
  if (!projects.length && !isPrivileged) {
    const all = await prisma.clientProject.findMany({
      where: { isActive: true, client: { isActive: true } },
      include: { client: true },
      orderBy: { name: 'asc' },
    });
    return all;
  }
  return projects;
}

export function toResolved(project: { id: string; name: string; githubRepos: string | null; client: { id: string; name: string } }): ResolvedProject {
  return {
    id: project.id,
    name: project.name,
    clientId: project.client.id,
    clientName: project.client.name,
    githubRepos: project.githubRepos,
  };
}

/**
 * Encuentra el proyecto a partir de texto libre. Considera el nombre del proyecto,
 * el del cliente y combinaciones tipo "proyecto X del cliente Y".
 */
export async function resolveProject(
  userId: string,
  roleKey: string,
  hints: { projectName?: string; clientName?: string; rawText?: string },
): Promise<{ project: ResolvedProject | null; score: number; ambiguous: ResolvedProject[]; available: ResolvedProject[] }> {
  const rows = await listVisibleProjects(userId, roleKey);
  const available = rows.map(toResolved);
  if (!available.length) return { project: null, score: 0, ambiguous: [], available };

  const candidates = rows.map((p) => ({
    id: p.id,
    name: p.name,
    aliases: [p.client.name, `${p.name} ${p.client.name}`, `${p.client.name} ${p.name}`].filter(
      (v): v is string => Boolean(v),
    ),
    resolved: toResolved(p),
  }));

  // 1) Si hay cliente explicito, prioriza proyectos de ese cliente.
  if (hints.clientName) {
    const clientMatch = bestMatch(hints.clientName, candidates, 0.6);
    if (clientMatch.item) {
      const scoped = candidates.filter((c) => c.resolved.clientId === clientMatch.item!.resolved.clientId);
      const pool = scoped.length ? scoped : candidates;
      const byProject = bestMatch(hints.projectName || hints.clientName, pool, 0.55);
      if (byProject.item) {
        return { project: byProject.item.resolved, score: Math.max(byProject.score, clientMatch.score), ambiguous: [], available };
      }
    }
  }

  // 2) Match directo contra proyecto/cliente.
  const query = hints.projectName || hints.rawText || hints.clientName || '';
  const direct = bestMatch(query, candidates, 0.6);
  if (direct.item) {
    return { project: direct.item.resolved, score: direct.score, ambiguous: direct.ambiguous.map((a) => a.resolved), available };
  }

  // 3) Barrido de la frase completa buscando menciones a cliente o proyecto.
  if (hints.rawText) {
    const norm = normalize(hints.rawText);
    const mentioned = candidates
      .map((c) => {
        const tokens = [c.name, ...(c.aliases ?? [])].map(normalize).filter((t) => t.length >= 4);
        const hit = tokens.some((t) => norm.includes(t));
        return { c, hit };
      })
      .filter((x) => x.hit);
    if (mentioned.length === 1) return { project: mentioned[0]!.c.resolved, score: 0.8, ambiguous: [], available };
    if (mentioned.length > 1) return { project: mentioned[0]!.c.resolved, score: 0.7, ambiguous: mentioned.slice(1).map((m) => m.c.resolved), available };
  }

  return { project: null, score: direct.score, ambiguous: [], available };
}

export async function resolveTaskType(name?: string): Promise<{ id: string; name: string } | null> {
  const types = await prisma.taskType.findMany({ where: { isActive: true } });
  const defaults: Array<{ id: string; name: string }> = types.map((t) => ({ id: t.id, name: t.name }));
  if (!defaults.length) return null;
  if (!name) {
    // Heuristica: deduce el tipo desde el titulo (reunion, bug, soporte...)
    return null;
  }
  const candidates = types.map((t) => ({
    id: t.id,
    name: t.name,
    aliases: t.aliases.split(',').map((a) => a.trim()).filter(Boolean),
  }));
  const match = bestMatch(name, candidates, 0.65);
  return match.item ? { id: match.item.id, name: match.item.name } : null;
}

/** Deduce el tipo de tarea a partir del texto de la tarea (fallback inteligente). */
export async function inferTaskType(text: string): Promise<{ id: string; name: string } | null> {
  const types = await prisma.taskType.findMany({ where: { isActive: true } });
  if (!types.length || !text) return null;
  const norm = normalize(text);
  const rules: Array<{ keywords: string[]; type: string }> = [
    { keywords: ['reunion', 'meeting', 'daily', 'standup', 'call', 'llamada'], type: 'Reunion' },
    { keywords: ['bug', 'error', 'fix', 'hotfix', 'incidencia'], type: 'Bugfix' },
    { keywords: ['soporte', 'support', 'ticket', 'cliente molesto'], type: 'Soporte' },
    { keywords: ['document', 'doc', 'manual', 'acta'], type: 'Documentacion' },
    { keywords: ['test', 'qa', 'prueba', 'testing'], type: 'QA' },
    { keywords: ['deploy', 'despliegue', 'release', 'ci cd'], type: 'DevOps' },
    { keywords: ['maqueta', 'html', 'css', 'front', 'ui', 'ux'], type: 'Maquetacion' },
    { keywords: ['api', 'backend', 'endpoint', 'servicio'], type: 'Backend' },
    { keywords: ['planific', 'estimac', 'refinamiento', 'backlog'], type: 'Planificacion' },
  ];
  for (const rule of rules) {
    if (rule.keywords.some((k) => norm.includes(k))) {
      const found = types.find((t) => normalize(t.name).includes(normalize(rule.type)));
      if (found) return { id: found.id, name: found.name };
    }
  }
  const generic = types.find((t) => ['desarrollo', 'development', 'general'].includes(normalize(t.name)));
  return generic ? { id: generic.id, name: generic.name } : null;
}

/** Resuelve cliente por nombre (para el CRUD asistido desde el bot). */
export async function resolveClient(name: string) {
  const clients = await prisma.client.findMany({ where: { isActive: true } });
  const match = bestMatch(name, clients.map((c) => ({ id: c.id, name: c.name, aliases: c.code ? [c.code] : [] })), 0.6);
  return match.item ? clients.find((c) => c.id === match.item!.id) ?? null : null;
}
