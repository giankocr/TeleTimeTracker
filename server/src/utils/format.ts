/** Utilidades de formato compartidas por los servicios. */

export const isoSecondsSince = (from: Date | string, to: Date = new Date()): number => {
  const start = from instanceof Date ? from : new Date(from);
  return Math.max(0, Math.floor((to.getTime() - start.getTime()) / 1000));
};

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

/** Decimal de horas con 2 digitos: 1.75 */
export const hoursFromSeconds = (seconds: number): number => Math.round((seconds / 3600) * 100) / 100;

export const escapeHtml = (value: string | null | undefined): string =>
  (value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export const truncate = (value: string | null | undefined, max = 120): string => {
  const v = (value ?? '').trim();
  return v.length <= max ? v : `${v.slice(0, max - 1)}…`;
};
