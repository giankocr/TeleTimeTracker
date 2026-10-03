import { useCallback, useEffect, useState } from 'react';
import { api, downloadFile } from '../lib/api';
import {
  API_SAFE,
  RANGE_OPTIONS,
  SOURCE_LABEL,
  STATUS_BADGE,
  STATUS_LABEL,
  formatDateTime,
  formatHours,
  formatSeconds,
  formatTime,
} from '../lib/format';
import { Alert, Badge, Card, Empty, Field, Modal, RangeSelect, Spinner, useToast } from '../components/ui';
import { useAuth } from '../lib/auth';

/**
 * Registros de tiempo: historial con filtros, control del cronómetro propio
 * y edición manual de horas (correcciones).
 */
export default function EntriesPage() {
  const { push } = useToast();
  const { can } = useAuth();
  const canDelete = can('entries:delete');
  const [preset, setPreset] = useState('last7');
  const [status, setStatus] = useState('');
  const [search, setSearch] = useState('');
  const [clientId, setClientId] = useState('');
  const [projectId, setProjectId] = useState('');
  const [userId, setUserId] = useState('');

  const [data, setData] = useState<any | null>(null);
  const [active, setActive] = useState<any | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);

  const [clients, setClients] = useState<any[]>([]);
  const [projects, setProjects] = useState<any[]>([]);
  const [users, setUsers] = useState<any[]>([]);
  const [taskTypes, setTaskTypes] = useState<any[]>([]);

  const [manualOpen, setManualOpen] = useState(false);
  // Confirmacion de borrado definitivo (irreversible).
  const [toDelete, setToDelete] = useState<any | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [manual, setManual] = useState({ title: '', projectId: '', taskTypeId: '', startedAt: '', endedAt: '', description: '' });
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [entries, activeRes] = await Promise.all([
        api.get<any>('/entries', { preset, status: status || undefined, search: search || undefined, clientId: clientId || undefined, projectId: projectId || undefined, userId: userId || undefined, take: 200 }),
        api.get<{ entry: any }>('/entries/active'),
      ]);
      setData(entries);
      setActive(activeRes.entry);
    } catch (err) {
      push((err as Error).message, 'error');
    } finally {
      setLoading(false);
    }
  }, [preset, status, search, clientId, projectId, userId, push]);

  useEffect(() => {
    const t = setTimeout(() => void load(), 250);
    return () => clearTimeout(t);
  }, [load]);

  useEffect(() => {
    const clock = setInterval(() => setTick((v) => v + 1), 1000);
    return () => clearInterval(clock);
  }, []);

  useEffect(() => {
    void (async () => {
      const [c, p, u, t] = await Promise.all([
        api.get<{ clients: any[] }>('/clients').catch(() => ({ clients: [] })),
        api.get<{ projects: any[] }>('/projects').catch(() => ({ projects: [] })),
        api.get<{ users: any[] }>('/users').catch(() => ({ users: [] })),
        api.get<{ taskTypes: any[] }>('/task-types').catch(() => ({ taskTypes: [] })),
      ]);
      setClients(c.clients);
      setProjects(p.projects);
      setUsers(u.users);
      setTaskTypes(t.taskTypes);
    })();
  }, []);

  const timerAction = async (action: 'pause' | 'resume' | 'stop' | 'cancel') => {
    try {
      await api.post(`/entries/${action}`, action === 'stop' ? { enrichGithub: true } : {});
      push(action === 'stop' ? 'Tarea finalizada' : action === 'pause' ? 'Tarea en pausa' : action === 'resume' ? 'Tarea retomada' : 'Tarea descartada', 'success');
      await load();
    } catch (err) {
      push((err as Error).message, 'error');
    }
  };

  const saveManual = async () => {
    setSaving(true);
    try {
      await api.post('/entries', {
        title: manual.title,
        projectId: manual.projectId || null,
        taskTypeId: manual.taskTypeId || null,
        startedAt: new Date(manual.startedAt).toISOString(),
        endedAt: new Date(manual.endedAt).toISOString(),
        description: manual.description || null,
      });
      push('Registro creado', 'success');
      setManualOpen(false);
      setManual({ title: '', projectId: '', taskTypeId: '', startedAt: '', endedAt: '', description: '' });
      await load();
    } catch (err) {
      push((err as Error).message, 'error');
    } finally {
      setSaving(false);
    }
  };

  /** Anula el registro: se conserva y se puede restaurar; deja de contar horas. */
  const cancelEntry = async (entry: any) => {
    if (!window.confirm(`¿Anular «${entry.title ?? 'registro'}»?\n\nDejará de contar horas, pero el registro se conserva y puedes restaurarlo.`)) return;
    try {
      await api.delete(`/entries/${entry.id}`);
      push('Registro anulado (se puede restaurar)', 'success');
      await load();
    } catch (err) {
      push((err as Error).message, 'error');
    }
  };

  /** Elimina el registro definitivamente. Solo con permiso entries:delete. */
  const deleteEntry = async () => {
    if (!toDelete) return;
    setDeleting(true);
    try {
      await api.delete(`/entries/${toDelete.id}`, { hard: '1' });
      push('Registro eliminado definitivamente', 'success');
      setToDelete(null);
      await load();
    } catch (err) {
      push((err as Error).message, 'error');
    } finally {
      setDeleting(false);
    }
  };

  /** Deshace una anulación. */
  const restoreEntry = async (entry: any) => {
    try {
      await api.post(`/entries/${entry.id}/restore`);
      push('Registro restaurado', 'success');
      await load();
    } catch (err) {
      push((err as Error).message, 'error');
    }
  };

  const entries = data?.entries ?? [];
  const activeElapsed = active ? active.liveSeconds + (active.status === 'RUNNING' ? tick % 100000 : 0) : 0;

  return (
    <div className="stack">
      <div className="row-between">
        <div>
          <h1>Registros de tiempo</h1>
          <p className="page-sub">
            {data ? `${data.total} registro(s) · ${formatHours(data.totals.hours)} en el periodo` : 'Cargando…'}
          </p>
        </div>
        <div className="btn-row">
          <button className="btn btn-sm" onClick={() => void downloadFile('/reports/export.csv', 'tiempos.csv', { preset })}>
            ⬇ CSV
          </button>
          <button className="btn btn-primary btn-sm" onClick={() => setManualOpen(true)}>
            ＋ Registro manual
          </button>
          {!canDelete ? (
            <span className="tiny muted-2" title="Solo los administradores pueden anular o eliminar registros">
              🔒 anular/eliminar: solo admin
            </span>
          ) : null}
        </div>
      </div>

      {active ? (
        <Card style={{ borderColor: active.status === 'RUNNING' ? 'rgba(34,197,94,0.45)' : 'rgba(245,158,11,0.45)' }}>
          <div className="row-between">
            <div className="stack-sm" style={{ gap: 4 }}>
              <div className="row">
                <Badge kind={active.status === 'RUNNING' ? 'badge-success' : 'badge-warning'}>
                  <span className={`pill-dot ${active.status === 'RUNNING' ? 'pulse' : ''}`} />
                  {STATUS_LABEL[active.status]}
                </Badge>
                <strong>{active.title ?? 'Tarea'}</strong>
              </div>
              <span className="small muted">
                {active.projectName ?? 'sin proyecto'}
                {active.clientName ? ` · ${active.clientName}` : ''}
                {active.taskTypeName ? ` · ${active.taskTypeName}` : ''} · inicio {formatTime(active.startedAt)}
              </span>
            </div>
            <div className="row">
              <span className="mono" style={{ fontSize: '1.6rem' }}>{formatSeconds(activeElapsed)}</span>
              <div className="btn-row">
                {active.status === 'RUNNING' ? (
                  <button className="btn btn-sm btn-warn" onClick={() => void timerAction('pause')}>
                    ⏸ Pausar
                  </button>
                ) : (
                  <button className="btn btn-sm btn-success" onClick={() => void timerAction('resume')}>
                    ▶ Reanudar
                  </button>
                )}
                <button className="btn btn-sm" onClick={() => void timerAction('stop')}>
                  ⏹ Finalizar
                </button>
                <button className="btn btn-sm btn-ghost" onClick={() => void timerAction('cancel')}>
                  Descartar
                </button>
              </div>
            </div>
          </div>
        </Card>
      ) : null}

      <Card>
        <div className="row" style={{ marginBottom: 14 }}>
          <RangeSelect value={preset} onChange={setPreset} options={RANGE_OPTIONS} />
          <input className="input" style={{ maxWidth: 220 }} placeholder="Buscar en título/descripción…" value={search} onChange={(e) => setSearch(e.target.value)} />
          <select className="select" style={{ width: 'auto' }} value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">Todos los estados</option>
            {Object.entries(STATUS_LABEL).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
          <select className="select" style={{ width: 'auto' }} value={clientId} onChange={(e) => setClientId(e.target.value)}>
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
            onChange={(e) => setProjectId(e.target.value)}
          >
            <option value="">Todos los proyectos</option>
            {projects
              .filter((p) => !clientId || p.clientId === clientId)
              .map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
          </select>
          {users.length > 1 ? (
            <select className="select" style={{ width: 'auto' }} value={userId} onChange={(e) => setUserId(e.target.value)}>
              <option value="">Todas las personas</option>
              {users.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.fullName}
                </option>
              ))}
            </select>
          ) : null}
        </div>

        {loading ? (
          <Spinner />
        ) : entries.length === 0 ? (
          <Empty>No hay registros con estos filtros.</Empty>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Inicio</th>
                  <th>Tarea</th>
                  <th>Cliente / Proyecto</th>
                  <th>Tipo</th>
                  <th>Origen</th>
                  <th className="right">Duración</th>
                  <th>Estado</th>
                  <th className="right"></th>
                </tr>
              </thead>
              <tbody>
                {entries.map((e: any) => (
                  <tr key={e.id}>
                    <td className="nowrap small">
                      {formatDateTime(e.startedAt)}
                      <br />
                      <span className="tiny muted-2">→ {e.endedAt ? formatTime(e.endedAt) : 'en curso'}</span>
                    </td>
                    <td>
                      <div className="stack-sm" style={{ gap: 1, maxWidth: 320 }}>
                        <strong>{e.title ?? 'Sin título'}</strong>
                        {e.description ? <span className="tiny muted-2">{e.description.slice(0, 90)}</span> : null}
                        <span className="tiny muted-2">{e.userName}</span>
                      </div>
                    </td>
                    <td className="small">
                      {e.projectName ?? API_SAFE}
                      <br />
                      <span className="tiny muted-2">{e.clientName ?? '—'}</span>
                    </td>
                    <td className="small muted">{e.taskTypeName ?? '—'}</td>
                    <td className="small muted nowrap">{SOURCE_LABEL[e.source] ?? e.source}</td>
                    <td className="right mono nowrap">
                      {formatSeconds(e.liveSeconds)}
                      <br />
                      <span className="tiny muted-2">{formatHours(e.liveSeconds / 3600)}</span>
                    </td>
                    <td>
                      <Badge kind={STATUS_BADGE[e.status]}>{STATUS_LABEL[e.status]}</Badge>
                      {!e.billable ? <div className="tiny muted-2">no facturable</div> : null}
                    </td>
                    <td>
                      <div className="td-actions">
                        {e.status === 'CANCELLED' ? (
                          canDelete ? (
                            <button
                              className="btn btn-sm"
                              onClick={() => void restoreEntry(e)}
                              title="Restaurar este registro anulado"
                            >
                              ↩ Restaurar
                            </button>
                          ) : (
                            <span className="tiny muted-2">anulado</span>
                          )
                        ) : canDelete ? (
                          <>
                            <button
                              className="btn btn-sm"
                              onClick={() => void cancelEntry(e)}
                              title="Anular: deja de contar horas pero se conserva"
                            >
                              Anular
                            </button>
                            <button
                              className="btn btn-sm btn-danger"
                              onClick={() => setToDelete(e)}
                              title="Eliminar definitivamente"
                            >
                              🗑 Eliminar
                            </button>
                          </>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {toDelete ? (
        <Modal
          title="Eliminar registro definitivamente"
          onClose={() => setToDelete(null)}
          footer={
            <>
              <button className="btn btn-ghost" onClick={() => setToDelete(null)} disabled={deleting}>
                Cancelar
              </button>
              <button className="btn btn-danger" onClick={() => void deleteEntry()} disabled={deleting}>
                {deleting ? 'Eliminando…' : 'Sí, eliminar definitivamente'}
              </button>
            </>
          }
        >
          <Alert kind="error">
            <b>Esta acción no se puede deshacer.</b> El registro y sus pausas se borran de la base de datos, y las horas
            desaparecen de los reportes.
          </Alert>

          <div className="card" style={{ padding: 14 }}>
            <div className="stack-sm" style={{ gap: 4 }}>
              <strong>{toDelete.title ?? 'Sin título'}</strong>
              <span className="small muted">
                {toDelete.userName} · {toDelete.projectName ?? 'sin proyecto'}
                {toDelete.clientName ? ` · ${toDelete.clientName}` : ''}
              </span>
              <span className="small muted">
                {formatDateTime(toDelete.startedAt)} → {toDelete.endedAt ? formatTime(toDelete.endedAt) : 'en curso'} ·{' '}
                <b>{formatSeconds(toDelete.liveSeconds)}</b>
              </span>
              <Badge kind={STATUS_BADGE[toDelete.status]}>{STATUS_LABEL[toDelete.status]}</Badge>
            </div>
          </div>

          <p className="tiny muted-2">
            Si solo quieres que deje de contar horas pero conservar el rastro, cierra esta ventana y usa <b>Anular</b>:
            podrás restaurarlo después.
          </p>
        </Modal>
      ) : null}

      {manualOpen ? (
        <Modal
          title="Registro manual de tiempo"
          onClose={() => setManualOpen(false)}
          footer={
            <>
              <button className="btn btn-ghost" onClick={() => setManualOpen(false)}>
                Cancelar
              </button>
              <button className="btn btn-primary" onClick={() => void saveManual()} disabled={saving || !manual.title}>
                {saving ? 'Guardando…' : 'Guardar'}
              </button>
            </>
          }
        >
          <div className="form-grid">
            <Field label="Título de la tarea">
              <input className="input" value={manual.title} onChange={(e) => setManual({ ...manual, title: e.target.value })} placeholder="Corrección de login" />
            </Field>
            <Field label="Proyecto">
              <select className="select" value={manual.projectId} onChange={(e) => setManual({ ...manual, projectId: e.target.value })}>
                <option value="">Sin proyecto</option>
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} · {p.clientName}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Tipo de tarea">
              <select className="select" value={manual.taskTypeId} onChange={(e) => setManual({ ...manual, taskTypeId: e.target.value })}>
                <option value="">Sin tipo</option>
                {taskTypes.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Inicio">
              <input className="input" type="datetime-local" value={manual.startedAt} onChange={(e) => setManual({ ...manual, startedAt: e.target.value })} />
            </Field>
            <Field label="Fin">
              <input className="input" type="datetime-local" value={manual.endedAt} onChange={(e) => setManual({ ...manual, endedAt: e.target.value })} />
            </Field>
          </div>
          <Field label="Detalle">
            <textarea className="textarea" value={manual.description} onChange={(e) => setManual({ ...manual, description: e.target.value })} />
          </Field>
        </Modal>
      ) : null}
    </div>
  );
}
