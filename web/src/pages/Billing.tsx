import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { RANGE_OPTIONS, formatDate, formatHours } from '../lib/format';
import {
  BILLING_COLOR,
  BILLING_STATUS_LABEL,
  billingBadge,
  billingLabel,
  formatHoursHuman,
  formatMoney,
  fromDateInput,
  hoursDecimal,
  type BillingOverview,
  type BillingTicketRow,
  type InvoiceGroup,
} from '../lib/billing';
import { Alert, Badge, Card, Empty, Field, Modal, RangeSelect, Spinner, StatCard, useToast } from '../components/ui';

/**
 * FACTURACIÓN
 *
 * El control de cobro se lleva en la TAREA (el tiquete), porque se factura
 * trabajo entregado y un tiquete agrupa varios tramos de tiempo. Aquí se puede:
 *   · ver qué queda pendiente de facturar y cuánto dinero representa,
 *   · marcar UN tiquete o un GRUPO (selección múltiple) como facturado/pagado,
 *   · agrupar varios tiquetes bajo un mismo nº de factura y cobrar la factura
 *     entera de una vez,
 *   · saltar al reporte de horas que se entrega al cliente.
 *
 * Por defecto la vista NO acota fechas ("Todo el historial"): si se abriera en
 * "Mes actual", el trabajo sin cobrar de meses anteriores sería invisible, que
 * es justo el error que este control existe para evitar. Cuando la vista sí está
 * acotada, se avisa del pendiente histórico acumulado.
 */

/** Menú de periodos: los del panel + "todo" + rango a mano. */
const PERIOD_OPTIONS = [
  { value: 'all', label: 'Todo el historial' },
  ...RANGE_OPTIONS,
  { value: 'custom', label: 'Rango personalizado' },
];

const STATUS_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'ALL', label: 'Todos los estados' },
  { value: 'PENDING', label: BILLING_STATUS_LABEL.PENDING! },
  { value: 'BILLED', label: BILLING_STATUS_LABEL.BILLED! },
  { value: 'PAID', label: BILLING_STATUS_LABEL.PAID! },
];

interface ClientRow {
  id: string;
  name: string;
  code: string | null;
  isActive: boolean;
}

interface ProjectRow {
  id: string;
  name: string;
  clientId: string;
  clientName: string;
  isActive: boolean;
}

/** Qué se está marcando: una selección de tiquetes o una factura completa. */
interface MarkTarget {
  status: 'PENDING' | 'BILLED' | 'PAID';
  taskIds: string[];
  invoiceRef?: string;
  /**
   * true = marcar por nº de factura. Es más robusto que enviar la lista de ids:
   * alcanza también a los tiquetes de esa factura que no están en la vista.
   */
  byInvoice?: boolean;
  tickets: number;
  seconds: number;
  amount: number;
}

const hoy = (): string => new Date().toISOString().slice(0, 10);

export default function BillingPage() {
  const { can } = useAuth();
  const { push } = useToast();
  const canWrite = can('billing:write');

  const [searchParams, setSearchParams] = useSearchParams();
  const [preset, setPreset] = useState(searchParams.get('preset') ?? 'all');
  const [clientId, setClientId] = useState(searchParams.get('clientId') ?? '');
  const [projectId, setProjectId] = useState(searchParams.get('projectId') ?? '');
  const [status, setStatus] = useState('ALL');
  const [search, setSearch] = useState('');
  const [invoiceFilter, setInvoiceFilter] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');

  const [data, setData] = useState<(BillingOverview & { canWrite: boolean }) | null>(null);
  const [clients, setClients] = useState<ClientRow[]>([]);
  const [projects, setProjects] = useState<ProjectRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const [mark, setMark] = useState<MarkTarget | null>(null);
  const [markForm, setMarkForm] = useState({ invoiceRef: '', date: hoy(), amount: '' });
  const [saving, setSaving] = useState(false);

  const currency = data?.currency ?? 'COP';

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get<BillingOverview & { canWrite: boolean }>('/billing/overview', {
        // Un rango a mano sin las dos fechas no debe caer en un preset por
        // defecto: se trata como "todo" para no esconder tiquetes sin cobrar.
        preset: preset === 'custom' && (!from || !to) ? 'all' : preset,
        from: preset === 'custom' && from ? fromDateInput(from) : undefined,
        to: preset === 'custom' && to ? fromDateInput(to) : undefined,
        clientId: clientId || undefined,
        // El proyecto acota la vista a los tiquetes de ESE proyecto: es la forma
        // de revisar y facturar proyecto por proyecto (p. ej. los de una persona).
        projectId: projectId || undefined,
        billingStatus: status,
        invoiceRef: invoiceFilter || undefined,
        search: search || undefined,
        take: 500,
      });
      setData(res);
      // La selección se limpia al recargar: nunca se debe marcar algo que ya no
      // está en pantalla (los filtros pueden haber cambiado).
      setSelected(new Set());
    } catch (err) {
      push((err as Error).message, 'error');
    } finally {
      setLoading(false);
    }
  }, [preset, from, to, clientId, projectId, status, invoiceFilter, search, push]);

  useEffect(() => {
    const t = setTimeout(() => void load(), 250);
    return () => clearTimeout(t);
  }, [load]);

  useEffect(() => {
    void (async () => {
      const res = await api.get<{ clients: ClientRow[] }>('/clients', { isActive: 'true' }).catch(() => ({ clients: [] }));
      setClients(res.clients);
    })();
  }, []);

  // Los proyectos se recargan al cambiar el cliente: se ofrece solo lo que
  // tiene sentido para el filtro elegido (los proyectos de ese cliente).
  useEffect(() => {
    void (async () => {
      const res = await api
        .get<{ projects: ProjectRow[] }>('/projects', { clientId: clientId || undefined })
        .catch(() => ({ projects: [] }));
      setProjects(res.projects ?? []);
    })();
  }, [clientId]);

  // El cliente, el proyecto y el periodo quedan en la URL para poder compartir
  // el enlace y para que el reporte del cliente se abra con el mismo contexto.
  const changeClient = (value: string) => {
    setClientId(value);
    // Cambiar de cliente invalida el proyecto elegido (es de otro cliente).
    setProjectId('');
    const next = new URLSearchParams(searchParams);
    if (value) next.set('clientId', value);
    else next.delete('clientId');
    next.delete('projectId');
    setSearchParams(next, { replace: true });
  };

  const changeProject = (value: string) => {
    setProjectId(value);
    const next = new URLSearchParams(searchParams);
    if (value) next.set('projectId', value);
    else next.delete('projectId');
    setSearchParams(next, { replace: true });
  };

  const changePreset = (value: string) => {
    setPreset(value);
    const next = new URLSearchParams(searchParams);
    next.set('preset', value);
    setSearchParams(next, { replace: true });
  };

  const tickets = data?.tickets ?? [];

  // --- Totales de la selección ---
  const selection = useMemo(() => {
    const rows = tickets.filter((t) => selected.has(t.id));
    return {
      count: rows.length,
      seconds: rows.reduce((acc, t) => acc + t.seconds, 0),
      amount: rows.reduce((acc, t) => acc + (t.chargedAmount ?? t.amount ?? 0), 0),
    };
  }, [tickets, selected]);

  const allSelected = tickets.length > 0 && tickets.every((t) => selected.has(t.id));

  const toggleOne = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleAll = () => {
    setSelected(allSelected ? new Set() : new Set(tickets.map((t) => t.id)));
  };

  /** Abre el diálogo de marcado para una selección o para una factura completa. */
  const openMark = (target: MarkTarget) => {
    setMarkForm({ invoiceRef: target.invoiceRef ?? '', date: hoy(), amount: '' });
    setMark(target);
  };

  const markSelection = (next: 'PENDING' | 'BILLED' | 'PAID') =>
    openMark({
      status: next,
      taskIds: [...selected],
      tickets: selection.count,
      seconds: selection.seconds,
      amount: selection.amount,
    });

  const markOne = (ticket: BillingTicketRow, next: 'PENDING' | 'BILLED' | 'PAID') =>
    openMark({
      status: next,
      taskIds: [ticket.id],
      invoiceRef: ticket.invoiceRef ?? undefined,
      tickets: 1,
      seconds: ticket.seconds,
      amount: ticket.chargedAmount ?? ticket.amount ?? 0,
    });

  const markInvoice = (invoice: InvoiceGroup, next: 'BILLED' | 'PAID') =>
    openMark({
      status: next,
      taskIds: invoice.taskIds,
      invoiceRef: invoice.invoiceRef,
      byInvoice: true,
      tickets: invoice.tickets,
      seconds: invoice.seconds,
      amount: invoice.amount,
    });

  const submitMark = async () => {
    if (!mark) return;
    setSaving(true);
    try {
      const body: Record<string, unknown> = {
        // Por factura o por selección: la API acepta las dos formas.
        ...(mark.byInvoice && mark.invoiceRef ? { invoiceRef: mark.invoiceRef } : { taskIds: mark.taskIds }),
        status: mark.status,
      };

      if (mark.status === 'BILLED') {
        body.invoiceRefNew = markForm.invoiceRef.trim() || null;
        if (markForm.date) body.billedAt = fromDateInput(markForm.date);
        if (markForm.amount.trim()) body.amount = Number(markForm.amount);
      }
      if (mark.status === 'PAID') {
        if (markForm.invoiceRef.trim()) body.invoiceRefNew = markForm.invoiceRef.trim();
        if (markForm.date) body.paidAt = fromDateInput(markForm.date);
        if (markForm.amount.trim()) body.amount = Number(markForm.amount);
      }

      const res = await api.post<{ updated: number; invoiceRef: string | null }>('/billing/mark', body);
      const etiqueta = billingLabel(mark.status).toLowerCase();
      const extra = res.invoiceRef ? ` en la factura ${res.invoiceRef}` : '';
      push(`${res.updated} tiquete(s) marcados como ${etiqueta}${extra}`, 'success');
      setMark(null);
      setSelected(new Set());
      await load();
    } catch (err) {
      push((err as Error).message, 'error');
    } finally {
      setSaving(false);
    }
  };

  // Aviso honesto: la vista está acotada y hay pendiente de otros periodos.
  const historical = data?.historicalPending;
  const mostrarAvisoHistorico =
    Boolean(historical) &&
    preset !== 'all' &&
    (historical?.seconds ?? 0) > (data?.totals.pending.seconds ?? 0) + 1;

  const reportQuery = new URLSearchParams({ preset: preset === 'all' || preset === 'custom' ? 'thisMonth' : preset });
  if (projectId) reportQuery.set('projectId', projectId);
  // El reporte se emite por cliente; si solo hay proyecto elegido, se deduce su
  // cliente para no obligar a elegirlo a mano otra vez.
  const reportClientId = clientId || projects.find((p) => p.id === projectId)?.clientId || '';

  return (
    <div className="stack">
      <div className="row-between">
        <div>
          <h1>Facturación</h1>
          <p className="page-sub">
            Marca tiquetes como facturados y pagados, agrupa varios en una factura y controla lo que queda por cobrar.
          </p>
        </div>
        <div className="btn-row">
          {reportClientId ? (
            <Link className="btn btn-primary btn-sm" to={`/reporte-cliente?clientId=${reportClientId}&${reportQuery.toString()}`}>
              🧾 Reporte del cliente
            </Link>
          ) : (
            <span className="tiny muted-2" title="Elige un cliente o un proyecto para generar su reporte de horas">
              🧾 Reporte del cliente
            </span>
          )}
          <button className="btn btn-sm" onClick={() => void load()} disabled={loading}>
            ↻ Actualizar
          </button>
        </div>
      </div>

      {data ? (
        <div className="grid grid-4">
          <StatCard
            label="Horas en la vista"
            value={formatHours(data.totals.all.hours)}
            sub={`${data.totals.tickets} tiquete(s) · ${data.range.label}`}
            icon="⏱"
            accent="#818cf8"
          />
          <StatCard
            label="Pendiente de facturar"
            value={formatMoney(data.totals.pending.amount, currency)}
            sub={`${formatHoursHuman(data.totals.pending.seconds)} en ${data.totals.pendingTickets} tiquete(s)`}
            icon="🧾"
            accent={BILLING_COLOR.PENDING}
          />
          <StatCard
            label="Facturado por cobrar"
            value={formatMoney(data.totals.receivable, currency)}
            sub={`${formatHoursHuman(data.totals.billed.seconds)} en ${data.totals.billedTickets} tiquete(s)`}
            icon="⏳"
            accent={BILLING_COLOR.BILLED}
          />
          <StatCard
            label="Cobrado"
            value={formatMoney(data.totals.paid.amount, currency)}
            sub={`${formatHoursHuman(data.totals.paid.seconds)} en ${data.totals.paidTickets} tiquete(s)`}
            icon="✅"
            accent={BILLING_COLOR.PAID}
          />
        </div>
      ) : null}

      {mostrarAvisoHistorico ? (
        <Alert kind="warning">
          Esta vista está acotada a <strong>{data?.range.label}</strong>, pero quedan{' '}
          <strong>{formatHoursHuman(historical?.seconds ?? 0)}</strong> (
          {formatMoney(historical?.amount ?? 0, currency)}) pendientes de facturar en{' '}
          {historical?.tickets} tiquete(s) de todo el historial. Pon el periodo en «Todo el historial» para verlos.
        </Alert>
      ) : null}

      {data && data.unticketed.entries > 0 ? (
        <Alert kind="info">
          Hay <strong>{formatHoursHuman(data.unticketed.seconds)}</strong> en {data.unticketed.entries} registro(s) sin
          tiquete: no se pueden agrupar ni facturar por tiquete. Se corrigen en{' '}
          <Link to="/registros">Registros de tiempo</Link> asignándoles una tarea.
        </Alert>
      ) : null}

      <Card>
        <div className="row" style={{ marginBottom: 14 }}>
          <select className="select" style={{ width: 'auto' }} value={clientId} onChange={(e) => changeClient(e.target.value)}>
            <option value="">Todos los clientes</option>
            {clients.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          <select
            className="select"
            style={{ width: 'auto' }}
            value={projectId}
            onChange={(e) => changeProject(e.target.value)}
            title="Ver y facturar los tiquetes de un solo proyecto"
          >
            <option value="">Todos los proyectos</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {/* Con un cliente elegido sobra el nombre del cliente. */}
                {clientId ? p.name : `${p.name} · ${p.clientName}`}
              </option>
            ))}
          </select>
          <RangeSelect value={preset} onChange={changePreset} options={PERIOD_OPTIONS} />
          <select className="select" style={{ width: 'auto' }} value={status} onChange={(e) => setStatus(e.target.value)}>
            {STATUS_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          <input
            className="input"
            style={{ maxWidth: 240 }}
            placeholder="Buscar tiquete, referencia o factura…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          {preset === 'custom' ? (
            <>
              <input className="input" style={{ width: 'auto' }} type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
              <input className="input" style={{ width: 'auto' }} type="date" value={to} onChange={(e) => setTo(e.target.value)} />
            </>
          ) : null}
          {invoiceFilter ? (
            <button className="btn btn-sm btn-ghost" onClick={() => setInvoiceFilter('')} title="Quitar el filtro por factura">
              Factura {invoiceFilter} ✕
            </button>
          ) : null}
          <span className="spacer" />
          <span className="tiny muted-2">
            {tickets.length} de {data?.total ?? 0}
          </span>
        </div>

        {loading && !data ? (
          <Spinner label="Cargando el control de facturación…" />
        ) : tickets.length === 0 ? (
          <Empty>
            No hay tiquetes con estos filtros. Un tiquete aparece aquí cuando tiene horas registradas
            {status !== 'ALL' ? ' y su estado coincide con el filtro.' : '.'}
          </Empty>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th className="col-check">
                    <label className="checkbox" title="Seleccionar todo lo visible">
                      <input type="checkbox" checked={allSelected} onChange={toggleAll} />
                    </label>
                  </th>
                  <th>Tiquete</th>
                  <th>Cliente · proyecto</th>
                  <th>Tipo</th>
                  <th className="right">Horas</th>
                  <th className="right">Importe</th>
                  <th>Estado</th>
                  <th>Factura</th>
                  <th className="right"></th>
                </tr>
              </thead>
              <tbody>
                {tickets.map((t) => (
                  <tr key={t.id} className={selected.has(t.id) ? 'row-selected' : undefined}>
                    <td className="col-check">
                      <label className="checkbox">
                        <input type="checkbox" checked={selected.has(t.id)} onChange={() => toggleOne(t.id)} />
                      </label>
                    </td>
                    <td className="cell-ticket">
                      {t.reference ? <span className="ticket-ref">{t.reference}</span> : null}
                      {t.title}
                      <br />
                      <span className="tiny muted-2">
                        {t.statusLabel}
                        {t.assigneeName ? ` · ${t.assigneeName}` : ''}
                        {t.lastWorkedAt ? ` · ${formatDate(t.lastWorkedAt)}` : ''}
                        {t.entryCount > 1 ? ` · ${t.entryCount} tramos` : ''}
                      </span>
                    </td>
                    <td className="small">
                      {t.clientName ?? '—'}
                      <br />
                      <span className="tiny muted-2">{t.projectName ?? 'Sin proyecto'}</span>
                    </td>
                    <td className="small muted">{t.taskTypeName ?? '—'}</td>
                    <td className="right mono nowrap" title={`${t.seconds} s`}>
                      {formatHoursHuman(t.seconds)}
                      <br />
                      <span className="tiny muted-2">{hoursDecimal(t.seconds)} h</span>
                    </td>
                    <td className="right money nowrap">
                      {formatMoney(t.chargedAmount ?? t.amount, currency)}
                      <br />
                      <span className="tiny muted-2">
                        {t.rate === null ? 'sin tarifa' : `${formatMoney(t.rate, currency)}/h`}
                      </span>
                    </td>
                    <td>
                      <Badge kind={billingBadge(t.billingStatus)}>{billingLabel(t.billingStatus)}</Badge>
                      {t.billingStatus === 'BILLED' && t.billedAt ? (
                        <>
                          <br />
                          <span className="tiny muted-2">{formatDate(t.billedAt)}</span>
                        </>
                      ) : null}
                      {t.billingStatus === 'PAID' && t.paidAt ? (
                        <>
                          <br />
                          <span className="tiny muted-2">{formatDate(t.paidAt)}</span>
                        </>
                      ) : null}
                    </td>
                    <td className="small">
                      {t.invoiceRef ? (
                        <button
                          className="btn btn-sm btn-ghost"
                          title="Ver solo los tiquetes de esta factura"
                          onClick={() => setInvoiceFilter(t.invoiceRef ?? '')}
                        >
                          {t.invoiceRef}
                        </button>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td>
                      <div className="td-actions">
                        {canWrite ? (
                          <>
                            {t.billingStatus === 'PENDING' ? (
                              <button className="btn btn-sm" title="Marcar este tiquete como facturado" onClick={() => markOne(t, 'BILLED')}>
                                💵 Facturar
                              </button>
                            ) : null}
                            {t.billingStatus === 'BILLED' ? (
                              <button className="btn btn-sm btn-success" title="Marcar este tiquete como pagado" onClick={() => markOne(t, 'PAID')}>
                                ✓ Pagado
                              </button>
                            ) : null}
                            {t.billingStatus !== 'PENDING' ? (
                              <button className="btn btn-sm btn-ghost" title="Deshacer el cobro y volver a pendiente" onClick={() => markOne(t, 'PENDING')}>
                                ↩
                              </button>
                            ) : null}
                          </>
                        ) : (
                          <span className="tiny muted-2">—</span>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {selected.size > 0 ? (
          <div className="bulk-bar" style={{ marginTop: 14 }}>
            <span className="bulk-count">
              {selection.count} tiquete(s) seleccionado(s)
            </span>
            <span className="tiny muted-2">
              {formatHoursHuman(selection.seconds)} · {formatMoney(selection.amount, currency)}
            </span>
            <span className="spacer" />
            {canWrite ? (
              <>
                <button className="btn btn-sm btn-primary" onClick={() => markSelection('BILLED')}>
                  💵 Marcar facturado
                </button>
                <button className="btn btn-sm btn-success" onClick={() => markSelection('PAID')}>
                  ✓ Marcar pagado
                </button>
                <button className="btn btn-sm btn-ghost" onClick={() => markSelection('PENDING')}>
                  ↩ Volver a pendiente
                </button>
              </>
            ) : (
              <span className="tiny muted-2">🔒 Marcar requiere el permiso billing:write</span>
            )}
            <button className="btn btn-sm btn-ghost" onClick={() => setSelected(new Set())}>
              Quitar selección
            </button>
          </div>
        ) : null}
      </Card>

      {data && data.invoices.length > 0 ? (
        <Card
          title="Facturas"
          hint="Una factura es el conjunto de tiquetes marcados con el mismo número. Se puede cobrar la factura entera de una vez."
        >
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Nº de factura</th>
                  <th>Cliente</th>
                  <th className="right">Tiquetes</th>
                  <th className="right">Horas</th>
                  <th className="right">Importe</th>
                  <th>Estado</th>
                  <th>Facturada</th>
                  <th className="right"></th>
                </tr>
              </thead>
              <tbody>
                {data.invoices.map((inv) => (
                  <tr key={inv.invoiceRef}>
                    <td className="mono">{inv.invoiceRef}</td>
                    <td className="small">{inv.clientNames.join(', ') || '—'}</td>
                    <td className="right muted">{inv.tickets}</td>
                    <td className="right mono nowrap">{formatHoursHuman(inv.seconds)}</td>
                    <td className="right money nowrap">{formatMoney(inv.amount, currency)}</td>
                    <td>
                      <Badge kind={billingBadge(inv.billingStatus)}>{billingLabel(inv.billingStatus)}</Badge>
                    </td>
                    <td className="small muted">{inv.billedAt ? formatDate(inv.billedAt) : '—'}</td>
                    <td>
                      <div className="td-actions">
                        <button className="btn btn-sm btn-ghost" title="Ver los tiquetes de esta factura" onClick={() => setInvoiceFilter(inv.invoiceRef)}>
                          🔎
                        </button>
                        {canWrite && inv.billingStatus !== 'PAID' ? (
                          <button className="btn btn-sm btn-success" title="Cobrar la factura completa" onClick={() => markInvoice(inv, 'PAID')}>
                            ✓ Cobrada
                          </button>
                        ) : null}
                        {canWrite && inv.billingStatus === 'PENDING' ? (
                          <button className="btn btn-sm" title="Facturar todos los tiquetes de esta factura" onClick={() => markInvoice(inv, 'BILLED')}>
                            💵 Facturar
                          </button>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      ) : null}

      {mark ? (
        <Modal
          title={
            mark.status === 'BILLED'
              ? `Facturar ${mark.tickets} tiquete(s)`
              : mark.status === 'PAID'
                ? `Marcar como pagado ${mark.tickets} tiquete(s)`
                : `Volver a pendiente ${mark.tickets} tiquete(s)`
          }
          onClose={() => (saving ? undefined : setMark(null))}
          footer={
            <>
              <button className="btn btn-ghost" onClick={() => setMark(null)} disabled={saving}>
                Cancelar
              </button>
              <button className="btn btn-primary" onClick={() => void submitMark()} disabled={saving}>
                {saving ? 'Guardando…' : mark.status === 'PENDING' ? 'Sí, volver a pendiente' : `Confirmar ${billingLabel(mark.status).toLowerCase()}`}
              </button>
            </>
          }
        >
          <div className="stack-sm">
            <span className="small">
              {formatHoursHuman(mark.seconds)} · {formatMoney(mark.amount, currency)}
            </span>
            {mark.status === 'PENDING' ? (
              <Alert kind="warning">
                Esto deshace el cobro: se limpian las fechas, el número de factura y el importe congelado. Los tiquetes
                vuelven a contar como pendientes de facturar. El rastro de que estuvieron facturados queda en la auditoría.
              </Alert>
            ) : null}

            {mark.status === 'BILLED' ? (
              <>
                <Field
                  label="Nº de factura"
                  hint="Es lo que agrupa varios tiquetes en una misma factura. Si lo dejas vacío, quedan facturados sin número."
                >
                  <input
                    className="input"
                    value={markForm.invoiceRef}
                    placeholder="F-2026-014"
                    onChange={(e) => setMarkForm({ ...markForm, invoiceRef: e.target.value })}
                  />
                </Field>
                <Field label="Fecha de facturación">
                  <input className="input" type="date" value={markForm.date} onChange={(e) => setMarkForm({ ...markForm, date: e.target.value })} />
                </Field>
              </>
            ) : null}

            {mark.status === 'PAID' ? (
              <>
                <Alert kind="info">
                  El importe ya facturado se conserva tal cual: cobrar no recalcula lo que se facturó.
                </Alert>
                <Field label="Nº de factura" hint="Opcional: solo si quieres asignarles o corregirles el número ahora.">
                  <input
                    className="input"
                    value={markForm.invoiceRef}
                    placeholder="F-2026-014"
                    onChange={(e) => setMarkForm({ ...markForm, invoiceRef: e.target.value })}
                  />
                </Field>
                <Field label="Fecha de pago">
                  <input className="input" type="date" value={markForm.date} onChange={(e) => setMarkForm({ ...markForm, date: e.target.value })} />
                </Field>
              </>
            ) : null}

            {mark.status !== 'PENDING' ? (
              <Field
                label="Importe por tiquete (opcional)"
                hint="Déjalo vacío para calcular horas × tarifa. Si lo llenas, ese importe se congela en cada tiquete y sustituye al calculado (útil para tarifas planas)."
              >
                <input
                  className="input"
                  type="number"
                  min="0"
                  step="any"
                  value={markForm.amount}
                  placeholder="Se calcula con las horas y la tarifa"
                  onChange={(e) => setMarkForm({ ...markForm, amount: e.target.value })}
                />
              </Field>
            ) : null}
          </div>
        </Modal>
      ) : null}
    </div>
  );
}
