/** Utilidades de fecha/duracion sin dependencias externas (Intl para timezones). */

export const nowIso = (): string => new Date().toISOString();

export const toDate = (value: string | Date): Date => (value instanceof Date ? value : new Date(value));

export const secondsBetween = (from: Date, to: Date): number =>
  Math.max(0, Math.floor((to.getTime() - from.getTime()) / 1000));

/** "lunes" -> 1 ... "domingo" -> 0 (para "que hice el lunes"). */
export const WEEKDAY_NAMES: Record<string, number> = {
  domingo: 0, lunes: 1, martes: 2, miercoles: 3, miércoles: 3, jueves: 4, viernes: 5, sabado: 6, sábado: 6,
  sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6,
};

/** Devuelve partes de fecha en la zona horaria indicada. */
export function zonedParts(date: Date, timeZone: string) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    weekday: 'short',
  });
  const parts = Object.fromEntries(fmt.formatToParts(date).map((p) => [p.type, p.value]));
  const weekdayMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour === '24' ? '0' : parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
    weekday: weekdayMap[parts.weekday as string] ?? 0,
    dateStr: `${parts.year}-${parts.month}-${parts.day}`,
    timeStr: `${parts.hour === '24' ? '00' : parts.hour}:${parts.minute}`,
  };
}

/** "YYYY-MM-DD" de un Date en la zona horaria dada. */
export const zonedDateString = (date: Date, timeZone: string): string => zonedParts(date, timeZone).dateStr;

/** "HH:MM" en minutos desde medianoche. */
export function timeToMinutes(value: string): number {
  const [h, m] = value.split(':').map((n) => Number.parseInt(n, 10));
  return (Number.isFinite(h) ? h : 0) * 60 + (Number.isFinite(m) ? m : 0);
}

export function isWithinWorkHours(
  date: Date,
  opts: { timezone: string; workDays: number[]; workStart: string; workEnd: string },
): boolean {
  const parts = zonedParts(date, opts.timezone);
  if (!opts.workDays.includes(parts.weekday)) return false;
  const minutes = parts.hour * 60 + parts.minute;
  const start = timeToMinutes(opts.workStart);
  const end = timeToMinutes(opts.workEnd);
  return minutes >= start && minutes <= end;
}

/** Limites (UTC) del dia local del usuario, para filtrar consultas. */
export function dayBounds(date: Date, timeZone: string): { from: Date; to: Date } {
  const parts = zonedParts(date, timeZone);
  // Construye la medianoche local como fecha UTC equivalente.
  const utcMidnight = Date.UTC(parts.year, parts.month - 1, parts.day, 0, 0, 0);
  const tzOffsetMs = getTimeZoneOffsetMs(date, timeZone);
  const from = new Date(utcMidnight - tzOffsetMs);
  const to = new Date(from.getTime() + 24 * 3600 * 1000);
  return { from, to };
}

/** Offset de la zona horaria en ms (positivo al este de UTC). */
export function getTimeZoneOffsetMs(date: Date, timeZone: string): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const parts = Object.fromEntries(dtf.formatToParts(date).map((p) => [p.type, p.value]));
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour === '24' ? '0' : parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
  return asUtc - date.getTime();
}

/** Formatea una fecha en la zona del usuario: "lun 12 may, 14:30" */
export function formatLocal(date: Date, timeZone: string, withTime = true): string {
  return new Intl.DateTimeFormat('es-CO', {
    timeZone,
    weekday: 'short',
    day: '2-digit',
    month: 'short',
    ...(withTime ? { hour: '2-digit', minute: '2-digit', hour12: false } : {}),
  }).format(date);
}

/** Duracion legible: "1h 24m" */
export function humanDuration(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  if (s === 0) return 'unos segundos';
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h && m) return `${h}h ${m}m`;
  if (h) return `${h}h`;
  if (m) return `${m}m`;
  return `${s}s`;
}

export const startOfDayUtc = (d: Date): Date =>
  new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0, 0));

export function addDays(d: Date, days: number): Date {
  const copy = new Date(d.getTime());
  copy.setUTCDate(copy.getUTCDate() + days);
  return copy;
}

/** Rango [from, to) a partir de un preset usado por el panel. */
export function resolveRange(
  preset: string,
  timeZone: string,
): { from: Date; to: Date; label: string } {
  const now = new Date();
  switch (preset) {
    case 'today': {
      const { from, to } = dayBounds(now, timeZone);
      return { from, to, label: 'Hoy' };
    }
    case 'yesterday': {
      const yesterday = addDays(now, -1);
      const { from, to } = dayBounds(yesterday, timeZone);
      return { from, to, label: 'Ayer' };
    }
    case 'last7': {
      const { from: todayStart, to } = dayBounds(now, timeZone);
      return { from: addDays(todayStart, -6), to, label: 'Ultimos 7 dias' };
    }
    case 'last30': {
      const { from: todayStart, to } = dayBounds(now, timeZone);
      return { from: addDays(todayStart, -29), to, label: 'Ultimos 30 dias' };
    }
    case 'thisMonth': {
      const parts = zonedParts(now, timeZone);
      const offset = getTimeZoneOffsetMs(now, timeZone);
      const from = new Date(Date.UTC(parts.year, parts.month - 1, 1) - offset);
      const to = new Date(Date.UTC(parts.year, parts.month, 1) - offset);
      return { from, to, label: 'Mes actual' };
    }
    case 'lastMonth': {
      const parts = zonedParts(now, timeZone);
      const offset = getTimeZoneOffsetMs(now, timeZone);
      const from = new Date(Date.UTC(parts.year, parts.month - 2, 1) - offset);
      const to = new Date(Date.UTC(parts.year, parts.month - 1, 1) - offset);
      return { from, to, label: 'Mes anterior' };
    }
    default: {
      const { from: todayStart, to } = dayBounds(now, timeZone);
      return { from: addDays(todayStart, -29), to, label: 'Ultimos 30 dias' };
    }
  }
}
