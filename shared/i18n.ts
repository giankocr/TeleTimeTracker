/**
 * IDIOMA DEL REPORTE QUE SE ENTREGA AL CLIENTE
 *
 * El idioma vive en el CLIENTE (no en el usuario del panel): el documento es
 * para él, y una misma persona emite reportes a clientes de idiomas distintos.
 * El panel sigue en español —es la herramienta de quien trabaja— pero el
 * documento y su CSV salen en el idioma del destinatario.
 *
 * Este archivo lo usan los dos lados: el servidor (cabeceras y totales del CSV)
 * y el panel (el documento imprimible). Al ser una sola lista de textos, el
 * papel y el CSV no se pueden desincronizar.
 */

export const REPORT_LOCALES = ['es', 'en'] as const;
export type ReportLocale = (typeof REPORT_LOCALES)[number];

export const DEFAULT_REPORT_LOCALE: ReportLocale = 'es';

/** Cómo se llama cada idioma en el selector del panel. */
export const REPORT_LOCALE_LABEL: Record<ReportLocale, string> = {
  es: 'Español',
  en: 'English',
};

/**
 * Normaliza lo que venga de la base o de la API.
 * Cualquier cosa que empiece por "en" es inglés (acepta "en", "en-US", "EN");
 * el resto cae a español, que es el idioma por defecto del sistema.
 */
export const normalizeLocale = (value: string | null | undefined): ReportLocale =>
  (value ?? '').trim().toLowerCase().startsWith('en') ? 'en' : 'es';

/** Etiqueta BCP-47 para `Intl`: fechas, números y moneda. */
export const localeTag = (locale: ReportLocale): string => (locale === 'en' ? 'en-US' : 'es-CO');

/**
 * Textos del documento. La clave describe el sitio, no el texto: así el mismo
 * `doc.generated_on` sirve para "Generado el" y "Generated on".
 */
const STRINGS = {
  es: {
    // Cabecera del emisor
    'doc.tax_id': 'Identificación fiscal',
    'doc.generated_on': 'Generado el',
    'doc.powered_by': 'Documento generado con TeleTimeTracker.',
    // Datos del destinatario y del periodo
    'doc.client': 'Cliente',
    'doc.code': 'Código',
    'doc.period': 'Periodo',
    // Nombre del periodo (el servidor lo manda en español; el documento lo traduce)
    'period.today': 'Hoy',
    'period.yesterday': 'Ayer',
    'period.last7': 'Últimos 7 días',
    'period.last30': 'Últimos 30 días',
    'period.thisMonth': 'Mes actual',
    'period.lastMonth': 'Mes anterior',
    'period.custom': 'Rango personalizado',
    'period.all': 'Todo el historial',
    // Título y alcance
    'doc.title': 'Reporte de horas y tiquetes',
    'doc.tickets_unit': 'tiquete(s)',
    'doc.people_unit': 'persona(s)',
    'doc.includes_billed': 'Incluye horas ya facturadas.',
    'doc.only_pending': 'Solo horas pendientes de facturar.',
    'doc.scope_all': 'Incluye a todo el equipo.',
    'doc.scope_team': 'Incluye a tu equipo.',
    'doc.scope_me': 'Incluye solo tus horas.',
    // Resumen
    'doc.summary': 'Resumen del periodo',
    'doc.concept': 'Concepto',
    'doc.hours': 'Horas',
    'doc.amount': 'Importe',
    'doc.row_all': 'Horas del periodo',
    'doc.row_pending': 'Pendiente de facturar',
    'doc.row_billed': 'Facturado (por cobrar)',
    'doc.row_paid': 'Pagado',
    'doc.total': 'TOTAL DEL PERIODO',
    // Resumen por proyecto
    'doc.by_project': 'Resumen por proyecto',
    'doc.project': 'Proyecto',
    'doc.tickets': 'Tiquetes',
    // Detalle de tiquetes
    'doc.details': 'Detalle de tiquetes realizados',
    'doc.ticket': 'Tiquete',
    'doc.type': 'Tipo',
    'doc.assignees': 'Responsable(s)',
    'doc.segments': 'Tramos',
    'doc.rate': 'Tarifa',
    'doc.status': 'Estado',
    'doc.invoice': 'Factura',
    'doc.no_project': 'Sin proyecto',
    'doc.none': '—',
    'doc.segments_of': 'Tramos de tiempo del tiquete',
    'doc.no_title': 'Sin título',
    'doc.not_billable': '(no facturable)',
    // Aviso de horas sin tiquete
    'doc.unticketed_1': 'se registraron sin tiquete',
    'doc.unticketed_2':
      'de este periodo. Ese tiempo no se puede agrupar ni facturar por tiquete, así que no aparece en el detalle ni suma a los totales de este reporte.',
    // Firmas
    'doc.signature_author': 'Elaboró',
    'doc.signature_client': 'Recibido / aprobado por el cliente',
    'doc.signature_hint': 'Firma y fecha',
    // Estados de cobro (los que ve el cliente)
    'status.PENDING': 'Pendiente',
    'status.BILLED': 'Facturado',
    'status.PAID': 'Pagado',
    // Cabeceras del CSV
    'csv.reference': 'referencia',
    'csv.ticket': 'tiquete',
    'csv.description': 'descripcion',
    'csv.project': 'proyecto',
    'csv.type': 'tipo',
    'csv.assignees': 'responsables',
    'csv.first': 'primera_actividad',
    'csv.last': 'ultima_actividad',
    'csv.segments': 'tramos',
    'csv.hours': 'horas',
    'csv.hours_decimal': 'horas_decimal',
    'csv.rate': 'tarifa_hora',
    'csv.amount': 'importe',
    'csv.billing_status': 'estado_facturacion',
    'csv.invoice': 'factura',
    'csv.billed_at': 'facturado_en',
    'csv.paid_at': 'pagado_en',
  },
  en: {
    'doc.tax_id': 'Tax ID',
    'doc.generated_on': 'Generated on',
    'doc.powered_by': 'Document generated with TeleTimeTracker.',
    'doc.client': 'Client',
    'doc.code': 'Code',
    'doc.period': 'Period',
    'period.today': 'Today',
    'period.yesterday': 'Yesterday',
    'period.last7': 'Last 7 days',
    'period.last30': 'Last 30 days',
    'period.thisMonth': 'Current month',
    'period.lastMonth': 'Previous month',
    'period.custom': 'Custom range',
    'period.all': 'All history',
    'doc.title': 'Hours and tickets report',
    'doc.tickets_unit': 'ticket(s)',
    'doc.people_unit': 'person(s)',
    'doc.includes_billed': 'Includes hours already invoiced.',
    'doc.only_pending': 'Only hours pending invoicing.',
    'doc.scope_all': 'Includes the whole team.',
    'doc.scope_team': 'Includes your team.',
    'doc.scope_me': 'Includes your hours only.',
    'doc.summary': 'Period summary',
    'doc.concept': 'Item',
    'doc.hours': 'Hours',
    'doc.amount': 'Amount',
    'doc.row_all': 'Hours in period',
    'doc.row_pending': 'Pending invoicing',
    'doc.row_billed': 'Invoiced (receivable)',
    'doc.row_paid': 'Paid',
    'doc.total': 'PERIOD TOTAL',
    'doc.by_project': 'Summary by project',
    'doc.project': 'Project',
    'doc.tickets': 'Tickets',
    'doc.details': 'Detail of tickets worked',
    'doc.ticket': 'Ticket',
    'doc.type': 'Type',
    'doc.assignees': 'Assigned to',
    'doc.segments': 'Segments',
    'doc.rate': 'Rate',
    'doc.status': 'Status',
    'doc.invoice': 'Invoice',
    'doc.no_project': 'No project',
    'doc.none': '—',
    'doc.segments_of': 'Time segments of the ticket',
    'doc.no_title': 'Untitled',
    'doc.not_billable': '(non-billable)',
    'doc.unticketed_1': 'were registered without a ticket',
    'doc.unticketed_2':
      'in this period. That time cannot be grouped or invoiced per ticket, so it does not appear in the detail and is not added to this report totals.',
    'doc.signature_author': 'Prepared by',
    'doc.signature_client': 'Received / approved by the client',
    'doc.signature_hint': 'Signature and date',
    'status.PENDING': 'Pending',
    'status.BILLED': 'Invoiced',
    'status.PAID': 'Paid',
    'csv.reference': 'reference',
    'csv.ticket': 'ticket',
    'csv.description': 'description',
    'csv.project': 'project',
    'csv.type': 'type',
    'csv.assignees': 'assigned_to',
    'csv.first': 'first_activity',
    'csv.last': 'last_activity',
    'csv.segments': 'segments',
    'csv.hours': 'hours',
    'csv.hours_decimal': 'hours_decimal',
    'csv.rate': 'hourly_rate',
    'csv.amount': 'amount',
    'csv.billing_status': 'billing_status',
    'csv.invoice': 'invoice',
    'csv.billed_at': 'billed_on',
    'csv.paid_at': 'paid_on',
  },
} as const;

export type ReportStringKey = keyof (typeof STRINGS)['es'];

/** Texto del documento en el idioma pedido (con respaldo en español). */
export const tr = (locale: ReportLocale, key: ReportStringKey): string =>
  STRINGS[locale]?.[key] ?? STRINGS.es[key];

/** Texto del estado de cobro (`PENDING` | `BILLED` | `PAID`) en su idioma. */
export const billingStatusText = (locale: ReportLocale, status: string | null | undefined): string => {
  const key = `status.${status ?? ''}` as ReportStringKey;
  return STRINGS[locale]?.[key] ?? STRINGS.es[key] ?? (status ?? '—');
};
