import { Fragment, useCallback, useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, downloadFile } from '../lib/api';
import { useAuth } from '../lib/auth';
import { RANGE_OPTIONS, formatDate, formatDateTime } from '../lib/format';
import {
  BILLING_STATUS_LABEL,
  RATE_SOURCE_LABEL,
  billingBadge,
  billingLabel,
  formatHoursHuman,
  formatMoney,
  fromDateInput,
  type ClientStatement,
  type StatementEntry,
} from '../lib/billing';
import { Alert, Badge, Card, Empty, Field, RangeSelect, Spinner, StatCard, useToast } from '../components/ui';
import {
  REPORT_LOCALE_LABEL,
  localeTag,
  normalizeLocale,
  tr,
  type ReportLocale,
  type ReportStringKey,
} from '../../../shared/i18n';

/**
 * ESTADO DE HORAS DEL CLIENTE
 *
 * El papel que se le entrega al cliente: horas del periodo con el detalle de los
 * tiquetes (tareas) realizados. Dos versiones del mismo dato conviven aquí:
 *
 *  - En pantalla: filtros y tarjetas de resumen, para revisar antes de enviar.
 *  - En papel  (`.print-doc`): un documento autocontenido —cabecera del emisor,
 *    cliente, periodo, resumen, detalle y firmas— sin nada del panel alrededor.
 *
 * Por eso todo lo que es interfaz va marcado `no-print`, y todo lo que debe
 * sobrevivir a la impresión vive dentro del documento (incluida la fecha de
 * generación, que en pantalla es obvia y en papel no).
 *
 * La moneda y los importes vienen resueltos del servidor (redondeo incluido):
 * aquí solo se formatean, nunca se vuelven a redondear.
 */
/**
 * Preset del periodo -> clave del diccionario. El nombre del periodo lo calcula
 * el servidor (en español) para los filtros, pero el documento va en el idioma
 * del cliente, así que aquí se rotula con la clave que le corresponde.
 */
const REPORT_PERIOD_KEYS: Record<string, ReportStringKey> = {
  today: 'period.today',
  yesterday: 'period.yesterday',
  last7: 'period.last7',
  last30: 'period.last30',
  thisMonth: 'period.thisMonth',
  lastMonth: 'period.lastMonth',
  custom: 'period.custom',
  all: 'period.all',
};

export default function ClientStatementPage() {
  const { push } = useToast();
  const { can, loading: authLoading } = useAuth();

  // Cliente y periodo viven en la URL: el enlace desde Facturación llega como
  // /reporte-cliente?clientId=…&preset=thisMonth, y así el reporte se puede
  // compartir o recargar sin perder los filtros que lo definen.
  const [searchParams, setSearchParams] = useSearchParams();
  const clientId = searchParams.get('clientId') ?? '';
  const preset = searchParams.get('preset') || 'thisMonth';

  const [projectId, setProjectId] = useState('');
  const [billingStatus, setBillingStatus] = useState('ALL');
  // Se incluyen por defecto las horas ya facturadas: un estado de horas que
  // ocultara trabajo entregado y facturado no cuadraría con lo que el cliente vio.
  const [includeBilled, setIncludeBilled] = useState(true);
  // El detalle tramo a tramo solo se pide cuando se va a usar: multiplica el
  // tamaño de la respuesta y muchos envíos solo necesitan el resumen por tiquete.
  const [withEntries, setWithEntries] = useState(false);
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');

  const [clients, setClients] = useState<any[]>([]);
  const [projects, setProjects] = useState<any[]>([]);

  const [statement, setStatement] = useState<ClientStatement | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // El endpoint exige `billing:read`. Sin el permiso no se llama: sería un 403
  // seguro y un toast rojo al abrir la página, en vez del motivo real.
  const sinPermiso = !authLoading && !can('billing:read');
  // Un periodo personalizado a medias no se manda: el servidor lo interpretaría
  // como "mes actual" y entregaría un documento que no es el pedido.
  const customIncompleto = preset === 'custom' && (!customFrom || !customTo);

  /** Mantiene los filtros de la URL sin ensuciar el historial del navegador. */
  const patchParams = (next: Record<string, string>) => {
    const params = new URLSearchParams(searchParams);
    for (const [key, value] of Object.entries(next)) {
      if (value) params.set(key, value);
      else params.delete(key);
    }
    setSearchParams(params, { replace: true });
  };

  const load = useCallback(async () => {
    // Sin cliente no hay nada que cargar (y el servidor lo exige).
    if (!clientId || sinPermiso || customIncompleto) {
      setStatement(null);
      setError(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const data = await api.get<ClientStatement>('/billing/statement', {
        clientId,
        preset,
        projectId: projectId || undefined,
        billingStatus,
        includeBilled: includeBilled ? 'true' : 'false',
        withEntries: withEntries ? 'true' : undefined,
        ...(preset === 'custom' ? { from: fromDateInput(customFrom), to: fromDateInput(customTo) } : {}),
      });
      setStatement(data);
    } catch (err) {
      setStatement(null);
      setError((err as Error).message);
      push((err as Error).message, 'error');
    } finally {
      setLoading(false);
    }
  }, [clientId, preset, projectId, billingStatus, includeBilled, withEntries, customFrom, customTo, sinPermiso, customIncompleto, push]);

  // Pequeño retardo: al cambiar selects seguidos (cliente -> proyecto) no se
  // dispara un reporte por cada tecla o clic intermedio.
  useEffect(() => {
    const t = setTimeout(() => void load(), 250);
    return () => clearTimeout(t);
  }, [load]);

  // Catálogos de apoyo: si el rol no puede verlos (403), la página sigue
  // funcionando con los filtros que sí dependen del reporte.
  useEffect(() => {
    void (async () => {
      const [c, p] = await Promise.all([
        api.get<{ clients: any[] }>('/clients').catch(() => ({ clients: [] })),
        api.get<{ projects: any[] }>('/projects').catch(() => ({ projects: [] })),
      ]);
      setClients(c.clients);
      setProjects(p.projects);
    })();
  }, []);

  /** Cambiar de cliente invalida el proyecto: cada proyecto es de un cliente. */
  const changeClient = (value: string) => {
    setProjectId('');
    patchParams({ clientId: value, preset });
  };

  // El documento solo se dibuja si corresponde al cliente pedido: mientras se
  // recalcula se admite el desfase de un instante en los demás filtros (el aviso
  // de "actualizando" lo delata), pero enseñar —y dejar imprimir— el reporte de
  // OTRO cliente es un error que en un papel entregable no se puede permitir.
  const vigente = statement && statement.client.id === clientId ? statement : null;

  // IDIOMA DEL DOCUMENTO: lo decide el CLIENTE, no quien genera el reporte. El
  // panel (filtros, avisos de pantalla) sigue en español; solo el papel y su CSV
  // —que son lo que recibe el cliente— cambian de idioma.
  const docLocale: ReportLocale = normalizeLocale(vigente?.locale);
  // El idioma también se puede anticipar desde la ficha del cliente, antes de que
  // el reporte termine de cargar: así el aviso no aparece tarde.
  const idiomaCliente: ReportLocale = normalizeLocale(
    vigente?.locale ?? clients.find((c) => c.id === clientId)?.locale,
  );
  const L = (key: ReportStringKey): string => tr(docLocale, key);
  const tag = localeTag(docLocale);
  // El nombre del periodo lo manda el servidor en español, así que el documento
  // lo rotula con el preset elegido (que la página conoce) y deja el del servidor
  // para los rangos que no son un preset.
  const periodoTexto = (preset in REPORT_PERIOD_KEYS ? L(REPORT_PERIOD_KEYS[preset]!) : vigente?.range.label) ?? '';
  const sinDatos = !vigente || vigente.tickets.length === 0;
  const deshabilitado = !clientId || sinDatos;

  // Nombre de archivo estable y sin caracteres raros: lo abre una persona en Excel.
  const nombreArchivo = (vigente?.client.name ?? clients.find((c) => c.id === clientId)?.name ?? 'cliente')
    .replace(/[^\w-]+/g, '_')
    .slice(0, 40);

  /** Mismo reporte en CSV. Se avisa del fallo: una descarga vacía es peor que un error. */
  const exportCsv = async () => {
    if (deshabilitado) return;
    try {
      await downloadFile('/billing/statement.csv', `horas_${nombreArchivo}_${preset}.csv`, {
        clientId,
        preset,
        projectId: projectId || undefined,
        billingStatus,
        includeBilled: includeBilled ? 'true' : 'false',
        ...(preset === 'custom' ? { from: fromDateInput(customFrom), to: fromDateInput(customTo) } : {}),
      });
      push('CSV del estado de horas descargado', 'success');
    } catch (err) {
      push((err as Error).message, 'error');
    }
  };

  // Tramo(s) sumados de los tiquetes listados: es el total de la columna
  // "Tramos", que no es lo mismo que `totals.entries` (ese incluye las horas
  // registradas sin tiquete, que no aparecen en el detalle).
  const tramos = (vigente?.tickets ?? []).reduce((n, t) => n + t.entryCount, 0);

  const opcionesPeriodo = [...RANGE_OPTIONS, { value: 'custom', label: 'Personalizado' }];

  return (
    <div className="stack">
      <div className="row-between no-print">
        <div>
          <h1>Estado de horas del cliente</h1>
          <p className="page-sub">
            Horas trabajadas en un periodo con el detalle de los tiquetes, listo para entregar al cliente o guardar en PDF.
          </p>
        </div>
        <div className="btn-row">
          <button className="btn btn-primary" onClick={() => window.print()} disabled={deshabilitado} title="Abre el diálogo de impresión: elige «Guardar como PDF» para enviarlo">
            🖨 Imprimir / Guardar PDF
          </button>
          <button className="btn btn-sm" onClick={() => void exportCsv()} disabled={deshabilitado} title="El mismo reporte en CSV, para Excel">
            ⬇ CSV
          </button>
          {/* Se avisa ANTES de imprimir: el idioma lo decide el cliente, no quien
              genera el reporte, y conviene saberlo antes de enviarlo. */}
          {idiomaCliente !== 'es' ? (
            <span className="tiny muted-2" title="El idioma se configura en la ficha del cliente">
              Documento en {REPORT_LOCALE_LABEL[idiomaCliente]}
            </span>
          ) : null}
        </div>
      </div>

      <div className="no-print">
        <Card title="Filtros del reporte" hint="El periodo y el cliente definen el documento; el resto acota qué se muestra.">
          <div className="grid grid-3">
            <Field label="Cliente" hint="Obligatorio: el reporte es de un cliente concreto.">
              <select className="select" value={clientId} onChange={(e) => changeClient(e.target.value)}>
                <option value="">Elige un cliente…</option>
                {clients.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                    {c.code ? ` (${c.code})` : ''}
                  </option>
                ))}
              </select>
            </Field>

            <Field label="Periodo" hint="Se guarda en la dirección para poder compartir el enlace.">
              <RangeSelect
                value={preset}
                onChange={(value) => patchParams({ clientId, preset: value })}
                options={opcionesPeriodo}
              />
            </Field>

            <Field label="Proyecto" hint="Solo los proyectos del cliente elegido.">
              <select className="select" value={projectId} onChange={(e) => setProjectId(e.target.value)}>
                <option value="">Todos los proyectos</option>
                {projects
                  .filter((p) => !clientId || p.clientId === clientId)
                  .map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
              </select>
            </Field>

            <Field label="Estado de facturación" hint="Útil para emitir solo lo pendiente de cobrar.">
              <select className="select" value={billingStatus} onChange={(e) => setBillingStatus(e.target.value)}>
                <option value="ALL">Todas</option>
                {Object.entries(BILLING_STATUS_LABEL).map(([key, label]) => (
                  <option key={key} value={key}>
                    {label}
                  </option>
                ))}
              </select>
            </Field>

            {preset === 'custom' ? (
              <>
                <Field label="Desde">
                  <input className="input" type="date" value={customFrom} onChange={(e) => setCustomFrom(e.target.value)} />
                </Field>
                <Field label="Hasta">
                  <input className="input" type="date" value={customTo} onChange={(e) => setCustomTo(e.target.value)} />
                </Field>
              </>
            ) : null}
          </div>

          <div className="row" style={{ gap: 22, marginTop: 4 }}>
            <label className="checkbox">
              <input type="checkbox" checked={includeBilled} onChange={(e) => setIncludeBilled(e.target.checked)} />
              Incluir horas ya facturadas
            </label>
            <label className="checkbox">
              <input type="checkbox" checked={withEntries} onChange={(e) => setWithEntries(e.target.checked)} />
              Incluir el detalle de cada tramo de tiempo
            </label>
          </div>
        </Card>
      </div>

      {error ? (
        <Alert kind="error">
          <div className="row-between">
            <span>No se pudo generar el reporte: {error}</span>
            <button className="btn btn-sm" onClick={() => void load()}>
              Reintentar
            </button>
          </div>
        </Alert>
      ) : null}

      {!clientId ? (
        <Empty>
          <div className="stack-sm" style={{ alignItems: 'center' }}>
            <span>Elige un cliente para generar su estado de horas.</span>
            {clients.length ? (
              <Link className="btn btn-sm" to="/facturacion" title="Ver la cola de cobro y sus tiquetes">
                Ir a Facturación
              </Link>
            ) : (
              <span className="tiny muted-2">Todavía no hay clientes: créalos en el catálogo de clientes.</span>
            )}
          </div>
        </Empty>
      ) : sinPermiso ? (
        <Alert kind="error">
          Tu rol no incluye el permiso de facturación, así que no puede consultar el estado de horas. Pídeselo a un
          administrador.
        </Alert>
      ) : customIncompleto ? (
        <Empty>Elige la fecha de inicio y la de fin del periodo personalizado.</Empty>
      ) : !vigente ? (
        loading ? <Spinner label="Generando el reporte…" /> : <Empty>No se pudo generar el reporte.</Empty>
      ) : (
        <>
          {/* Resumen de pantalla: sirve para revisar antes de imprimir. La versión
              de papel repite estos totales dentro del documento. */}
          {loading ? <div className="no-print tiny muted-2">Actualizando el reporte…</div> : null}

          <div className="grid grid-4 no-print">
            <StatCard
              label="Horas del periodo"
              value={formatHoursHuman(vigente.totals.all.seconds)}
              sub={formatMoney(vigente.totals.all.amount, vigente.currency)}
              icon="⏱"
              accent="#818cf8"
            />
            <StatCard
              label="Pendiente de facturar"
              value={formatHoursHuman(vigente.totals.pending.seconds)}
              sub={formatMoney(vigente.totals.pending.amount, vigente.currency)}
              icon="🧾"
              accent="#f59e0b"
            />
            <StatCard
              label="Facturado (por cobrar)"
              value={formatHoursHuman(vigente.totals.billed.seconds)}
              sub={`Por cobrar: ${formatMoney(vigente.totals.receivable, vigente.currency)}`}
              icon="📤"
              accent="#22d3ee"
            />
            <StatCard
              label="Pagado"
              value={formatHoursHuman(vigente.totals.paid.seconds)}
              sub={formatMoney(vigente.totals.paid.amount, vigente.currency)}
              icon="✅"
              accent="#4ade80"
            />
          </div>

          {vigente.tickets.length === 0 ? (
            <>
              <Card>
                <Empty>No hay horas registradas para este cliente en el periodo.</Empty>
              </Card>
              {vigente.unticketed.seconds > 0 ? (
                <Alert kind="warning">
                  Hay <b>{formatHoursHuman(vigente.unticketed.seconds)}</b> registradas sin tiquete en este periodo (
                  {vigente.unticketed.entries} tramo(s)): no se pueden agrupar ni facturar por tiquete.
                </Alert>
              ) : null}
            </>
          ) : (
            <div className="print-doc">
              {/* Cabecera: quién emite, a quién y de qué periodo. Es lo que hace
                  que el papel se entienda sin el panel al lado. */}
              <div className="print-head">
                <div className="stack-sm" style={{ gap: 2 }}>
                  <h1>{vigente.company.name}</h1>
                  {vigente.company.taxId ? (
                    <span className="small print-muted">
                      {L('doc.tax_id')}: {vigente.company.taxId}
                    </span>
                  ) : null}
                  <span className="small print-muted">
                    {L('doc.generated_on')} {formatDateTime(vigente.generatedAt, tag)}
                  </span>
                  <span className="tiny print-muted print-only">{L('doc.powered_by')}</span>
                </div>
                <div className="stack-sm" style={{ gap: 2, textAlign: 'right' }}>
                  <strong style={{ fontSize: '1.05rem' }}>
                    {L('doc.client')}: {vigente.client.name}
                  </strong>
                  {vigente.client.code ? (
                    <span className="small print-muted">
                      {L('doc.code')}: {vigente.client.code}
                    </span>
                  ) : null}
                  <span className="small print-muted">
                    {L('doc.period')}: {periodoTexto}
                  </span>
                  <span className="small print-muted">
                    {formatDate(vigente.range.from, tag)} – {formatDate(vigente.range.to, tag)}
                  </span>
                </div>
              </div>

              <div className="print-block">
                <h2 style={{ fontSize: '1.15rem', marginBottom: 4 }}>{L('doc.title')}</h2>
                <p className="small print-muted" style={{ marginBottom: 0 }}>
                  {vigente.totals.tickets} {L('doc.tickets_unit')} · {formatHoursHuman(vigente.totals.all.seconds)} ·{' '}
                  {vigente.totals.users} {L('doc.people_unit')}
                </p>
                {/* Honestidad del documento: quien lo recibe debe saber si trae
                    horas ya facturadas y de qué alcance de equipo salen. */}
                <p className="tiny print-muted" style={{ marginTop: 4 }}>
                  {vigente.includeBilled ? L('doc.includes_billed') : L('doc.only_pending')}{' '}
                  {vigente.scope === 'all' ? L('doc.scope_all') : vigente.scope === 'team' ? L('doc.scope_team') : L('doc.scope_me')}
                </p>
              </div>

              <div className="print-block">
                <h3>{L('doc.summary')}</h3>
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>{L('doc.concept')}</th>
                        <th className="right">{L('doc.hours')}</th>
                        <th className="right">{L('doc.amount')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr>
                        <td>{L('doc.row_all')}</td>
                        <td className="right mono">{formatHoursHuman(vigente.totals.all.seconds)}</td>
                        <td className="right mono money">
                          {formatMoney(vigente.totals.all.amount, vigente.currency, docLocale)}
                        </td>
                      </tr>
                      <tr>
                        <td>{L('doc.row_pending')}</td>
                        <td className="right mono">{formatHoursHuman(vigente.totals.pending.seconds)}</td>
                        <td className="right mono money">
                          {formatMoney(vigente.totals.pending.amount, vigente.currency, docLocale)}
                        </td>
                      </tr>
                      <tr>
                        <td>{L('doc.row_billed')}</td>
                        <td className="right mono">{formatHoursHuman(vigente.totals.billed.seconds)}</td>
                        <td className="right mono money">
                          {formatMoney(vigente.totals.billed.amount, vigente.currency, docLocale)}
                        </td>
                      </tr>
                      <tr>
                        <td>{L('doc.row_paid')}</td>
                        <td className="right mono">{formatHoursHuman(vigente.totals.paid.seconds)}</td>
                        <td className="right mono money">
                          {formatMoney(vigente.totals.paid.amount, vigente.currency, docLocale)}
                        </td>
                      </tr>
                    </tbody>
                  </table>
                </div>
                <div className="print-total" style={{ marginTop: 10 }}>
                  <span>
                    {L('doc.total')} · {formatHoursHuman(vigente.totals.all.seconds)}
                  </span>
                  <span className="money">{formatMoney(vigente.totals.all.amount, vigente.currency, docLocale)}</span>
                </div>
              </div>

              {vigente.byProject.length > 1 ? (
                <div className="print-block">
                  <h3>{L('doc.by_project')}</h3>
                  <div className="table-wrap">
                    <table>
                      <thead>
                        <tr>
                          <th>{L('doc.project')}</th>
                          <th className="right">{L('doc.tickets')}</th>
                          <th className="right">{L('doc.hours')}</th>
                          <th className="right">{L('doc.amount')}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {vigente.byProject.map((g) => (
                          <tr key={g.projectId ?? 'none'}>
                            <td>{g.projectName}</td>
                            <td className="right mono">{g.tickets}</td>
                            <td className="right mono">{formatHoursHuman(g.seconds)}</td>
                            <td className="right mono money">{formatMoney(g.amount, vigente.currency, docLocale)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              ) : null}

              <div className="print-block">
                <h3>{L('doc.details')}</h3>
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>{L('doc.ticket')}</th>
                        <th>{L('doc.project')}</th>
                        <th>{L('doc.type')}</th>
                        <th>{L('doc.assignees')}</th>
                        <th className="right">{L('doc.segments')}</th>
                        <th className="right">{L('doc.hours')}</th>
                        <th className="right">{L('doc.rate')}</th>
                        <th className="right">{L('doc.amount')}</th>
                        <th>{L('doc.status')}</th>
                        <th>{L('doc.invoice')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {vigente.tickets.map((t) => (
                        <Fragment key={t.id}>
                          <tr>
                            <td className="cell-ticket">
                              {/* El nº de tiquete es como el cliente lo nombra al reclamar. */}
                              {t.reference ? <span className="ticket-ref">{t.reference}</span> : null}
                              <b>{t.title}</b>
                              {t.description ? <div className="tiny print-muted">{t.description}</div> : null}
                            </td>
                            <td className="small">{t.projectName ?? L('doc.no_project')}</td>
                            <td className="small">{t.taskTypeName ?? L('doc.none')}</td>
                            <td className="small">{t.assignees.length ? t.assignees.join(', ') : L('doc.none')}</td>
                            <td className="right mono">{t.entryCount}</td>
                            <td className="right mono nowrap">{formatHoursHuman(t.seconds)}</td>
                            <td
                              className="right mono money nowrap"
                              title={t.rateSource ? RATE_SOURCE_LABEL[t.rateSource] : undefined}
                            >
                              {t.rate === null || t.rate === undefined
                                ? L('doc.none')
                                : formatMoney(t.rate, vigente.currency, docLocale)}
                            </td>
                            {/* `chargedAmount` es el importe congelado al facturar; si no
                                hay factura, el calculado con la tarifa vigente. */}
                            <td className="right mono money nowrap">
                              {formatMoney(t.chargedAmount ?? t.amount, vigente.currency, docLocale)}
                            </td>
                            <td>
                              <Badge kind={billingBadge(t.billingStatus)}>
                                {billingLabel(t.billingStatus, docLocale)}
                              </Badge>
                            </td>
                            <td className="small nowrap">{t.invoiceRef ?? L('doc.none')}</td>
                          </tr>

                          {/* Detalle tramo a tramo: es lo que el cliente pide cuando
                              quiere saber en qué se fue el tiempo del tiquete. */}
                          {withEntries && t.entries?.length ? (
                            <tr>
                              <td colSpan={10}>
                                <div className="stack-sm" style={{ padding: '4px 0 8px 18px' }}>
                                  <span className="tiny print-muted">
                                    {L('doc.segments_of')} ({t.entries.length})
                                  </span>
                                  {t.entries.map((e: StatementEntry) => (
                                    <div key={e.id} className="row tiny" style={{ gap: 12, flexWrap: 'nowrap' }}>
                                      <span className="nowrap" style={{ minWidth: 92 }}>
                                        {formatDate(e.startedAt, tag)}
                                      </span>
                                      <span className="nowrap" style={{ minWidth: 130 }}>
                                        {e.userName}
                                      </span>
                                      <span style={{ flex: 1 }}>
                                        {e.title ?? L('doc.no_title')}
                                        {e.description ? ` — ${e.description}` : ''}
                                        {e.billable ? '' : ` ${L('doc.not_billable')}`}
                                      </span>
                                      <span className="mono nowrap">{formatHoursHuman(e.seconds)}</span>
                                    </div>
                                  ))}
                                </div>
                              </td>
                            </tr>
                          ) : null}
                        </Fragment>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr>
                        <td colSpan={4}>
                          <b>{L('doc.total')}</b>
                        </td>
                        <td className="right mono">{tramos}</td>
                        <td className="right mono nowrap">{formatHoursHuman(vigente.totals.all.seconds)}</td>
                        <td />
                        <td className="right mono money nowrap">
                          <b>{formatMoney(vigente.totals.all.amount, vigente.currency, docLocale)}</b>
                        </td>
                        <td colSpan={2} />
                      </tr>
                    </tfoot>
                  </table>
                </div>
              </div>

              {vigente.unticketed.seconds > 0 ? (
                <div className="print-block">
                  {/* El amarillo claro del panel no se lee en papel blanco: se
                      fuerza un tono oscuro que sí sobrevive a la impresión. */}
                  <Alert kind="warning">
                    <span style={{ color: '#92400e' }}>
                      <b>{formatHoursHuman(vigente.unticketed.seconds)}</b> {L('doc.unticketed_1')} (
                      {vigente.unticketed.entries} {L('doc.segments').toLowerCase()}). {L('doc.unticketed_2')}
                    </span>
                  </Alert>
                </div>
              ) : null}

              <div className="print-firma">
                <div>
                  {L('doc.signature_author')}
                  <div className="print-muted">{L('doc.signature_hint')}</div>
                </div>
                <div>
                  {L('doc.signature_client')}
                  <div className="print-muted">{L('doc.signature_hint')}</div>
                </div>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
