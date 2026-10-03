import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api';
import { PRIORITY_LABEL, formatDate } from '../lib/format';
import { Badge, Card, Empty, Field, Modal, Spinner, useToast } from '../components/ui';

/**
 * Tareas pendientes del usuario: alimentan la alerta diaria que envía el bot.
 */
export default function PendingPage() {
  const { push } = useToast();
  const [tasks, setTasks] = useState<any[]>([]);
  const [projects, setProjects] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [showDone, setShowDone] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [form, setForm] = useState({ title: '', notes: '', projectId: '', priority: 'NORMAL', dueDate: '' });
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [res, proj] = await Promise.all([
        api.get<{ tasks: any[] }>('/pending-tasks', { includeDone: showDone ? 'true' : 'false' }),
        api.get<{ projects: any[] }>('/projects', { isActive: 'true' }).catch(() => ({ projects: [] })),
      ]);
      setTasks(res.tasks);
      setProjects(proj.projects);
    } catch (err) {
      push((err as Error).message, 'error');
    } finally {
      setLoading(false);
    }
  }, [showDone, push]);

  useEffect(() => {
    void load();
  }, [load]);

  const create = async () => {
    setSaving(true);
    try {
      await api.post('/pending-tasks', {
        title: form.title,
        notes: form.notes || null,
        projectId: form.projectId || null,
        priority: form.priority,
        dueDate: form.dueDate ? new Date(form.dueDate).toISOString() : null,
      });
      push('Tarea pendiente creada', 'success');
      setModalOpen(false);
      setForm({ title: '', notes: '', projectId: '', priority: 'NORMAL', dueDate: '' });
      await load();
    } catch (err) {
      push((err as Error).message, 'error');
    } finally {
      setSaving(false);
    }
  };

  const toggleDone = async (task: any) => {
    try {
      await api.patch(`/pending-tasks/${task.id}`, { isDone: !task.isDone });
      await load();
    } catch (err) {
      push((err as Error).message, 'error');
    }
  };

  const remove = async (task: any) => {
    if (!window.confirm(`¿Eliminar "${task.title}"?`)) return;
    try {
      await api.delete(`/pending-tasks/${task.id}`);
      await load();
    } catch (err) {
      push((err as Error).message, 'error');
    }
  };

  const pending = tasks.filter((t) => !t.isDone);
  const done = tasks.filter((t) => t.isDone);

  return (
    <div className="stack">
      <div className="row-between">
        <div>
          <h1>Mis pendientes</h1>
          <p className="page-sub">
            {pending.length} tarea(s) abierta(s). El bot te enviará la lista cada mañana si activaste el resumen diario.
          </p>
        </div>
        <div className="btn-row">
          <label className="checkbox">
            <input type="checkbox" checked={showDone} onChange={(e) => setShowDone(e.target.checked)} />
            Mostrar completadas
          </label>
          <button className="btn btn-primary" onClick={() => setModalOpen(true)}>
            ＋ Nueva tarea
          </button>
        </div>
      </div>

      {loading ? (
        <Spinner />
      ) : (
        <Card>
          {tasks.length === 0 ? (
            <Empty>No tienes tareas pendientes. Añade una para que aparezca en tu resumen diario del bot.</Empty>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th style={{ width: 40 }}></th>
                    <th>Tarea</th>
                    <th>Proyecto</th>
                    <th>Prioridad</th>
                    <th>Vence</th>
                    <th className="right"></th>
                  </tr>
                </thead>
                <tbody>
                  {[...pending, ...done].map((t) => (
                    <tr key={t.id} style={t.isDone ? { opacity: 0.55 } : undefined}>
                      <td>
                        <input type="checkbox" checked={t.isDone} onChange={() => void toggleDone(t)} />
                      </td>
                      <td>
                        <div className="stack-sm" style={{ gap: 1 }}>
                          <span style={t.isDone ? { textDecoration: 'line-through' } : undefined}>{t.title}</span>
                          {t.notes ? <span className="tiny muted-2">{t.notes.slice(0, 90)}</span> : null}
                        </div>
                      </td>
                      <td className="small muted">{projects.find((p) => p.id === t.projectId)?.name ?? '—'}</td>
                      <td>
                        <Badge kind={t.priority === 'HIGH' ? 'badge-danger' : t.priority === 'LOW' ? 'badge-success' : 'badge-warning'}>
                          {PRIORITY_LABEL[t.priority] ?? t.priority}
                        </Badge>
                      </td>
                      <td className="small muted nowrap">{t.dueDate ? formatDate(t.dueDate) : '—'}</td>
                      <td>
                        <div className="td-actions">
                          <button className="btn btn-sm btn-ghost" onClick={() => void remove(t)}>
                            🗑
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}

      {modalOpen ? (
        <Modal
          title="Nueva tarea pendiente"
          onClose={() => setModalOpen(false)}
          footer={
            <>
              <button className="btn btn-ghost" onClick={() => setModalOpen(false)}>
                Cancelar
              </button>
              <button className="btn btn-primary" onClick={() => void create()} disabled={saving || !form.title}>
                {saving ? 'Guardando…' : 'Guardar'}
              </button>
            </>
          }
        >
          <Field label="Título">
            <input className="input" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="Revisar PR del módulo de pagos" />
          </Field>
          <div className="form-grid">
            <Field label="Proyecto">
              <select className="select" value={form.projectId} onChange={(e) => setForm({ ...form, projectId: e.target.value })}>
                <option value="">Sin proyecto</option>
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
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
          <Field label="Notas">
            <textarea className="textarea" value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
          </Field>
        </Modal>
      ) : null}
    </div>
  );
}
