import { setMyCommands } from './telegram.api';

/**
 * Catalogo de comandos del bot.
 *
 * Telegram solo muestra el menu de comandos si se registran con `setMyCommands`.
 * Se registran al arrancar y tambien desde el panel (Configuracion → Telegram),
 * de modo que el menu aparece al escribir «/» en el chat.
 */

export interface BotCommand {
  command: string; // sin la barra
  description: string; // 3-256 caracteres
}

/** Comandos visibles en el menu de Telegram (orden = orden en el menu). */
export const BOT_COMMANDS: BotCommand[] = [
  { command: 'registrar', description: '▶️ Elegir cliente, proyecto y tarea, y grabar el tiempo' },
  { command: 'nuevo', description: '➕ Crear cliente, proyecto o tipo de tarea' },
  { command: 'estado', description: '📊 Qué estás haciendo ahora y cuánto llevas' },
  { command: 'terminar', description: '⏹ Terminar la tarea y guardar el tiempo' },
  { command: 'pausar', description: '⏸ Pausar la tarea actual' },
  { command: 'retomar', description: '▶️ Retomar la tarea pausada' },
  { command: 'tareas', description: '📋 Tus tareas (acumulado de tiempo por tarea)' },
  { command: 'tiempo', description: '⏱ Tiempo consumido en una tarea o proyecto' },
  { command: 'reporte', description: '📈 Reporte de horas (hoy, ayer, semana, mes)' },
  { command: 'menu', description: '📋 Menú con todos los comandos y botones' },
  { command: 'pendientes', description: '📝 Tus tareas pendientes' },
  { command: 'misproyectos', description: '📁 Proyectos disponibles' },
  { command: 'cancelar', description: '🚫 Descartar la tarea en curso (no cuenta horas)' },
  { command: 'vincular', description: '🔗 Vincular tu cuenta con un código' },
  { command: 'telefono', description: '📱 Vincular compartiendo tu número' },
  { command: 'ayuda', description: '❓ Ayuda y ejemplos' },
];

const asPayload = () => BOT_COMMANDS.map((c) => ({ command: c.command, description: c.description }));

/**
 * Publica el menu de comandos en Telegram (alcance por defecto).
 *
 * El menu de Telegram se cachea en el cliente: si el chat con el bot ya estaba
 * abierto antes de registrarlo, hay que reabrir el chat o reiniciar la app para
 * que aparezca el boton «/». Ademas, si existe un alcance especifico para un
 * chat, este TIENE PRIORIDAD sobre el alcance por defecto.
 */
export async function publishBotCommands(): Promise<{ ok: boolean; error?: string }> {
  try {
    await setMyCommands(asPayload());
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

/**
 * Publica el menu para un chat concreto (BotCommandScopeChat).
 * Se usa con cada usuario vinculado: así el menú aparece aunque el alcance por
 * defecto se hubiera quedado cacheado en ese chat.
 */
export async function publishBotCommandsForChat(chatId: string | number): Promise<{ ok: boolean; error?: string }> {
  try {
    await setMyCommands(asPayload(), { type: 'chat', chat_id: chatId });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

/** Comprueba que el bot tenga el menu registrado en el alcance por defecto. */
export async function commandsStatus(): Promise<{ defaultCount: number; error?: string }> {
  try {
    const { getMyCommands } = await import('./telegram.api');
    const list = await getMyCommands();
    return { defaultCount: list.length };
  } catch (err) {
    return { defaultCount: 0, error: (err as Error).message };
  }
}

/**
 * Comandos que requieren permisos de gestion (crear catalogo).
 * El bot los acepta para cualquier usuario, pero informa cuando el rol no
 * alcanza; `entries:delete` y similares se validan en el backend.
 */
export const MANAGEMENT_COMMANDS = ['nuevo'];
