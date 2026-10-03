import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { formatHours } from '../lib/format';
import { Badge, Card, Empty, Field, Modal, Spinner, useToast } from '../components/ui';

/* =========================================================================
   Catálogo: clientes, proyectos y tipos de tarea globales.
   ========================================================================= */

// ------------------------------------------------------------------ Clientes
export function ClientsPage() {
  const { can } = useAuth();
  const { push } = useToast();
  const [clients, setClients] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [modal, setModal] = useState<{ open: boolean; editing: any | null }>({ open: false, editing: null });
  const [form, setForm] = useState({ name: '', code: '', notes: '', isActive: true });
  const [saving, setSaving] = useState(false);

  const canWrite = can('clients:write');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get<{ clients: any[] }>('/clients', { search: search || undefined, withStats: 'true' });
      setClients(res.clients);
    } catch (err) {
      push((err as Error).message, 'error');
    } finally {
      setLoading(false);
    }
  }, [search, push]);

  useEffect(() => {
    const t = setTimeout(() => void load(), 250);
    return () => clearTimeout(t);
  }, [load]);

  const save = async () => {
    setSaving(true);
    try {
      const payload = { name: form.name, code: form.code || null, notes: form.notes || null, isActive: form.isActive };
      if (modal.editing) await api.patch(`/clients/${modal.editing.id}`, payload);
      else await api.post('/clients', payload);
      push(modal.editing ? 'Cliente actualizado' : 'Cliente creado', 'success');
      setModal({ open: false, editing: null });
      await load();
    } catch (err) {
      push((err as Error).message, 'error');
    } finally {
      setSaving(false);
    }
  };

  const toggle = async (client: any) => {
    try {
      if (client.isActive) {
        if (!window.confirm(`¿Desactivar el cliente ${client.name}? Sus proyectos dejarán de aparecer en el bot.`)) return;
        await api.delete(`/clients/${client.id}`);
      } else {
        await api.patch(`/clients/${client.id}`, { isActive: true });
      }
      await load();
    } catch (err) {
      push((err as Error).message, 'error');
    }
  };

  return (
    <div className="stack">
      <div className="row-between">
        <div>
          <h1>Clientes</h1>
          <p className="page-sub">Cada cliente agrupa uno o varios proyectos facturables.</p>
        </div>
        {canWrite ? (
          <button
            className="btn btn-primary"
            onClick={() => {
              setForm({ name: '', code: '', notes: '', isActive: true });
              setModal({ open: true, editing: null });
            }}
          >
            ＋ Nuevo cliente
          </button>
        ) : null}
      </div>

      <Card>
        <input
          className="input"
          style={{ maxWidth: 320, marginBottom: 14 }}
          placeholder="Buscar cliente…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        {loading ? (
          <Spinner />
        ) : clients.length === 0 ? (
          <Empty>Sin clientes. Crea el primero para poder registrar tiempo.</Empty>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Cliente</th>
                  <th>Código</th>
                  <th className="right">Proyectos</th>
                  <th className="right">Horas (30 días)</th>
                  <th>Estado</th>
                  {canWrite ? <th className="right">Acciones</th> : null}
                </tr>
              </thead>
              <tbody>
                {clients.map((c) => (
                  <tr key={c.id}>
                    <td>
                      <strong>{c.name}</strong>
                      {c.notes ? <div className="tiny muted-2">{c.notes.slice(0, 80)}</div> : null}
                    </td>
                    <td className="mono small muted">{c.code ?? '—'}</td>
                    <td className="right">{c.projectsCount}</td>
                    <td className="right mono">{formatHours(c.hours30d)}</td>
                    <td>{c.isActive ? <Badge kind="badge-success">Activo</Badge> : <Badge kind="badge-danger">Inactivo</Badge>}</td>
                    {canWrite ? (
                      <td>
                        <div className="td-actions">
                          <button
                            className="btn btn-sm"
                            onClick={() => {
                              setForm({ name: c.name, code: c.code ?? '', notes: c.notes ?? '', isActive: c.isActive });
                              setModal({ open: true, editing: c });
                            }}
                          >
                            Editar
                          </button>
                          <button className="btn btn-sm" onClick={() => void toggle(c)}>
                            {c.isActive ? 'Desactivar' : 'Activar'}
                          </button>
                        </div>
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {modal.open ? (
        <Modal
          title={modal.editing ? `Editar ${modal.editing.name}` : 'Nuevo cliente'}
          onClose={() => setModal({ open: false, editing: null })}
          footer={
            <>
              <button className="btn btn-ghost" onClick={() => setModal({ open: false, editing: null })}>
                Cancelar
              </button>
              <button className="btn btn-primary" onClick={() => void save()} disabled={saving || !form.name}>
                {saving ? 'Guardando…' : 'Guardar'}
              </button>
            </>
          }
        >
          <div className="form-grid">
            <Field label="Nombre del cliente">
              <input className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Acme Corp" />
            </Field>
            <Field label="Código corto" hint="Opcional. Ayuda al bot a reconocerlo por voz.">
              <input className="input" value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} placeholder="ACME" />
            </Field>
          </div>
          <Field label="Notas">
            <textarea className="textarea" value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
          </Field>
          <label className="checkbox">
            <input type="checkbox" checked={form.isActive} onChange={(e) => setForm({ ...form, isActive: e.target.checked })} />
            Cliente activo
          </label>
        </Modal>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------- Proyectos
export function ProjectsPage() {
  const { can } = useAuth();
  const { push } = useToast();
  const [projects, setProjects] = useState<any[]>([]);
  const [clients, setClients] = useState<any[]>([]);
  const [users, setUsers] = useState<any[]>([]);
  const [taskTypes, setTaskTypes] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [clientFilter, setClientFilter] = useState('');
  const [modal, setModal] = useState<{ open: boolean; editing: any | null }>({ open: false, editing: null });
  const [typeModal, setTypeModal] = useState(false);
  const [typeForm, setTypeForm] = useState({ name: '', aliases: '', color: '#6366f1' });
  const [form, setForm] = useState({
    clientId: '',
    name: '',
    description: '',
    githubRepos: '',
    budgetHours: '',
    hourlyRate: '',
    memberIds: [] as string[],
    isActive: true,
  });
  const [saving, setSaving] = useState(false);

  const canWrite = can('projects:write');
  const canTypes = can('tasktypes:write');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [p, c, u, t] = await Promise.all([
        api.get<{ projects: any[] }>('/projects', { clientId: clientFilter || undefined }),
        api.get<{ clients: any[] }>('/clients'),
        api.get<{ users: any[] }>('/users').catch(() => ({ users: [] })),
        api.get<{ taskTypes: any[] }>('/task-types').catch(() => ({ taskTypes: [] })),
      ]);
      setProjects(p.projects);
      setClients(c.clients);
      setUsers(u.users);
      setTaskTypes(t.taskTypes);
    } catch (err) {
      push((err as Error).message, 'error');
    } finally {
      setLoading(false);
    }
  }, [clientFilter, push]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async () => {
    setSaving(true);
    try {
      const payload = {
        clientId: form.clientId,
        name: form.name,
        description: form.description || null,
        githubRepos: form.githubRepos || null,
        budgetHours: form.budgetHours ? Number(form.budgetHours) : null,
        hourlyRate: form.hourlyRate ? Number(form.hourlyRate) : null,
        memberIds: form.memberIds,
        isActive: form.isActive,
      };
      if (modal.editing) await api.patch(`/projects/${modal.editing.id}`, payload);
      else await api.post('/projects', payload);
      push(modal.editing ? 'Proyecto actualizado' : 'Proyecto creado', 'success');
      setModal({ open: false, editing: null });
      await load();
    } catch (err) {
      push((err as Error).message, 'error');
    } finally {
      setSaving(false);
    }
  };

  const toggle = async (p: any) => {
    try {
      if (p.isActive) {
        if (!window.confirm(`¿Desactivar el proyecto ${p.name}?`)) return;
        await api.delete(`/projects/${p.id}`);
      } else {
        await api.patch(`/projects/${p.id}`, { isActive: true });
      }
      await load();
    } catch (err) {
      push((err as Error).message, 'error');
    }
  };

  return (
    <div className="stack">
      <div className="row-between">
        <div>
          <h1>Proyectos</h1>
          <p className="page-sub">Repos de GitHub, presupuesto de horas y equipo asignado.</p>
        </div>
        <div className="btn-row">
          {canTypes ? (
            <button className="btn" onClick={() => setTypeModal(true)}>
              🏷 Tipos de tarea
            </button>
          ) : null}
          {canWrite ? (
            <button
              className="btn btn-primary"
              onClick={() => {
                setForm({ clientId: clients[0]?.id ?? '', name: '', description: '', githubRepos: '', budgetHours: '', hourlyRate: '', memberIds: [], isActive: true });
                setModal({ open: true, editing: null });
              }}
            >
              ＋ Nuevo proyecto
            </button>
          ) : null}
        </div>
      </div>

      <Card>
        <select className="select" style={{ width: 'auto', marginBottom: 14 }} value={clientFilter} onChange={(e) => setClientFilter(e.target.value)}>
          <option value="">Todos los clientes</option>
          {clients.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>

        {loading ? (
          <Spinner />
        ) : projects.length === 0 ? (
          <Empty>Sin proyectos. Crea un cliente y luego su primer proyecto.</Empty>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Proyecto</th>
                  <th>Cliente</th>
                  <th>GitHub</th>
                  <th className="right">Presupuesto</th>
                  <th className="right">Horas (30 d)</th>
                  <th>Equipo</th>
                  {canWrite ? <th className="right">Acciones</th> : null}
                </tr>
              </thead>
              <tbody>
                {projects.map((p) => {
                  const usage = p.budgetHours ? Math.round((p.hours30d / p.budgetHours) * 100) : null;
                  return (
                    <tr key={p.id}>
                      <td>
                        <strong>{p.name}</strong>
                        {p.description ? <div className="tiny muted-2">{p.description.slice(0, 70)}</div> : null}
                        {!p.isActive ? <Badge kind="badge-danger">inactivo</Badge> : null}
                      </td>
                      <td className="small">{p.clientName}</td>
                      <td className="mono tiny muted">{p.githubRepos ?? '—'}</td>
                      <td className="right small">
                        {p.budgetHours ? `${p.budgetHours} h` : '—'}
                        {usage !== null ? (
                          <div className="tiny" style={{ color: usage > 100 ? '#f87171' : usage > 80 ? '#fbbf24' : '#64748b' }}>
                            {usage}% usado
                          </div>
                        ) : null}
                      </td>
                      <td className="right mono">{formatHours(p.hours30d)}</td>
                      <td className="small">
                        {p.members?.length ? (
                          <span className="muted">{p.members.map((m: any) => m.fullName.split(' ')[0]).join(', ')}</span>
                        ) : (
                          <span className="tiny muted-2">sin asignar</span>
                        )}
                      </td>
                      {canWrite ? (
                        <td>
                          <div className="td-actions">
                            <button
                              className="btn btn-sm"
                              onClick={() => {
                                setForm({
                                  clientId: p.clientId,
                                  name: p.name,
                                  description: p.description ?? '',
                                  githubRepos: p.githubRepos ?? '',
                                  budgetHours: p.budgetHours ? String(p.budgetHours) : '',
                                  hourlyRate: p.hourlyRate ? String(p.hourlyRate) : '',
                                  memberIds: (p.members ?? []).map((m: any) => m.id),
                                  isActive: p.isActive,
                                });
                                setModal({ open: true, editing: p });
                              }}
                            >
                              Editar
                            </button>
                            <button className="btn btn-sm" onClick={() => void toggle(p)}>
                              {p.isActive ? 'Desactivar' : 'Activar'}
                            </button>
                          </div>
                        </td>
                      ) : null}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {modal.open ? (
        <Modal
          title={modal.editing ? `Editar ${modal.editing.name}` : 'Nuevo proyecto'}
          onClose={() => setModal({ open: false, editing: null })}
          wide
          footer={
            <>
              <button className="btn btn-ghost" onClick={() => setModal({ open: false, editing: null })}>
                Cancelar
              </button>
              <button className="btn btn-primary" onClick={() => void save()} disabled={saving || !form.name || !form.clientId}>
                {saving ? 'Guardando…' : 'Guardar'}
              </button>
            </>
          }
        >
          <div className="form-grid">
            <Field label="Cliente">
              <select className="select" value={form.clientId} onChange={(e) => setForm({ ...form, clientId: e.target.value })}>
                <option value="">Selecciona…</option>
                {clients.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Nombre del proyecto">
              <input className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Portal Web" />
            </Field>
            <Field label="Repos GitHub" hint="owner/repo, varios separados por coma. Se usan para adjuntar commits y PRs al finalizar la tarea.">
              <input className="input" value={form.githubRepos} onChange={(e) => setForm({ ...form, githubRepos: e.target.value })} placeholder="acme/portal-web, acme/api" />
            </Field>
            <Field label="Presupuesto (horas)">
              <input className="input" type="number" value={form.budgetHours} onChange={(e) => setForm({ ...form, budgetHours: e.target.value })} />
            </Field>
            <Field label="Tarifa por hora" hint="Opcional, para valorizar reportes.">
              <input className="input" type="number" value={form.hourlyRate} onChange={(e) => setForm({ ...form, hourlyRate: e.target.value })} />
            </Field>
          </div>
          <Field label="Descripción">
            <textarea className="textarea" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
          </Field>
          <Field label="Equipo asignado" hint="Solo los miembros ven el proyecto en el bot (los admins ven todos).">
            <div className="row" style={{ maxHeight: 160, overflowY: 'auto' }}>
              {users.map((u) => (
                <label key={u.id} className="checkbox">
                  <input
                    type="checkbox"
                    checked={form.memberIds.includes(u.id)}
                    onChange={(e) =>
                      setForm({
                        ...form,
                        memberIds: e.target.checked ? [...form.memberIds, u.id] : form.memberIds.filter((id) => id !== u.id),
                      })
                    }
                  />
                  {u.fullName}
                </label>
              ))}
            </div>
          </Field>
          <label className="checkbox">
            <input type="checkbox" checked={form.isActive} onChange={(e) => setForm({ ...form, isActive: e.target.checked })} />
            Proyecto activo
          </label>
        </Modal>
      ) : null}

      {typeModal ? (
        <Modal title="Tipos de tarea globales" onClose={() => setTypeModal(false)} wide>
          <p className="muted small">
            El bot usa estos tipos (y sus alias) para clasificar automáticamente lo que el trabajador dice por voz.
          </p>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Tipo</th>
                  <th>Alias</th>
                  <th>Facturable</th>
                  <th className="right"></th>
                </tr>
              </thead>
              <tbody>
                {taskTypes.map((t) => (
                  <tr key={t.id}>
                    <td>
                      <span className="pill-dot" style={{ background: t.color, display: 'inline-block', marginRight: 8 }} />
                      {t.name}
                    </td>
                    <td className="tiny muted">{t.aliases || '—'}</td>
                    <td className="small">{t.billable ? 'sí' : 'no'}</td>
                    <td>
                      <div className="td-actions">
                        <button
                          className="btn btn-sm btn-ghost"
                          onClick={async () => {
                            if (!window.confirm(`¿Desactivar el tipo "${t.name}"?`)) return;
                            await api.delete(`/task-types/${t.id}`);
                            await load();
                          }}
                        >
                          🗑
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="divider" />
          <div className="form-grid">
            <Field label="Nuevo tipo">
              <input className="input" value={typeForm.name} onChange={(e) => setTypeForm({ ...typeForm, name: e.target.value })} placeholder="Investigación" />
            </Field>
            <Field label="Alias (separados por coma)">
              <input className="input" value={typeForm.aliases} onChange={(e) => setTypeForm({ ...typeForm, aliases: e.target.value })} placeholder="research, spike, prototipo" />
            </Field>
            <Field label="Color">
              <input className="input" type="color" value={typeForm.color} onChange={(e) => setTypeForm({ ...typeForm, color: e.target.value })} />
            </Field>
          </div>
          <div className="btn-row" style={{ justifyContent: 'flex-end' }}>
            <button
              className="btn btn-primary"
              disabled={!typeForm.name}
              onClick={async () => {
                try {
                  await api.post('/task-types', typeForm);
                  push('Tipo de tarea creado', 'success');
                  setTypeForm({ name: '', aliases: '', color: '#6366f1' });
                  await load();
                } catch (err) {
                  push((err as Error).message, 'error');
                }
              }}
            >
              Añadir tipo
            </button>
          </div>
        </Modal>
      ) : null}
    </div>
  );
}
