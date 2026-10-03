import { prisma } from '../db/prisma';
import { clearFlow, findOrCreateClient, findOrCreateProject, getFlow, setFlow, startFlow, updateFlow } from './guided-flow.service';
import { listVisibleProjects, normalize, resolveProject, type ResolvedProject } from './resolve.service';
import { leaveKeyboard, type ReplyMarkup } from '../bot/telegram.api';
import { startTimer } from './timer.service';
import { findOrCreateTask } from './task.service';
import { projectActionsKeyboard, startConfirmation } from '../bot/messages';
import { escapeHtml, humanDuration } from '../utils/format';

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

/** Contexto de un flujo que NO arranca tarea (solo crea catalogo). */
export interface CatalogContext {
  userId: string;
  roleKey: string;
  timezone: string;
  source: string;
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

  const flow = getFlow(context.userId);
  const esCatalogo = flow?.mode === 'CATALOG_CLIENT' || flow?.mode === 'CATALOG_PROJECT';
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
      esCatalogo
        ? '¿<b>Cómo se llama el proyecto</b> que quieres crear? Escríbelo aquí abajo.'
        : '¿<b>Cómo se llama el proyecto</b>? Escríbelo aquí abajo.',
      '<i>Ejemplo: Portal Web</i>',
      esCatalogo ? '\nEscribe <code>cancelar</code> para salir.' : '',
    ]
      .filter(Boolean)
      .join('\n'),
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

  // Modo catalogo: se crea y se termina (no se arranca cronometro).
  if (flow.mode === 'CATALOG_CLIENT' || flow.mode === 'CATALOG_PROJECT') {
    clearFlow(context.userId);
    return {
      text: [aviso, '', 'Ya está en el catálogo y disponible para todos. Los administradores pueden completar presupuesto, tarifas y repos de GitHub desde el panel web.'].join('\n'),
      markup: { remove_keyboard: true },
    };
  }

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


// ---------------------------------------------------------------------------
// Flujos de catalogo (sin arrancar tarea)
// ---------------------------------------------------------------------------

/** Paso 1 de «crear cliente»: pide el nombre. */
export function askNewClientName(context: CatalogContext, mode: 'CATALOG_CLIENT' | 'CATALOG_PROJECT' = 'CATALOG_CLIENT'): GuidedReply {
  setFlow(context.userId, { step: 'ASK_CLIENT_NAME', mode, originalText: '', startAfterCreate: false });
  return {
    text: [
      mode === 'CATALOG_PROJECT' ? '📁 <b>Nuevo proyecto</b>' : '🏢 <b>Nuevo cliente</b>',
      '',
      '¿<b>Cómo se llama el cliente</b>? Escríbelo aquí abajo.',
      '<i>Ejemplo: Acme Corp</i>',
      '',
      'Escribe <code>cancelar</code> para salir.',
    ].join('\n'),
    markup: leaveKeyboard(),
  };
}

/** Paso 1 de «crear tipo de tarea»: pide el nombre. */
export function askNewTaskTypeName(context: CatalogContext): GuidedReply {
  setFlow(context.userId, { step: 'ASK_TASKTYPE_NAME', mode: 'CATALOG_TASKTYPE', originalText: '', startAfterCreate: false });
  return {
    text: [
      '🏷 <b>Nuevo tipo de tarea</b>',
      '',
      'El bot lo usará para clasificar lo que dices por voz.',
      '¿<b>Cómo se llama</b>? <i>Ejemplo: Investigación</i>',
      '',
      'Escribe <code>cancelar</code> para salir.',
    ].join('\n'),
    markup: leaveKeyboard(),
  };
}

/** Crea el tipo de tarea y ofrece crear otro. */
export async function handleTaskTypeName(context: CatalogContext, name: string): Promise<GuidedReply> {
  const limpio = name.trim().replace(/\s+/g, ' ');
  if (limpio.length < 2) {
    return { text: '⚠️ El nombre es demasiado corto. Escribe otro, por favor.' };
  }

  const tipos = await prisma.taskType.findMany({ select: { id: true, name: true } });
  const existente = tipos.find((t) => normalize(t.name) === normalize(limpio));
  if (existente) {
    clearFlow(context.userId);
    return {
      text: `✅ El tipo <b>${escapeHtml(existente.name)}</b> ya existe.`,
      markup: { remove_keyboard: true },
    };
  }

  const creado = await prisma.taskType.create({
    data: { name: limpio, aliases: normalize(limpio), billable: true },
  });
  clearFlow(context.userId);

  return {
    text: [
      `✅ Tipo de tarea <b>${escapeHtml(creado.name)}</b> creado.`,
      '',
      'Ya puedes usarlo: al dictar una tarea, el bot lo reconocerá.',
    ].join('\n'),
    markup: { remove_keyboard: true },
  };
}


// ---------------------------------------------------------------------------
// Flujo con BOTONES: elegir cliente -> proyecto -> tarea y luego grabar
//
// Sirve para cuando el dictado libre no acierta con el nombre, o para ver qué
// hay disponible. Al terminar la selección se pide la nota de voz y se registra
// el tiempo directamente sobre la tarea elegida.
// ---------------------------------------------------------------------------

const SELECT_LABEL = (t: string, sub?: string | null) => (sub ? `${t} · ${sub}` : t).slice(0, 60);

/** Paso 1: elegir cliente (con opción de crear uno nuevo). */
export async function askClientSelection(context: CatalogContext): Promise<GuidedReply> {
  setFlow(context.userId, {
    step: 'SELECT_CLIENT',
    mode: 'SELECT_AND_RECORD',
    originalText: '',
    startAfterCreate: true,
  });

  const clientes = await prisma.client.findMany({
    where: { isActive: true },
    orderBy: { name: 'asc' },
    take: 10,
    include: { _count: { select: { projects: true } } },
  });

  if (!clientes.length) {
    clearFlow(context.userId);
    return {
      text: [
        '📁 <b>No hay clientes todavía.</b>',
        '',
        'Crea el primero con <code>/nuevo cliente</code>, o simplemente dicta la tarea:',
        '<i>«iniciando maquetación del login para el cliente Acme»</i>',
      ].join('\n'),
    };
  }

  const filas = clientes.map((c) => [
    { text: SELECT_LABEL(c.name, `${c._count.projects} proyecto(s)`), callback_data: `selclient:${c.id}` },
  ]);
  filas.push([{ text: '➕ Cliente nuevo', callback_data: 'newclient:' }]);

  return {
    text: [
      '▶️ <b>Registrar tiempo paso a paso</b>',
      '',
      '<b>1/3 · ¿Para qué cliente?</b>',
      'Elige uno de la lista:',
    ].join('\n'),
    markup: { inline_keyboard: filas },
  };
}

/** Paso 2: elegir proyecto del cliente elegido. */
export async function askProjectSelection(
  context: CatalogContext,
  clientId: string,
  clientLabel: string,
): Promise<GuidedReply> {
  startFlow(context.userId, {
    step: 'SELECT_PROJECT',
    mode: 'SELECT_AND_RECORD',
    clientId,
    clientLabel,
    startAfterCreate: true,
  });

  const proyectos = await prisma.clientProject.findMany({
    where: { clientId, isActive: true },
    orderBy: { name: 'asc' },
    take: 10,
    include: { _count: { select: { tasks: true } } },
  });

  const cabecera = ['▶️ <b>Registrar tiempo paso a paso</b>', '', `🏢 Cliente: <b>${escapeHtml(clientLabel)}</b>`, ''];

  if (!proyectos.length) {
    return {
      text: [
        ...cabecera,
        'Este cliente no tiene proyectos todavía.',
        '',
        'Escribe el nombre del proyecto aquí abajo y lo creo (o usa <code>/nuevo proyecto</code>).',
      ].join('\n'),
      markup: leaveKeyboard(),
    };
  }

  const filas = proyectos.map((p) => [
    { text: SELECT_LABEL(p.name, `${p._count.tasks} tarea(s)`), callback_data: `selproject:${p.id}` },
  ]);
  filas.push([{ text: '➕ Proyecto nuevo', callback_data: 'newproj:' }]);

  return {
    text: [...cabecera, '<b>2/3 · ¿En qué proyecto?</b>'].join('\n'),
    markup: { inline_keyboard: filas },
  };
}

/** Paso 3: elegir tarea del proyecto (existentes o crear una nueva). */
export async function askTaskSelection(
  context: CatalogContext,
  projectId: string,
  projectLabel: string,
): Promise<GuidedReply> {
  const tareas = await prisma.task.findMany({
    where: { projectId, status: { in: ['OPEN', 'IN_PROGRESS'] } },
    orderBy: [{ lastWorkedAt: 'desc' }, { createdAt: 'desc' }],
    take: 12,
  });

  startFlow(context.userId, {
    step: 'SELECT_TASK',
    mode: 'SELECT_AND_RECORD',
    selectedProjectId: projectId,
    selectedProjectLabel: projectLabel,
    startAfterCreate: true,
  });

  const cabecera = [
    '▶️ <b>Registrar tiempo paso a paso</b>',
    '',
    `📁 Proyecto: <b>${escapeHtml(projectLabel)}</b>`,
    '',
  ];

  const filas = tareas.map((t) => [
    {
      text: SELECT_LABEL(t.title, t.totalSeconds ? humanDuration(t.totalSeconds) : null),
      callback_data: `seltask:${t.id}`,
    },
  ]);
  filas.push([{ text: '➕ Tarea nueva', callback_data: 'newtask:' }]);

  return {
    text: [
      ...cabecera,
      '<b>3/3 · ¿Qué tarea?</b>',
      tareas.length
        ? 'Elige una de tus tareas abiertas o crea una nueva:'
        : 'No hay tareas abiertas en este proyecto. Crea una nueva:',
    ].join('\n'),
    markup: { inline_keyboard: filas },
  };
}

/** Tarea elegida: se pide la nota de voz (o un texto) para arrancar. */
export function askForAudioOrText(
  context: CatalogContext,
  task: { id: string; title: string; totalSeconds: number; entryCount: number },
  projectLabel: string,
  clientLabel?: string,
): GuidedReply {
  startFlow(context.userId, {
    step: 'AWAIT_AUDIO',
    mode: 'SELECT_AND_RECORD',
    selectedTaskId: task.id,
    selectedTaskLabel: task.title,
    selectedProjectLabel: projectLabel,
    clientLabel,
    startAfterCreate: true,
  });

  const acumulado = task.entryCount
    ? `\n⏱ Ya lleva <b>${humanDuration(task.totalSeconds)}</b> en ${task.entryCount} tramo(s).`
    : '\n⏱ Todavía sin tiempo registrado.';

  return {
    text: [
      '✅ <b>Contexto listo</b>',
      '',
      `🏢 ${escapeHtml(clientLabel ?? '')}`,
      `📁 ${escapeHtml(projectLabel)}`,
      `🗂 <b>${escapeHtml(task.title)}</b>${acumulado}`,
      '',
      '🎙 <b>Envía ahora la nota de voz</b> con lo que vas a hacer (o escríbelo en texto).',
      'También puedes enviar el audio sin decir nada más: el registro se hará sobre esta tarea.',
      '',
      'Escribe <code>cancelar</code> para salir.',
    ].join('\n'),
    markup: leaveKeyboard(),
  };
}

/** El usuario pidió crear la tarea a mano en el paso 3. */
export function askNewTaskTitle(context: CatalogContext, projectLabel: string): GuidedReply {
  startFlow(context.userId, {
    step: 'ASK_PROJECT_NAME',
    mode: 'SELECT_AND_RECORD',
    selectedProjectLabel: projectLabel,
    startAfterCreate: true,
  });
  return {
    text: [
      `📁 Proyecto: <b>${escapeHtml(projectLabel)}</b>`,
      '',
      '✍️ Escribe el <b>nombre de la nueva tarea</b>:',
      '<i>Ejemplo: Maquetación del carrito</i>',
    ].join('\n'),
    markup: leaveKeyboard(),
  };
}

/**
 * Arranca (o reutiliza) la tarea elegida y abre su primer tramo.
 * Es el punto que usa el bot cuando ya hay contexto seleccionado y llega el audio.
 */
export async function startSelectedTask(
  context: { userId: string; roleKey: string; timezone: string; source: string },
  params: { taskId?: string | null; title?: string; projectId?: string | null; description?: string },
): Promise<GuidedReply> {
  const flow = getFlow(context.userId);

  // Tarea ya elegida con botones: se abre un tramo suyo.
  if (params.taskId) {
    const tarea = await prisma.task.findUnique({
      where: { id: params.taskId },
      include: { project: { include: { client: true } }, client: true, taskType: true },
    });
    if (!tarea) {
      clearFlow(context.userId);
      return { text: '⚠️ Esa tarea ya no existe. Vuelve a empezar con /registrar.' };
    }

    const result = await startTimer({
      userId: context.userId,
      roleKey: context.roleKey,
      rawText: params.description || tarea.title,
      taskId: tarea.id,
      title: tarea.title,
      description: params.description,
      source: context.source,
    });
    clearFlow(context.userId);
    return {
      text: startConfirmation(result.entry!, result.previous ?? null, context.timezone),
      markup: leaveKeyboard(),
      started: true,
    };
  }

  // Tarea nueva creada a mano: se crea y se abre su primer tramo.
  const projectId = (params.projectId ?? flow?.selectedProjectId ?? null) as string | null;
  const titulo = (params.title ?? '').trim();
  if (!titulo) {
    return { text: '⚠️ Necesito un nombre para la tarea.' };
  }

  const creada = await findOrCreateTask({
    userId: context.userId,
    title: titulo,
    projectId: projectId ?? undefined,
    description: params.description ?? null,
  });
  if (!creada) return { text: '⚠️ No pude crear la tarea con ese nombre.' };

  const result = await startTimer({
    userId: context.userId,
    roleKey: context.roleKey,
    rawText: params.description || titulo,
    taskId: creada.id,
    title: creada.title,
    description: params.description,
    source: context.source,
  });
  clearFlow(context.userId);
  return {
    text: startConfirmation(result.entry!, result.previous ?? null, context.timezone),
    markup: leaveKeyboard(),
    started: true,
  };
}
