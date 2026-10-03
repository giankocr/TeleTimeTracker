/**
 * Helpers de formato usados por todo el panel.
 */

export const API_SAFE = 'sin proyecto';

/** Duracion legible a partir de horas decimales: "2h 30m", "45m", "12s". */
export function formatHours(hours: number): string {
  if (!Number.isFinite(hours) || hours <= 0) return '0m';
  const totalSeconds = Math.round(hours * 3600);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.round((totalSeconds % 3600) / 60);
  if (h && m) return `${h}h ${m}m`;
  if (h) return `${h}h`;
  return `${m}m`;
}

export function formatSeconds(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('es-CO', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('es-CO', { day: '2-digit', month: 'short', year: 'numeric' });
}

export function formatTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit', hour12: false });
}

export function relativeFrom(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return 'hace unos segundos';
  if (minutes < 60) return `hace ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `hace ${hours} h`;
  const days = Math.floor(hours / 24);
  return `hace ${days} d`;
}

export const STATUS_LABEL: Record<string, string> = {
  RUNNING: 'En curso',
  PAUSED: 'En pausa',
  FINISHED: 'Finalizada',
  CANCELLED: 'Descartada',
};

export const STATUS_BADGE: Record<string, string> = {
  RUNNING: 'badge badge-success',
  PAUSED: 'badge badge-warning',
  FINISHED: 'badge',
  CANCELLED: 'badge badge-danger',
};

export const SOURCE_LABEL: Record<string, string> = {
  TELEGRAM_VOICE: '🎙 Voz',
  TELEGRAM_TEXT: '💬 Texto',
  TELEGRAM_BUTTON: '🔘 Botón',
  WEB: '🖥 Panel',
  API: '🔌 API',
};

export const PRIORITY_LABEL: Record<string, string> = { HIGH: 'Alta', NORMAL: 'Normal', LOW: 'Baja' };

export const WEEKDAYS = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];

/** Paleta para graficos (recharts). */
export const CHART_COLORS = ['#6366f1', '#22d3ee', '#22c55e', '#f59e0b', '#ef4444', '#8b5cf6', '#14b8a6', '#f97316', '#e879f9', '#64748b'];

export const RANGE_OPTIONS = [
  { value: 'today', label: 'Hoy' },
  { value: 'yesterday', label: 'Ayer' },
  { value: 'last7', label: 'Últimos 7 días' },
  { value: 'last30', label: 'Últimos 30 días' },
  { value: 'thisMonth', label: 'Mes actual' },
  { value: 'lastMonth', label: 'Mes anterior' },
];
