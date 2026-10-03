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
  { command: 'nuevo', description: '➕ Crear cliente, proyecto o tipo de tarea' },
  { command: 'estado', description: '📊 Qué estás haciendo ahora y cuánto llevas' },
  { command: 'terminar', description: '⏹ Terminar la tarea y guardar el tiempo' },
  { command: 'pausar', description: '⏸ Pausar la tarea actual' },
  { command: 'retomar', description: '▶️ Retomar la tarea pausada' },
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

/**
 * Publica el menu de comandos en Telegram.
 * Si cambia el token del bot hay que volver a llamarlo (se hace desde el panel).
 */
export async function publishBotCommands(): Promise<{ ok: boolean; error?: string }> {
  try {
    await setMyCommands(BOT_COMMANDS.map((c) => ({ command: c.command, description: c.description })));
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

/**
 * Comandos que requieren permisos de gestion (crear catalogo).
 * El bot los acepta para cualquier usuario, pero informa cuando el rol no
 * alcanza; `entries:delete` y similares se validan en el backend.
 */
export const MANAGEMENT_COMMANDS = ['nuevo'];
