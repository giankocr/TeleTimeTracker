import OpenAI from 'openai';
import { openaiKey } from '../config/env';
import { getSetting, getSettingBool, getSettingInt, SETTING_KEYS } from './settings.service';
import type { BotIntent, ParsedCommand, ParsedEntities } from '../../../shared/types';

/**
 * NLU del bot: convierte la transcripcion de la nota de voz (o el texto libre)
 * del trabajador en una intencion estructurada (intent + entidades).
 * La transcripcion de audio vive en services/audio.service.ts.
 *
 * Motor 1: OpenAI GPT para extraer intencion y entidades.
 * Motor 2 (fallback): heuristicas por expresiones regulares y palabras clave,
 * de modo que el bot siga funcionando si no hay API key configurada.
 */

const client = (): OpenAI | null => {
  const key = openaiKey();
  return key ? new OpenAI({ apiKey: key }) : null;
};

export const hasOpenAI = (): boolean => Boolean(openaiKey());

// ---------------------------------------------------------------------------
// 2) Extraccion de intencion y entidades
// ---------------------------------------------------------------------------
const SYSTEM_PROMPT = `Eres el motor NLU de un sistema de control de tiempo (time tracking) para agencias de software.
Recibes una frase escrita o transcrita de una nota de voz en espanol y debes devolver SOLO un JSON valido.

Intenciones permitidas:
- "START": el usuario comienza o retoma una tarea nueva. Ej: "iniciando tarea de maquetacion en proyecto X del cliente Y".
- "STOP": el usuario termina la tarea actual e informa lo que hizo. Ej: "termine la tarea, ajuste el login y subi cambios".
- "PAUSE": el usuario pausa sin cambiar de tarea. Ej: "pausa para reunion de equipo", "voy a almorzar".
- "RESUME": el usuario reanuda la tarea que tenia pausada. Ej: "retomo la tarea", "volvi".
- "SWITCH": el usuario cambia a otra tarea/proyecto explicitamente. Ej: "cambia a la tarea Z", "ahora paso al proyecto del cliente W".
- "STATUS": pide saber en que esta trabajando o cuanto lleva. Ej: "en que voy", "cuanto llevo".
- "REPORT": pide un reporte de horas de un periodo. Ej: "reporte de hoy", "cuantas horas hice ayer".
- "AGENDA": pide sus pendientes o la lista de tareas. Ej: "que tengo pendiente", "agenda de hoy".
- "LINK": el usuario envia un codigo de vinculacion (formato ABCD-1234) o pide vincular su cuenta.
- "HELP": pide ayuda o saluda y no hay otra intencion clara.
- "UNKNOWN": no se entiende.

Entidades a extraer (solo si aparecen):
- clientName: nombre del cliente
- projectName: nombre del proyecto
- taskTypeName: tipo de actividad (maquetacion, reunion, soporte, bugfix, backend, QA, documentacion, planificacion, devops)
- title: resumen corto (max 80 caracteres) de la tarea
- description: detalle de lo realizado (para STOP suele ser la lista de cambios)
- tag: etiqueta corta si el usuario la menciona
- date: fecha objetivo del reporte en formato YYYY-MM-DD si la menciona (hoy, ayer, el lunes, esta semana)

Reglas:
- Nunca inventes nombres de proyecto o cliente que el usuario no haya dicho.
- Si dice "cambia a X" o "paso a X" el intent es SWITCH aunque no diga la palabra tarea.
- Si dice "termine", "finalice", "acabe", "listo" el intent es STOP.
- Devuelve "confidence" entre 0 y 1.
- Responde exclusivamente con el JSON, sin markdown ni explicaciones.

Formato exacto:
{"intent":"START","confidence":0.93,"entities":{"clientName":"","projectName":"","taskTypeName":"","title":"","description":"","tag":"","date":""}}`;

/** Higiene del JSON devuelto por el modelo. */
function safeJsonParse(content: string): any | null {
  const cleaned = content
    .trim()
    .replace(/^```(?:json)?/i, '')
    .replace(/```$/, '')
    .trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      return JSON.parse(match[0]);
    } catch {
      return null;
    }
  }
}

const clean = (v: unknown): string | undefined => {
  if (typeof v !== 'string') return undefined;
  const t = v.trim();
  if (!t || ['null', 'none', 'n/a', 'no especificado', 'desconocido'].includes(t.toLowerCase())) return undefined;
  return t;
};

export async function parseWithLLM(text: string, context?: { activeTask?: string | null; projects?: string[]; clients?: string[] }): Promise<ParsedCommand | null> {
  if (!getSettingBool(SETTING_KEYS.NLU_ENABLED, true)) return null;
  const openai = client();
  if (!openai) return null;

  const contextBlock = context
    ? `\n\nContexto (usa estos nombres exactos cuando coincidan):\n- Tarea activa actual: ${context.activeTask ?? 'ninguna'}\n- Proyectos disponibles: ${(context.projects ?? []).join(', ') || 'sin datos'}\n- Clientes disponibles: ${(context.clients ?? []).join(', ') || 'sin datos'}`
    : '';

  try {
    const res = await openai.chat.completions.create({
      model: getSetting(SETTING_KEYS.NLU_MODEL, 'gpt-4o-mini'),
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SYSTEM_PROMPT + contextBlock },
        { role: 'user', content: text },
      ],
    });
    const content = res.choices[0]?.message?.content ?? '';
    const json = safeJsonParse(content);
    if (!json) return null;

    const intent = String(json.intent ?? 'UNKNOWN').toUpperCase() as BotIntent;
    const allowed: BotIntent[] = ['START', 'STOP', 'PAUSE', 'RESUME', 'SWITCH', 'STATUS', 'REPORT', 'AGENDA', 'LINK', 'HELP', 'UNKNOWN'];
    const entities: ParsedEntities = {
      clientName: clean(json.entities?.clientName),
      projectName: clean(json.entities?.projectName),
      taskTypeName: clean(json.entities?.taskTypeName),
      title: clean(json.entities?.title),
      description: clean(json.entities?.description),
      tag: clean(json.entities?.tag),
      date: clean(json.entities?.date),
    };
    return {
      intent: allowed.includes(intent) ? intent : 'UNKNOWN',
      confidence: Number(json.confidence) || 0.7,
      entities,
      engine: 'openai',
      rawText: text,
    };
  } catch (err) {
    console.warn('[nlu] fallo OpenAI, se usara heuristica:', (err as Error).message);
    return null;
  }
}

// ---------------------------------------------------------------------------
// 3) Motor heuristico (fallback sin IA)
// ---------------------------------------------------------------------------
const norm = (s: string): string =>
  s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();

const PATTERNS: Array<{ intent: BotIntent; re: RegExp; weight: number }> = [
  { intent: 'STOP', re: /\b(termine|termine|finalice|finalizo|acabe|acabo|listo|listo|cerrar tarea|pare|detener|stop|ya termine|complete)\b/, weight: 1 },
  { intent: 'PAUSE', re: /\b(pausa|pausar|pauso|break|descanso|almuerzo|almorzar|voy a comer|receso|suspend)/, weight: 1 },
  { intent: 'RESUME', re: /\b(retomo|retomar|reanudo|reanudar|vuelvo|volvi|continuo|continuar|sigo|resume)\b/, weight: 1 },
  { intent: 'SWITCH', re: /\b(cambia|cambiar|ahora paso|paso a|me paso a|switch|voy con|empiezo con otro)\b/, weight: 1 },
  { intent: 'START', re: /\b(iniciando|inicio|iniciar|empiezo|empezar|comienzo|comenzar|arranco|arrancar|nueva tarea|trabajando en|start)\b/, weight: 1 },
  { intent: 'STATUS', re: /\b(en que voy|que estoy haciendo|estado|cuanto llevo|mi tarea actual|status)\b/, weight: 1 },
  { intent: 'REPORT', re: /\b(reporte|resumen|cuantas horas|horas de|informe|report)\b/, weight: 1 },
  { intent: 'AGENDA', re: /\b(pendiente|pendientes|agenda|tareas de hoy|que tengo|backlog|to do)\b/, weight: 1 },
  { intent: 'HELP', re: /^(hola|buenas|buenos dias|buenas tardes|hey|ayuda|help|menu|\/start)\b/, weight: 0.8 },
];

const TASK_TYPE_KEYWORDS: Array<{ type: string; re: RegExp }> = [
  { type: 'Reunion', re: /\b(reunion|meeting|daily|standup|call|llamada|sync)\b/ },
  { type: 'Bugfix', re: /\b(bug|fix|hotfix|error|incidencia|correccion)\b/ },
  { type: 'Soporte', re: /\b(soporte|ticket|support|incidente)\b/ },
  { type: 'Documentacion', re: /\b(documentacion|documentar|manual|acta|readme)\b/ },
  { type: 'QA', re: /\b(qa|pruebas|testing|test)\b/ },
  { type: 'DevOps', re: /\b(deploy|despliegue|release|pipeline|docker|infra)\b/ },
  { type: 'Maquetacion', re: /\b(maquetacion|maquetar|html|css|layout|landing|front)\b/ },
  { type: 'Backend', re: /\b(backend|api|endpoint|servicio|base de datos|query)\b/ },
  { type: 'Planificacion', re: /\b(planificacion|estimar|estimacion|refinamiento|backlog grooming)\b/ },
];

/** Extrae "del cliente X" / "en el proyecto Y" del texto. */
function extractNamedPhrases(text: string): { clientName?: string; projectName?: string } {
  const t = norm(text);
  const clientMatch =
    t.match(/(?:del cliente|para el cliente|cliente|de la cuenta|cuenta)\s+([a-z0-9\s.&-]{2,40}?)(?:\s+(?:en|del|con|para)\b|[,.;]|$)/) ??
    t.match(/(?:cliente)\s+([a-z0-9\s.&-]{2,40})/);
  const projectMatch =
    t.match(/(?:proyecto|project|en el proyecto|en proyecto|app|plataforma)\s+([a-z0-9\s.&-]{2,40}?)(?:\s+(?:del|de|para|con)\b|[,.;]|$)/) ??
    t.match(/(?:proyecto)\s+([a-z0-9\s.&-]{2,40})/);
  const trim = (v?: string) => {
    if (!v) return undefined;
    const cleaned = v.replace(/\b(cliente|proyecto|project|del|de|la|el|los|las|para|con|en)\b/g, ' ').replace(/\s+/g, ' ').trim();
    return cleaned.length >= 2 ? cleaned : undefined;
  };
  return { clientName: trim(clientMatch?.[1]), projectName: trim(projectMatch?.[1]) };
}

/**
 * Limpia la frase original para usarla como titulo del registro:
 *  - quita el prefijo de intencion ("iniciando tarea de", "cambia a la tarea de")
 *  - quita la coletilla de proyecto/cliente ("en el proyecto X del cliente Y")
 * Asi el historial queda legible: "maquetacion del login" en vez de la frase completa.
 */
export function cleanTitle(text: string): string {
  // 1) Se corta la coletilla de ubicacion SOLO si menciona proyecto/cliente,
  //    sin consumir palabras que empiezan igual ("...del login" no se toca).
  let t = ` ${text} `
    .replace(/\s+(en|del|de|para|con)\s+(el\s+|la\s+)?(proyecto|project|cliente|cuenta)\b[\s\S]*$/gi, ' ');

  // 2) Se quita el prefijo de intencion ("iniciando tarea de", "trabajando en la...")
  //    junto con el conector que lo sigue ("de", "en la", "con la"...).
  const VERBOS =
    'iniciando|inicio|iniciar|empiezo|empezar|comienzo|comenzar|arranco|arrancar|trabajando|trabajo|nueva|start|switch|cambia|cambiar|ahora|paso|me|voy|terminada|termine|finalice|acabe|listo|complete|haciendo|hago|hacer|realizando|realizo|preparando|revisando|reviso';
  const CONECTORES = 'de|del|en|con|para|por|sobre|a|al|la|el|los|las|una|un|mi|su';

  let previo = '';
  while (previo !== t) {
    previo = t;
    t = t.replace(
      new RegExp(`^[\\s.,;:-]*\\b(${VERBOS})\\b[\\s.,;:-]*((\\b(${CONECTORES})\\b[\\s.,;:-]*)*)`, 'i'),
      ' ',
    );
    // "tarea (de|del) ..." tras haber quitado el verbo.
    t = t.replace(new RegExp(`^[\\s.,;:-]*\\btarea\\b[\\s.,;:-]*(\\b(${CONECTORES})\\b[\\s.,;:-]*)*`, 'i'), ' ');
  }

  // 3) Articulos iniciales y puntuacion suelta.
  t = t.replace(/^[\s.,;:-]*\b(la|el|los|las|una|un|de|del|a|al)\b\s*/i, ' ');
  t = t.replace(/[.,;]\s*$/, '');

  const cleaned = t.replace(/^[\s\-–:]+/, '').replace(/\s{2,}/g, ' ').trim();
  return (cleaned.length >= 3 ? cleaned : text.trim()).slice(0, 180);
}

export function parseHeuristic(text: string): ParsedCommand {
  const t = norm(text);
  const entities: ParsedEntities = {};

  let intent: BotIntent = 'UNKNOWN';
  let bestWeight = 0;
  for (const p of PATTERNS) {
    if (p.re.test(t) && p.weight > bestWeight) {
      intent = p.intent;
      bestWeight = p.weight;
    }
  }
  if (intent === 'UNKNOWN') intent = 'HELP';

  // Vinculacion: codigo tipo ABCD-1234
  const linkCode = text.match(/\b([A-Z0-9]{4}-[A-Z0-9]{4})\b/);
  if (linkCode) {
    intent = 'LINK';
    entities.tag = linkCode[1];
  }

  const named = extractNamedPhrases(text);
  entities.clientName = named.clientName;
  entities.projectName = named.projectName;

  const type = TASK_TYPE_KEYWORDS.find((k) => k.re.test(t));
  if (type) entities.taskTypeName = type.type;

  if (intent === 'STOP') {
    const detail = text.replace(/^.*?\b(termine|finalice|acabe|listo|complete)\b[^.]*[.,:]?\s*/i, '').trim();
    entities.description = detail.length > 3 ? detail : text;
  } else {
    entities.title = cleanTitle(text);
  }

  return { intent, confidence: 0.55, entities, engine: 'heuristic', rawText: text };
}

/** Punto de entrada: intenta IA y cae a heuristica. */
export async function parseCommand(
  text: string,
  context?: { activeTask?: string | null; projects?: string[]; clients?: string[] },
): Promise<ParsedCommand> {
  const trimmed = (text ?? '').trim();
  if (!trimmed) return { intent: 'UNKNOWN', confidence: 0, entities: {}, engine: 'heuristic', rawText: '' };

  const viaLLM = await parseWithLLM(trimmed, context);
  if (viaLLM && viaLLM.intent !== 'UNKNOWN') return viaLLM;

  // Fallback heuristico (tambien cubre el caso "sin API key").
  return parseHeuristic(trimmed);
}

/** Resumen corto de la tarea activa para dar contexto al modelo. */
export const settingsEcho = () => ({
  whisper: getSetting(SETTING_KEYS.WHISPER_MODEL, 'whisper-1'),
  nlu: getSetting(SETTING_KEYS.NLU_MODEL, 'gpt-4o-mini'),
  idleMinutes: getSettingInt(SETTING_KEYS.IDLE_ALERT_MIN, 45),
});
