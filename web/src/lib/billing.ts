/**
 * Ayudas de facturación para el panel.
 *
 * Los estados, la moneda y los DTOs viven en `shared/types.ts` (la misma fuente
 * que usa el servidor) para que un cambio de estado —por ejemplo añadir uno
 * nuevo— no obligue a tocar el panel y el backend por separado.
 */
export {
  BILLING_STATUSES,
  BILLING_STATUS_LABEL,
  BILLING_STATUS_SHORT,
  CURRENCIES,
  DEFAULT_CURRENCY,
  RATE_SOURCE_LABEL,
  currencyDecimals,
  roundMoney,
} from '../../../shared/types';

export type {
  BillingClientGroup,
  BillingOverview,
  BillingStatus,
  BillingTicketRow,
  ClientStatement,
  InvoiceGroup,
  RateSource,
  StatementEntry,
  StatementProjectGroup,
  StatementTicket,
  CurrencyOption,
} from '../../../shared/types';

import { CURRENCIES, DEFAULT_CURRENCY, currencyDecimals } from '../../../shared/types';
import { billingStatusText, localeTag, type ReportLocale } from '../../../shared/i18n';

/** Badge por estado de facturación (mismo idioma visual que el resto del panel). */
export const BILLING_BADGE: Record<string, string> = {
  PENDING: 'badge badge-warning',
  BILLED: 'badge badge-info',
  PAID: 'badge badge-success',
};

/** Color de acento por estado, para tarjetas y gráficos. */
export const BILLING_COLOR: Record<string, string> = {
  PENDING: '#f59e0b',
  BILLED: '#22d3ee',
  PAID: '#22c55e',
};

export const billingBadge = (status: string | null | undefined): string =>
  BILLING_BADGE[status ?? ''] ?? 'badge';

/**
 * Etiqueta corta de un estado de facturación. Sale del diccionario compartido
 * para que el panel y el documento digan lo mismo; por defecto en español, que
 * es el idioma del panel, y el reporte pide el idioma del cliente.
 */
export const billingLabel = (status: string | null | undefined, locale: ReportLocale = 'es'): string =>
  status ? billingStatusText(locale, status) : '—';

/** ¿Es un código de moneda del catálogo? */
export const isKnownCurrency = (code: string | null | undefined): boolean =>
  CURRENCIES.some((c) => c.code === (code ?? '').toUpperCase());

/**
 * Importe con la moneda configurada.
 * Usa `Intl` en lugar de concatenar el símbolo a mano: así el separador de
 * miles y la posición del símbolo salen correctos en cada moneda.
 */
export function formatMoney(
  value: number | null | undefined,
  currency = DEFAULT_CURRENCY,
  /** Idioma del documento: cambia el separador de miles y el de decimales. */
  locale: ReportLocale = 'es',
): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  const code = (currency || DEFAULT_CURRENCY).toUpperCase();
  const decimals = currencyDecimals(code);
  try {
    return new Intl.NumberFormat(localeTag(locale), {
      style: 'currency',
      currency: code,
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    }).format(value);
  } catch {
    // Código de moneda no reconocido por Intl: se muestra el número tal cual.
    return `${value.toFixed(decimals)} ${code}`;
  }
}

/** Horas en formato "7h 30m" (para documentos que lee una persona). */
export function formatHoursHuman(seconds: number | null | undefined): string {
  const s = Math.max(0, Math.floor(seconds ?? 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (!h && !m) return `${s}s`;
  if (!h) return `${m}m`;
  return `${h}h ${String(m).padStart(2, '0')}m`;
}

/** Horas decimales con 2 dígitos: 7.5 */
export const hoursDecimal = (seconds: number | null | undefined): number =>
  Math.round(((seconds ?? 0) / 3600) * 100) / 100;

/** Fecha "YYYY-MM-DD" para inputs `type="date"`. */
export const toDateInput = (iso: string | null | undefined): string =>
  iso ? new Date(iso).toISOString().slice(0, 10) : '';

/** ISO de un `type="date"` (mediodía local: evita el salto de día por zona). */
export const fromDateInput = (value: string): string | undefined => {
  if (!value) return undefined;
  const date = new Date(`${value}T12:00:00`);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
};
