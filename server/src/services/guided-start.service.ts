import { prisma } from '../db/prisma';
import { clearFlow, findOrCreateClient, findOrCreateProject, getFlow, setFlow, updateFlow } from './guided-flow.service';
import { listVisibleProjects, resolveProject, type ResolvedProject } from './resolve.service';
import { leaveKeyboard, type ReplyMarkup } from '../bot/telegram.api';
import { startTimer } from './timer.service';
import { projectActionsKeyboard, startConfirmation } from '../bot/messages';
import { escapeHtml } from '../utils/format';

/**
 * ALTA GUIADA DESDE EL BOT
 *
 * Cuando el trabajador empieza una tarea y el proyecto no existe, el bot le
 * acompana para crearlo sin salir del chat:
 *
 *   1. Muestra los proyectos que ya tiene + boton «➕ Crear proyecto nuevo».
 *   2. Pide el nombre del cliente -> lo busca y lo crea si no existe.
 *   3. Pide el nombre del proyecto -> lo crea dentro de ese cliente.
 *   4. Arranca el cronometro con el texto, el tipo de tarea y el titulo originales.
 *
 * Todo lo que el usuario ya dijo (proyecto, cliente, tipo de tarea, titulo) se
 * conserva para no volver a preguntarlo.
 */

export interface GuidedReply {
  text: string;
  markup?: ReplyMarkup;
  /** Si ya arranco el cronometro, la confirmacion final. */
  started?: boolean;
}

interface StartContext {
  userId: string;
  roleKey: string;
  timezone: string;
  rawText: string;
  entities: {
    projectName?: string;
    clientName?: string;
    taskTypeName?: string;
    title?: string;
    description?: string;
    tag?: string;
  };
  source: string;
}

/** Proyecto elegido por boton: inicia la tarea con el texto original. */
async function startWithProject(context: StartContext, project: ResolvedProject): Promise<GuidedReply> {
  const flow = getFlow(context.userId);
  const text = flow?.originalText || context.rawText;
  const entities = { ...context.entities };
  if (flow?.taskTypeName && !entities.taskTypeName) entities.taskTypeName = flow.taskTypeName;
  if (flow?.title && !entities.title) entities.title = flow.title;

  const result = await startTimer({
    userId: context.userId,
    roleKey: context.roleKey,
    rawText: text,
    project,
    title: entities.title ?? text,
    description: entities.description,
    taskTypeName: entities.taskTypeName,
    tag: entities.tag,
    source: context.source,
  });
  clearFlow(context.userId);

  return {
    text: startConfirmation(result.entry!, result.previous ?? null, context.timezone),
    markup: leaveKeyboard(),
    started: true,
  };
}

/** Paso 1: no se encontro el proyecto -> ofrecer uno existente o crear. */
export async function askProjectOrCreate(context: StartContext, available?: ResolvedProject[]): Promise<GuidedReply> {
  const projects = available?.length ? available : (await listVisibleProjects(context.userId, context.roleKey)).map((p) => ({
    id: p.id,
    name: p.name,
    clientId: p.client.id,
    clientName: p.client.name,
    githubRepos: p.githubRepos,
  }));

  setFlow(context.userId, {
    step: projects.length ? 'CONFIRM_PROJECT' : 'ASK_CLIENT_NAME',
    originalText: context.rawText,
    projectName: context.entities.projectName,
    clientName: context.entities.clientName,
    taskTypeName: context.entities.taskTypeName,
    title: context.entities.title,
  });

  if (!projects.length) {
    return {
      text: [
        '📁 <b>Todavía no hay proyectos ni clientes.</b>',
        '',
        'Vamos a crearlos ahora mismo (tarda 10 segundos).',
        '',
        '¿<b>Cómo se llama el cliente</b>? Escríbelo aquí abajo.',
        '<i>Ejemplo: Acme Corp</i>',
      ].join('\n'),
      markup: leaveKeyboard(),
    };
  }

  const propuesta = context.entities.projectName
    ? `<i>No encontré «${escapeHtml(context.entities.projectName)}».</i>\n\n`
    : '';
  return {
    text: [
      `${propuesta}¿<b>En qué proyecto vas a trabajar</b>?`,
      '',
      'Elige uno de la lista o crea uno nuevo:',
    ].join('\n'),
    markup: projectActionsKeyboard(projects),
  };
}

/** Paso 2: nombre del cliente recibido. */
export async function handleClientName(context: StartContext, clientName: string): Promise<GuidedReply> {
  let client;
  try {
    client = await findOrCreateClient(clientName);
  } catch (err) {
    return { text: `⚠️ ${escapeHtml((err as Error).message)}. Escribe otro nombre, por favor.` };
  }

  updateFlow(context.userId, { step: 'ASK_PROJECT_NAME', clientId: client.id, clientLabel: client.name });

  const proyectos = await prisma.clientProject.findMany({
    where: { clientId: client.id, isActive: true },
    select: { id: true, name: true },
    orderBy: { name: 'asc' },
  });

  const avisoExistente = client.created
    ? `✅ Cliente <b>${escapeHtml(client.name)}</b> creado.`
    : `✅ Cliente <b>${escapeHtml(client.name)}</b> (ya existía).`;

  const lista = proyectos.length
    ? `\n\nProyectos que ya tiene:\n${proyectos.map((p) => `• ${escapeHtml(p.name)}`).join('\n')}`
    : '';

  return {
    text: [
      avisoExistente,
      lista,
      '',
      '¿<b>Cómo se llama el proyecto</b>? Escríbelo aquí abajo.',
      '<i>Ejemplo: Portal Web</i>',
    ].join('\n'),
    markup: leaveKeyboard(),
  };
}

/** Paso 3: nombre del proyecto recibido -> se crea y arranca la tarea. */
export async function handleProjectName(context: StartContext, projectName: string): Promise<GuidedReply> {
  const flow = getFlow(context.userId);
  if (!flow?.clientId) {
    clearFlow(context.userId);
    return {
      text: '⚠️ Se perdió el hilo de la conversación. Vuelve a escribir la tarea y la organizamos.',
      markup: leaveKeyboard(),
    };
  }

  let project;
  try {
    project = await findOrCreateProject(flow.clientId, projectName, context.userId);
  } catch (err) {
    return { text: `⚠️ ${escapeHtml((err as Error).message)}. Escribe otro nombre, por favor.` };
  }

  const aviso = project.created
    ? `✅ Proyecto <b>${escapeHtml(project.name)}</b> creado en <b>${escapeHtml(project.clientName)}</b>.`
    : `✅ Usando el proyecto <b>${escapeHtml(project.name)}</b> de <b>${escapeHtml(project.clientName)}</b>.`;

  const started = await startWithProject(context, {
    id: project.id,
    name: project.name,
    clientId: project.clientId,
    clientName: project.clientName,
    githubRepos: project.githubRepos,
  });

  return { text: `${aviso}\n\n${started.text}`, markup: started.markup, started: started.started };
}

/**
 * Punto de entrada: intenta resolver el proyecto y, si no lo encuentra,
 * arranca el alta guiada.
 */
export async function beginGuidedStart(context: StartContext): Promise<GuidedReply> {
  const resolution = await resolveProject(context.userId, context.roleKey, {
    projectName: context.entities.projectName,
    clientName: context.entities.clientName,
    rawText: context.rawText,
  });

  if (resolution.project) {
    return startWithProject(context, resolution.project);
  }
  return askProjectOrCreate(context, resolution.available);
}

/** Proyecto elegido con un boton de la lista. */
export async function chooseProject(context: StartContext, projectId: string): Promise<GuidedReply> {
  const project = await prisma.clientProject.findUnique({
    where: { id: projectId },
    include: { client: true },
  });
  if (!project) {
    clearFlow(context.userId);
    return { text: '⚠️ Ese proyecto ya no existe. Vuelve a escribir la tarea.', markup: leaveKeyboard() };
  }
  return startWithProject(context, {
    id: project.id,
    name: project.name,
    clientId: project.client.id,
    clientName: project.client.name,
    githubRepos: project.githubRepos,
  });
}
