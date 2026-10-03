import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
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
import { TaskPicker, NEW_TASK } from '../components/TaskPicker';

/**
 * Registros de tiempo: historial con filtros, control del cronómetro propio
 * y edición manual de horas (correcciones).
 */
export default function EntriesPage() {
  const { push } = useToast();
  const { can } = useAuth();
  const canDelete = can('entries:delete');
  const canWrite = can('entries:write');
  const [preset, setPreset] = useState('last7');
  const [status, setStatus] = useState('');
  const [search, setSearch] = useState('');
  const [clientId, setClientId] = useState('');
  const [projectId, setProjectId] = useState('');
  const [userId, setUserId] = useState('');
  const [tasks, setTasks] = useState<any[]>([]);
  // El filtro por tarea puede llegar por URL (enlace desde la página de Tareas).
  const [searchParams, setSearchParams] = useSearchParams();
  const [taskId, setTaskId] = useState(searchParams.get('taskId') ?? '');

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
  // Edicion de un registro existente (tarea, proyecto, cliente, tipo, horas...).
  const [toEdit, setToEdit] = useState<any | null>(null);
  const [editForm, setEditForm] = useState({
    title: '',
    description: '',
    projectId: '',
    taskId: '',
    newTaskTitle: '',
    taskTypeId: '',
    startedAt: '',
    endedAt: '',
    billable: true,
    status: 'FINISHED',
  });
  const [savingEdit, setSavingEdit] = useState(false);
  const MANUAL_VACIO = { title: '', projectId: '', taskId: '', newTaskTitle: '', taskTypeId: '', startedAt: '', endedAt: '', description: '' };
  const [manual, setManual] = useState(MANUAL_VACIO);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [entries, activeRes] = await Promise.all([
        api.get<any>('/entries', { preset, status: status || undefined, search: search || undefined, clientId: clientId || undefined, projectId: projectId || undefined, taskId: taskId || undefined, userId: userId || undefined, take: 200 }),
        api.get<{ entry: any }>('/entries/active'),
      ]);
      setData(entries);
      setActive(activeRes.entry);
    } catch (err) {
      push((err as Error).message, 'error');
    } finally {
      setLoading(false);
    }
  }, [preset, status, search, clientId, projectId, taskId, userId, push]);

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
      const [c, p, u, t, tk] = await Promise.all([
        api.get<{ clients: any[] }>('/clients').catch(() => ({ clients: [] })),
        api.get<{ projects: any[] }>('/projects').catch(() => ({ projects: [] })),
        api.get<{ users: any[] }>('/users').catch(() => ({ users: [] })),
        api.get<{ taskTypes: any[] }>('/task-types').catch(() => ({ taskTypes: [] })),
        // `scope: 'all'`: al asignar un registro hay que poder elegir CUALQUIER tarea,
        // no solo las mias (el registro puede ser de otra persona).
        api.get<{ tasks: any[] }>('/tasks', { take: 300, scope: 'all' }).catch(() => ({ tasks: [] })),
      ]);
      setClients(c.clients);
      setProjects(p.projects);
      setUsers(u.users);
      setTaskTypes(t.taskTypes);
      setTasks(tk.tasks);
    })();
  }, []);

  /** Mantiene el filtro de tarea en la URL para poder enlazar a esta vista. */
  /** Tarea del filtro activo (si se llega desde «Tareas» con ?taskId=...). */
  const tareaSeleccionada = taskId ? tasks.find((t: any) => t.id === taskId) : null;

  const changeTaskFilter = (value: string) => {
    setTaskId(value);
    const next = new URLSearchParams(searchParams);
    if (value) next.set('taskId', value);
    else next.delete('taskId');
    setSearchParams(next, { replace: true });
  };

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
        // La tarea manda: si se eligio una existente se envia su id; si se pidio
        // una nueva, el servidor la crea con este titulo (y reutiliza si ya hay
        // una igual en el mismo proyecto).
        ...(manual.taskId && manual.taskId !== NEW_TASK ? { taskId: manual.taskId } : {}),
        ...(manual.taskId === NEW_TASK && manual.newTaskTitle.trim()
          ? { newTaskTitle: manual.newTaskTitle.trim() }
          : {}),
        taskTypeId: manual.taskTypeId || null,
        startedAt: new Date(manual.startedAt).toISOString(),
        endedAt: new Date(manual.endedAt).toISOString(),
        description: manual.description || null,
      });
      push('Registro creado', 'success');
      setManualOpen(false);
      setManual(MANUAL_VACIO);
      await load();
    } catch (err) {
      push((err as Error).message, 'error');
    } finally {
      setSaving(false);
    }
  };

  /** Convierte una fecha ISO al formato que espera <input type="datetime-local">. */
  const toLocalInput = (iso: string | null): string => {
    if (!iso) return '';
    const d = new Date(iso);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };

  /** Abre el editor con los datos actuales del registro. */
  const openEdit = (entry: any) => {
    setEditForm({
      title: entry.title ?? '',
      description: entry.description ?? '',
      projectId: entry.projectId ?? '',
      taskId: entry.taskId ?? '',
      newTaskTitle: '',
      taskTypeId: entry.taskTypeId ?? '',
      startedAt: toLocalInput(entry.startedAt),
      endedAt: toLocalInput(entry.endedAt),
      billable: Boolean(entry.billable),
      status: entry.status,
    });
    setToEdit(entry);
  };

  /**
   * Guarda los cambios. El proyecto manda sobre el cliente: al elegir otro
   * proyecto, el backend reasigna tambien su cliente (asi el registro queda
   * coherente con la jerarquia cliente -> proyecto).
   */
  const saveEdit = async () => {
    if (!toEdit) return;
    setSavingEdit(true);
    try {
      await api.patch(`/entries/${toEdit.id}`, {
        title: editForm.title.trim() || undefined,
        description: editForm.description || null,
        projectId: editForm.projectId || null,
        // Permite mover el registro a otra tarea, crear una nueva o dejarlo sin
        // tarea ('' -> null). El servidor valida que la tarea exista.
        ...(editForm.taskId === NEW_TASK
          ? editForm.newTaskTitle.trim()
            ? { newTaskTitle: editForm.newTaskTitle.trim() }
            : {}
          : { taskId: editForm.taskId || null }),
        taskTypeId: editForm.taskTypeId || null,
        ...(editForm.startedAt ? { startedAt: new Date(editForm.startedAt).toISOString() } : {}),
        ...(editForm.endedAt ? { endedAt: new Date(editForm.endedAt).toISOString() } : {}),
        billable: editForm.billable,
        status: editForm.status,
      });
      push('Registro actualizado', 'success');
      setToEdit(null);
      await load();
    } catch (err) {
      push((err as Error).message, 'error');
    } finally {
      setSavingEdit(false);
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
            {data
              ? `${data.total} registro(s) · ${formatHours(data.totals.hours)} en el periodo · cada registro pertenece a una tarea`
              : 'Cargando…'}
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
          <select className="select" style={{ width: 'auto' }} value={taskId} onChange={(e) => changeTaskFilter(e.target.value)}>
            <option value="">Todas las tareas</option>
            {tasks.map((t) => (
              <option key={t.id} value={t.id}>
                {t.title}
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

        {tareaSeleccionada ? (
          <Alert kind="info">
            <div className="row-between" style={{ alignItems: 'center' }}>
              <span>
                Mostrando los <b>registros de tiempo</b> de la tarea{' '}
                <b>«{tareaSeleccionada.title}»</b>
                {tareaSeleccionada.projectName ? ` (${tareaSeleccionada.projectName})` : ''}:{' '}
                <b>{tareaSeleccionada.entryCount ?? entries.length}</b> registro(s) y{' '}
                <b>{formatSeconds(tareaSeleccionada.totalSeconds ?? 0)}</b> acumulados.
              </span>
              <button className="btn btn-sm" onClick={() => changeTaskFilter('')}>
                Ver todos los registros
              </button>
            </div>
          </Alert>
        ) : null}

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
                  <th>Tarea → registro</th>
                  <th>Proyecto</th>
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
                      {/* Jerarquia: la TAREA es el padre y este registro es uno de
                          sus tramos. Por eso la tarea se muestra arriba y clara. */}
                      <div className="hierarchy" style={{ maxWidth: 340 }}>
                        {e.taskId ? (
                          <span className="hierarchy-parent" title="Tarea a la que pertenece este registro">
                            🗂 {e.taskTitle ?? 'Tarea sin título'}
                          </span>
                        ) : (
                          <span className="tiny" style={{ color: 'var(--warning, #f59e0b)' }} title="Sin tarea: este tiempo no suma al acumulado de ninguna tarea">
                            ⚠ Sin tarea · no suma a ninguna tarea
                          </span>
                        )}
                        <span className="hierarchy-child">↳ {e.title ?? 'Registro sin título'}</span>
                        {e.description ? <span className="tiny muted-2">{e.description.slice(0, 80)}</span> : null}
                        <span className="tiny muted-2">{e.userName} · {formatTime(e.startedAt)}–{e.endedAt ? formatTime(e.endedAt) : '…'}</span>
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
                        ) : (
                          <>
                            {canWrite ? (
                              <button className="btn btn-sm" onClick={() => openEdit(e)} title="Editar tarea, proyecto, cliente, horas y tipo">
                                ✏️ Editar
                              </button>
                            ) : null}
                            {canDelete ? (
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
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {toEdit ? (
        <Modal
          title="Editar registro de tiempo"
          onClose={() => setToEdit(null)}
          wide
          footer={
            <>
              <button className="btn btn-ghost" onClick={() => setToEdit(null)} disabled={savingEdit}>
                Cancelar
              </button>
              <button className="btn btn-primary" onClick={() => void saveEdit()} disabled={savingEdit}>
                {savingEdit ? 'Guardando…' : 'Guardar cambios'}
              </button>
            </>
          }
        >
          <div className="card" style={{ padding: 12 }}>
            <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
              <span className="tiny muted-2">
                {toEdit.userName} · {SOURCE_LABEL[toEdit.source] ?? toEdit.source} ·{' '}
                {formatDateTime(toEdit.startedAt)}
              </span>
              <Badge kind={STATUS_BADGE[toEdit.status]}>{STATUS_LABEL[toEdit.status]}</Badge>
              <span className="tiny muted-2">
                duración actual: <b>{formatSeconds(toEdit.liveSeconds)}</b>
              </span>
            </div>
          </div>

          <Field label="Título del registro" hint="Qué se hizo en este tramo. Aparece en el historial.">
            <input
              className="input"
              value={editForm.title}
              onChange={(e) => setEditForm({ ...editForm, title: e.target.value })}
              placeholder="Maquetación del login"
            />
          </Field>

          <TaskPicker
            tasks={tasks}
            value={editForm.taskId}
            newTitle={editForm.newTaskTitle}
            projectId={editForm.projectId}
            onChange={(v) => setEditForm({ ...editForm, taskId: v })}
            onNewTitleChange={(t) => setEditForm({ ...editForm, newTaskTitle: t })}
            hint="Mueve este registro a otra tarea, créale una nueva o déjalo sin tarea. El tiempo se acumula en la tarea."
          />

          <div className="form-grid">
            <Field label="Cliente / Proyecto" hint="Al cambiar el proyecto se ajusta también el cliente del registro.">
              <select
                className="select"
                value={editForm.projectId}
                onChange={(e) => setEditForm({ ...editForm, projectId: e.target.value })}
              >
                <option value="">Sin proyecto</option>
                {clients.map((c) => {
                  const delCliente = projects.filter((p) => p.clientId === c.id);
                  if (!delCliente.length) return null;
                  return (
                    <optgroup key={c.id} label={c.name}>
                      {delCliente.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                        </option>
                      ))}
                    </optgroup>
                  );
                })}
                {projects
                  .filter((p) => !clients.some((c) => c.id === p.clientId))
                  .map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
              </select>
            </Field>

            <Field label="Tipo de tarea">
              <select
                className="select"
                value={editForm.taskTypeId}
                onChange={(e) => setEditForm({ ...editForm, taskTypeId: e.target.value })}
              >
                <option value="">Sin tipo</option>
                {taskTypes.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
            </Field>

            <Field label="Inicio">
              <input
                className="input"
                type="datetime-local"
                value={editForm.startedAt}
                onChange={(e) => setEditForm({ ...editForm, startedAt: e.target.value })}
              />
            </Field>

            <Field label="Fin" hint="Determina la duración. Vacío = en curso.">
              <input
                className="input"
                type="datetime-local"
                value={editForm.endedAt}
                onChange={(e) => setEditForm({ ...editForm, endedAt: e.target.value })}
              />
            </Field>

            <Field label="Estado">
              <select
                className="select"
                value={editForm.status}
                onChange={(e) => setEditForm({ ...editForm, status: e.target.value })}
              >
                {Object.entries(STATUS_LABEL).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </select>
            </Field>

            <Field label="Facturable">
              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={editForm.billable}
                  onChange={(e) => setEditForm({ ...editForm, billable: e.target.checked })}
                />
                Cuenta como facturable
              </label>
            </Field>
          </div>

          <Field label="Detalle de lo realizado">
            <textarea
              className="textarea"
              value={editForm.description}
              onChange={(e) => setEditForm({ ...editForm, description: e.target.value })}
              placeholder="Qué se hizo, cambios, hallazgos…"
            />
          </Field>

          <Alert kind="info">
            La <b>duración</b> se recalcula al guardar a partir de inicio y fin (las pausas se descuentan). Un registro con
             estado <b>en curso</b> no tiene fin: se le pone uno al finalizarlo.
          </Alert>
        </Modal>
      ) : null}

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
          <Alert kind="info">
            Un registro de tiempo pertenece a una <b>tarea</b>: el tiempo de todos sus registros se acumula en ella. Si
            no eliges ninguna, se busca (o crea) una tarea con el título del registro dentro del proyecto.
          </Alert>

          <div className="form-grid">
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

          <TaskPicker
            tasks={tasks}
            value={manual.taskId}
            newTitle={manual.newTaskTitle}
            projectId={manual.projectId}
            onChange={(v) => setManual({ ...manual, taskId: v })}
            onNewTitleChange={(t) => setManual({ ...manual, newTaskTitle: t })}
          />

          <Field label="Título del registro" hint="Qué hiciste en este tramo. Es el texto que verás en el historial.">
            <input className="input" value={manual.title} onChange={(e) => setManual({ ...manual, title: e.target.value })} placeholder="Corrección de login" />
          </Field>
          <Field label="Detalle">
            <textarea className="textarea" value={manual.description} onChange={(e) => setManual({ ...manual, description: e.target.value })} />
          </Field>
        </Modal>
      ) : null}
    </div>
  );
}
