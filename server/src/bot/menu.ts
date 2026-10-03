import type { ReplyMarkup } from './telegram.api';
import { BOT_COMMANDS } from './commands';

/**
 * Menu del bot.
 *
 * Telegram muestra los comandos registrados con `setMyCommands` al escribir «/».
 * Ademas, `/menu` responde con botones inline para las acciones frecuentes, de
 * modo que no haya que recordar ningun comando.
 */

export const MENU_KEYBOARD: ReplyMarkup = {
  inline_keyboard: [
    [{ text: '▶️ Elegir y grabar tiempo', callback_data: 'menu:registrar' }],
    [
      { text: '📊 Estado', callback_data: 'menu:estado' },
      { text: '⏹ Terminar', callback_data: 'menu:terminar' },
    ],
    [
      { text: '⏸ Pausar', callback_data: 'menu:pausar' },
      { text: '▶️ Retomar', callback_data: 'menu:retomar' },
    ],
    [
      { text: '➕ Crear cliente y proyecto', callback_data: 'newclient:' },
      { text: '📁 Nuevo proyecto', callback_data: 'newproj:' },
    ],
    [
      { text: '🏷 Nuevo tipo de tarea', callback_data: 'menu:newtasktype' },
      { text: '📈 Reporte de hoy', callback_data: 'menu:reporte' },
    ],
    [
      { text: '⏱ Tiempo de una tarea', callback_data: 'menu:tiempo' },
      { text: '📝 Pendientes', callback_data: 'menu:pendientes' },
    ],
    [{ text: '❓ Ayuda', callback_data: 'menu:ayuda' }],
  ],
};

/** Texto del menu, generado desde el catalogo de comandos (una sola verdad). */
export function menuText(companyName: string, linked: boolean): string {
  const comandos = BOT_COMMANDS.map((c) => `/${c.command} — ${c.description}`).join('\n');
  return [
    `🤖 <b>${companyName} · Menú</b>`,
    '',
    linked
      ? 'Usa los botones de abajo o cualquiera de estos comandos:'
      : '⚠️ Tu Telegram aún no está vinculado: toca <b>📱 Compartir mi número</b>.',
    '',
    comandos,
    '',
    '<i>También puedes escribir o dictar la tarea en lenguaje natural:</i>',
    '<i>«iniciando tarea de maquetación del login para el cliente Acme»</i>',
  ].join('\n');
}
