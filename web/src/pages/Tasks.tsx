import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { formatDateTime, formatHours, formatSeconds } from '../lib/format';
import { Alert, Badge, Card, Empty, Field, Modal, Spinner, StatCard, useToast } from '../components/ui';

/**
 * TAREAS
 *
 * Una tarea es la unidad de trabajo y puede acumular VARIOS registros de tiempo:
 * cada vez que se retoma se abre un tramo nuevo. Aquí se ve el acumulado por
 * tarea y se puede abrir el detalle con todos sus tramos.
 */

const STATUS_KIND: Record<string, string> = {
  OPEN: 'badge',
  IN_PROGRESS: 'badge badge-success',
  DONE: 'badge badge-primary',
  CANCELLED: 'badge badge-danger',
};

const PRIORITY_LABEL: Record<string, string> = { HIGH: 'Alta', NORMAL: 'Normal', LOW: 'Baja' };

interface TaskRow {
  id: string;
  title: string;
  status: string;
  statusLabel: string;
  projectName: string | null;
  clientName: string | null;
  taskTypeName: string | null;
  assigneeName: string | null;
  totalSeconds: number;
  entryCount: number;
  firstWorkedAt: string | null;
  lastWorkedAt: string | null;
  estimatedHours: number | null;
  priority: string;
  dueDate: string | null;
}

export default function TasksPage() {
  const { can } = useAuth();
  const { push } = useToast();

  const [tasks, setTasks] = useState<TaskRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [scope, setScope] = useState<'mine' | 'all'>('mine');

  const [projects, setProjects] = useState<any[]>([]);
  const [users, setUsers] = useState<any[]>([]);
  const [taskTypes, setTaskTypes] = useState<any[]>([]);

  const [detail, setDetail] = useState<{ task: any; entries: any[] } | null>(null);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({
    title: '',
    projectId: '',
    taskTypeId: '',
    assigneeId: '',
    description: '',
    estimatedHours: '',
    priority: 'NORMAL',
    dueDate: '',
  });
  const [saving, setSaving] = useState(false);

  const canWrite = can('entries:write');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get<{ tasks: TaskRow[]; total: number }>('/tasks', {
        search: search || undefined,
        status: status || undefined,
        scope,
        take: 200,
      });
      setTasks(res.tasks);
      setTotal(res.total);
    } catch (err) {
      push((err as Error).message, 'error');
    } finally {
      setLoading(false);
    }
  }, [search, status, scope, push]);

  useEffect(() => {
    const t = setTimeout(() => void load(), 250);
    return () => clearTimeout(t);
  }, [load]);

  useEffect(() => {
    void (async () => {
      const [p, u, tt] = await Promise.all([
        api.get<{ projects: any[] }>('/projects').catch(() => ({ projects: [] })),
        api.get<{ users: any[] }>('/users').catch(() => ({ users: [] })),
        api.get<{ taskTypes: any[] }>('/task-types').catch(() => ({ taskTypes: [] })),
      ]);
      setProjects(p.projects);
      setUsers(u.users);
      setTaskTypes(tt.taskTypes);
    })();
  }, []);

  const openDetail = async (task: TaskRow) => {
    try {
      const res = await api.get<{ task: any; entries: any[] }>(`/tasks/${task.id}`);
      setDetail(res);
    } catch (err) {
      push((err as Error).message, 'error');
    }
  };

  const changeStatus = async (task: TaskRow, next: string) => {
    try {
      await api.patch(`/tasks/${task.id}`, { status: next });
      push('Tarea actualizada', 'success');
      await load();
    } catch (err) {
      push((err as Error).message, 'error');
    }
  };

  const create = async () => {
    setSaving(true);
    try {
      await api.post('/tasks', {
        title: form.title,
        projectId: form.projectId || null,
        taskTypeId: form.taskTypeId || null,
        assigneeId: form.assigneeId || null,
        description: form.description || null,
        estimatedHours: form.estimatedHours ? Number(form.estimatedHours) : null,
        priority: form.priority,
        dueDate: form.dueDate ? new Date(form.dueDate).toISOString() : null,
      });
      push('Tarea creada', 'success');
      setCreating(false);
      setForm({ title: '', projectId: '', taskTypeId: '', assigneeId: '', description: '', estimatedHours: '', priority: 'NORMAL', dueDate: '' });
      await load();
    } catch (err) {
      push((err as Error).message, 'error');
    } finally {
      setSaving(false);
    }
  };

  const totalSeconds = tasks.reduce((acc, t) => acc + t.totalSeconds, 0);
  const abiertas = tasks.filter((t) => t.status === 'IN_PROGRESS' || t.status === 'OPEN').length;
  const multiTramo = tasks.filter((t) => t.entryCount > 1).length;

  return (
    <div className="stack">
      <div className="row-between">
        <div>
          <h1>Tareas</h1>
          <p className="page-sub">
            Una tarea puede tener varios registros de tiempo: aquí ves el acumulado de cada una.
          </p>
        </div>
        <div className="row">
          {canWrite ? (
            <button className="btn btn-primary" onClick={() => setCreating(true)}>
              ＋ Nueva tarea
            </button>
          ) : null}
        </div>
      </div>

      <div className="grid grid-3">
        <StatCard label="Tareas" value={total} sub={`${abiertas} abiertas o en curso`} icon="🗂" accent="#818cf8" />
        <StatCard label="Tiempo acumulado" value={formatHours(totalSeconds / 3600)} sub="suma de todos los tramos listados" icon="⏱" />
        <StatCard label="Con varios tramos" value={multiTramo} sub="tareas retomadas más de una vez" icon="🔁" accent="#22d3ee" />
      </div>

      <Card>
        <div className="row" style={{ marginBottom: 14 }}>
          <input
            className="input"
            style={{ maxWidth: 280 }}
            placeholder="Buscar tarea…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <select className="select" style={{ width: 'auto' }} value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">Todos los estados</option>
            <option value="OPEN">Pendientes</option>
            <option value="IN_PROGRESS">En curso</option>
            <option value="DONE">Completadas</option>
            <option value="CANCELLED">Canceladas</option>
          </select>
          <select className="select" style={{ width: 'auto' }} value={scope} onChange={(e) => setScope(e.target.value as 'mine' | 'all')}>
            <option value="mine">Mis tareas</option>
            <option value="all">Todas las que puedo ver</option>
          </select>
          <span className="tiny muted-2">{tasks.length} de {total}</span>
        </div>

        {loading ? (
          <Spinner />
        ) : tasks.length === 0 ? (
          <Empty>
            No hay tareas con estos filtros. Las tareas se crean solas cuando alguien dicta o escribe en qué trabaja, o
            manualmente con «Nueva tarea».
          </Empty>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Tarea</th>
                  <th>Proyecto / Cliente</th>
                  <th>Responsable</th>
                  <th className="right">Tramos</th>
                  <th className="right">Tiempo</th>
                  <th>Estado</th>
                  <th className="right"></th>
                </tr>
              </thead>
              <tbody>
                {tasks.map((t) => (
                  <tr key={t.id}>
                    <td>
                      <div className="stack-sm" style={{ gap: 2, maxWidth: 320 }}>
                        <strong>{t.title}</strong>
                        <span className="tiny muted-2">
                          {t.taskTypeName ?? 'sin tipo'}
                          {t.priority !== 'NORMAL' ? ` · prioridad ${PRIORITY_LABEL[t.priority] ?? t.priority}` : ''}
                          {t.estimatedHours ? ` · estimado ${t.estimatedHours} h` : ''}
                        </span>
                      </div>
                    </td>
                    <td className="small">
                      {t.projectName ?? '—'}
                      <br />
                      <span className="tiny muted-2">{t.clientName ?? '—'}</span>
                    </td>
                    <td className="small muted">{t.assigneeName ?? '—'}</td>
                    <td className="right">
                      <Badge kind={t.entryCount > 1 ? 'badge-primary' : ''}>{t.entryCount}</Badge>
                    </td>
                    <td className="right mono nowrap">
                      {formatSeconds(t.totalSeconds)}
                      <br />
                      <span className="tiny muted-2">{formatHours(t.totalSeconds / 3600)}</span>
                    </td>
                    <td>
                      <Badge kind={STATUS_KIND[t.status]}>{t.statusLabel}</Badge>
                    </td>
                    <td>
                      <div className="td-actions">
                        <button className="btn btn-sm" onClick={() => void openDetail(t)} title="Ver sus registros de tiempo">
                          Ver tramos
                        </button>
                        {canWrite && t.status !== 'DONE' ? (
                          <button className="btn btn-sm" onClick={() => void changeStatus(t, 'DONE')} title="Marcar como completada">
                            ✓
                          </button>
                        ) : null}
                        {canWrite && t.status === 'DONE' ? (
                          <button className="btn btn-sm" onClick={() => void changeStatus(t, 'OPEN')} title="Reabrir tarea">
                            ↺
                          </button>
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

      {/* Detalle: la tarea y TODOS sus tramos */}
      {detail ? (
        <Modal
          title={detail.task.title}
          onClose={() => setDetail(null)}
          wide
          footer={
            <button className="btn btn-primary" onClick={() => setDetail(null)}>
              Cerrar
            </button>
          }
        >
          <div className="card" style={{ padding: 14 }}>
            <div className="stack-sm" style={{ gap: 4 }}>
              <span className="small">
                {detail.task.projectName ?? 'sin proyecto'} · {detail.task.clientName ?? 'sin cliente'} ·{' '}
                {detail.task.taskTypeName ?? 'sin tipo'}
              </span>
              <span className="small">
                <b>{formatSeconds(detail.task.totalSeconds)}</b> acumulados en{' '}
                <b>{detail.task.entryCount}</b> registro(s) de tiempo
              </span>
              <span className="tiny muted-2">
                Primera vez: {detail.task.firstWorkedAt ? formatDateTime(detail.task.firstWorkedAt) : '—'} · Última:{' '}
                {detail.task.lastWorkedAt ? formatDateTime(detail.task.lastWorkedAt) : '—'}
              </span>
            </div>
          </div>

          {detail.task.description ? (
            <Field label="Detalle de la tarea">
              <div className="small muted">{detail.task.description}</div>
            </Field>
          ) : null}

          <div className="card-title" style={{ marginBottom: 0 }}>
            <h3>Registros de tiempo ({detail.entries.length})</h3>
            <span className="card-hint">Cada fila es un tramo de trabajo de esta tarea</span>
          </div>

          {detail.entries.length ? (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Inicio</th>
                    <th>Fin</th>
                    <th className="right">Duración</th>
                    <th>Estado</th>
                    <th>Origen</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.entries.map((e) => (
                    <tr key={e.id}>
                      <td className="small nowrap">{formatDateTime(e.startedAt)}</td>
                      <td className="small nowrap">{e.endedAt ? formatDateTime(e.endedAt) : '—'}</td>
                      <td className="right mono">{formatSeconds(e.liveSeconds)}</td>
                      <td className="small">{e.status}</td>
                      <td className="small muted">{e.source}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <Alert kind="info">
              Esta tarea todavía no tiene tiempo registrado. Se crea al dictar o escribir la tarea en el bot, o al añadir
              un registro manual en <b>Registros</b>.
            </Alert>
          )}
        </Modal>
      ) : null}

      {creating ? (
        <Modal
          title="Nueva tarea"
          onClose={() => setCreating(false)}
          wide
          footer={
            <>
              <button className="btn btn-ghost" onClick={() => setCreating(false)} disabled={saving}>
                Cancelar
              </button>
              <button className="btn btn-primary" onClick={() => void create()} disabled={saving || form.title.trim().length < 2}>
                {saving ? 'Guardando…' : 'Crear tarea'}
              </button>
            </>
          }
        >
          <Field label="Título de la tarea" hint="Es lo que verás luego al registrar tiempo sobre ella.">
            <input className="input" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="Maquetación del login" />
          </Field>

          <div className="form-grid">
            <Field label="Proyecto">
              <select className="select" value={form.projectId} onChange={(e) => setForm({ ...form, projectId: e.target.value })}>
                <option value="">Sin proyecto</option>
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} · {p.clientName}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Tipo de tarea">
              <select className="select" value={form.taskTypeId} onChange={(e) => setForm({ ...form, taskTypeId: e.target.value })}>
                <option value="">Sin tipo</option>
                {taskTypes.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Responsable">
              <select className="select" value={form.assigneeId} onChange={(e) => setForm({ ...form, assigneeId: e.target.value })}>
                <option value="">Yo</option>
                {users.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.fullName}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Estimación (horas)">
              <input className="input" type="number" min="0" step="0.5" value={form.estimatedHours} onChange={(e) => setForm({ ...form, estimatedHours: e.target.value })} />
            </Field>
            <Field label="Prioridad">
              <select className="select" value={form.priority} onChange={(e) => setForm({ ...form, priority: e.target.value })}>
                <option value="HIGH">Alta</option>
                <option value="NORMAL">Normal</option>
                <option value="LOW">Baja</option>
              </select>
            </Field>
            <Field label="Fecha límite">
              <input className="input" type="date" value={form.dueDate} onChange={(e) => setForm({ ...form, dueDate: e.target.value })} />
            </Field>
          </div>

          <Field label="Descripción">
            <textarea className="textarea" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
          </Field>
        </Modal>
      ) : null}
    </div>
  );
}
