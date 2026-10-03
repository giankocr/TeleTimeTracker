import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { WEEKDAYS, formatDate, formatDateTime } from '../lib/format';
import { Alert, Badge, Card, Empty, Field, Modal, Spinner, useToast } from '../components/ui';
import type { SessionUser } from '../lib/auth';

interface RoleOption {
  id: string;
  key: string;
  name: string;
  permissions: string[];
}

const EMPTY_FORM = {
  email: '',
  fullName: '',
  password: '',
  roleId: '',
  managerId: '',
  phone: '',
  telegramId: '',
  githubUsername: '',
  githubToken: '',
  timezone: 'America/Bogota',
  workDays: [1, 2, 3, 4, 5] as number[],
  workStart: '09:00',
  workEnd: '18:00',
  idleAlertMin: 45,
  dailyDigest: true,
  isActive: true,
  sendLinkCode: true,
};

/** CRUD de usuarios, asignación de roles y vinculación con Telegram. */
export default function UsersPage() {
  const { can, user: me } = useAuth();
  const { push } = useToast();

  const [users, setUsers] = useState<SessionUser[]>([]);
  const [roles, setRoles] = useState<RoleOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [roleFilter, setRoleFilter] = useState('');
  const [activeFilter, setActiveFilter] = useState('');

  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<SessionUser | null>(null);
  const [form, setForm] = useState({ ...EMPTY_FORM });
  const [saving, setSaving] = useState(false);
  const [generated, setGenerated] = useState<{ title: string; code: string; hint: string } | null>(null);
  // Solicitudes de acceso enviadas desde el bot (compartir el teléfono).
  const [requests, setRequests] = useState<any[]>([]);

  const canWrite = can('users:write');
  const canDelete = can('users:delete');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [usersRes, rolesRes, requestsRes] = await Promise.all([
        api.get<{ users: SessionUser[] }>('/users', {
          search: search || undefined,
          roleId: roleFilter || undefined,
          isActive: activeFilter || undefined,
        }),
        api.get<{ roles: RoleOption[] }>('/roles').catch(() => ({ roles: [] })),
        api.get<{ contacts: any[] }>('/users/bot-contacts', { status: 'PENDING' }).catch(() => ({ contacts: [] })),
      ]);
      setUsers(usersRes.users);
      setRoles(rolesRes.roles);
      setRequests(requestsRes.contacts);
    } catch (err) {
      push((err as Error).message, 'error');
    } finally {
      setLoading(false);
    }
  }, [search, roleFilter, activeFilter, push]);

  useEffect(() => {
    const t = setTimeout(() => void load(), 250);
    return () => clearTimeout(t);
  }, [load]);

  const openCreate = () => {
    setEditing(null);
    setForm({ ...EMPTY_FORM, roleId: roles.find((r) => r.key === 'USER')?.id ?? roles[0]?.id ?? '' });
    setModalOpen(true);
  };

  const openEdit = (u: SessionUser) => {
    setEditing(u);
    setForm({
      ...EMPTY_FORM,
      email: u.email,
      fullName: u.fullName,
      roleId: u.role?.id ?? '',
      managerId: u.managerId ?? '',
      phone: u.phone ?? '',
      telegramId: u.telegramId ?? '',
      githubUsername: u.githubUsername ?? '',
      githubToken: '',
      timezone: u.timezone,
      workDays: u.workDays?.length ? u.workDays : [1, 2, 3, 4, 5],
      workStart: u.workStart,
      workEnd: u.workEnd,
      idleAlertMin: u.idleAlertMin,
      dailyDigest: u.dailyDigest,
      isActive: u.isActive,
    });
    setModalOpen(true);
  };

  const save = async () => {
    setSaving(true);
    try {
      const payload: any = {
        email: form.email,
        fullName: form.fullName,
        roleId: form.roleId,
        managerId: form.managerId || null,
        phone: form.phone || null,
        telegramId: form.telegramId || null,
        githubUsername: form.githubUsername || null,
        timezone: form.timezone,
        workDays: form.workDays,
        workStart: form.workStart,
        workEnd: form.workEnd,
        idleAlertMin: Number(form.idleAlertMin),
        dailyDigest: form.dailyDigest,
        isActive: form.isActive,
      };
      if (form.githubToken) payload.githubToken = form.githubToken;

      if (editing) {
        await api.patch(`/users/${editing.id}`, payload);
        push('Usuario actualizado', 'success');
      } else {
        payload.password = form.password;
        payload.sendLinkCode = form.sendLinkCode;
        const res = await api.post<{ telegramLinkCode?: string }>('/users', payload);
        if (res.telegramLinkCode) {
          setGenerated({
            title: 'Usuario creado',
            code: res.telegramLinkCode,
            hint: 'Comparte este código: el usuario debe enviarlo al bot de Telegram con /vincular.',
          });
        } else {
          push('Usuario creado', 'success');
        }
      }
      setModalOpen(false);
      await load();
    } catch (err) {
      push((err as Error).message, 'error');
    } finally {
      setSaving(false);
    }
  };

  const resetPassword = async (u: SessionUser) => {
    const custom = window.prompt(
      `Nueva contraseña para ${u.fullName}.\nDeja vacío para generar una temporal automáticamente:`,
      '',
    );
    if (custom === null) return;
    try {
      const res = await api.post<{ temporaryPassword: string }>(`/users/${u.id}/reset-password`, {
        newPassword: custom.trim() || undefined,
      });
      setGenerated({
        title: 'Contraseña restablecida',
        code: res.temporaryPassword,
        hint: 'Se cerraron todas las sesiones del usuario. Comparte la clave por un canal seguro.',
      });
    } catch (err) {
      push((err as Error).message, 'error');
    }
  };

  const linkCode = async (u: SessionUser) => {
    try {
      const res = await api.post<{ code: string; instructions: string }>(`/users/${u.id}/telegram/link-code`);
      setGenerated({ title: `Código de vinculación para ${u.fullName}`, code: res.code, hint: res.instructions });
    } catch (err) {
      push((err as Error).message, 'error');
    }
  };

  const unlink = async (u: SessionUser) => {
    if (!window.confirm(`¿Desvincular el Telegram de ${u.fullName}?`)) return;
    try {
      await api.delete(`/users/${u.id}/telegram`);
      push('Telegram desvinculado', 'success');
      await load();
    } catch (err) {
      push((err as Error).message, 'error');
    }
  };

  const toggleActive = async (u: SessionUser) => {
    if (u.isActive) {
      if (!window.confirm(`¿Desactivar a ${u.fullName}? No podrá iniciar sesión ni usar el bot.`)) return;
      try {
        await api.delete(`/users/${u.id}`);
        push('Usuario desactivado', 'success');
        await load();
      } catch (err) {
        push((err as Error).message, 'error');
      }
    } else {
      try {
        await api.patch(`/users/${u.id}`, { isActive: true });
        push('Usuario reactivado', 'success');
        await load();
      } catch (err) {
        push((err as Error).message, 'error');
      }
    }
  };

  const hardDelete = async (u: SessionUser) => {
    const confirmation = window.prompt(
      `Esto BORRA a ${u.fullName} y todos sus registros de tiempo (irreversible).\nEscribe ELIMINAR para confirmar:`,
    );
    if (confirmation !== 'ELIMINAR') return;
    try {
      await api.delete(`/users/${u.id}`, { hard: '1' });
      push('Usuario eliminado', 'success');
      await load();
    } catch (err) {
      push((err as Error).message, 'error');
    }
  };

  const managerOptions = useMemo(() => users.filter((u) => u.id !== editing?.id), [users, editing]);

  /** Aprueba una solicitud del bot: vincula la cuenta existente o crea el usuario. */
  const approveRequest = async (request: any) => {
    if (!canWrite) return;
    let roleId: string | undefined;
    if (!request.existingUser) {
      const chosen = window.prompt(
        `Crear cuenta para ${request.firstName ?? request.phone}.\nEscribe la clave del rol a asignar (${roles.map((r) => r.key).join(', ')}):`,
        'USER',
      );
      if (chosen === null) return;
      const role = roles.find((r) => r.key === chosen.trim().toUpperCase());
      if (!role) {
        push('Rol no reconocido', 'error');
        return;
      }
      roleId = role.id;
    }
    try {
      const res = await api.patch<{ user: SessionUser; temporaryPassword?: string; linked?: boolean }>(
        `/users/bot-contacts/${request.id}`,
        { action: 'APPROVE', roleId },
      );
      if (res.temporaryPassword) {
        setGenerated({
          title: 'Cuenta creada desde el bot',
          code: res.temporaryPassword,
          hint: `Usuario: ${res.user.email}. Comparte esta clave temporal por un canal seguro.`,
        });
      } else {
        push(`${res.user.fullName} vinculado con Telegram`, 'success');
      }
      await load();
    } catch (err) {
      push((err as Error).message, 'error');
    }
  };

  const rejectRequest = async (request: any) => {
    if (!window.confirm(`¿Rechazar la solicitud de ${request.firstName ?? request.phone}?`)) return;
    try {
      await api.patch(`/users/bot-contacts/${request.id}`, { action: 'REJECT' });
      push('Solicitud rechazada', 'success');
      await load();
    } catch (err) {
      push((err as Error).message, 'error');
    }
  };

  return (
    <div className="stack">
      <div className="row-between">
        <div>
          <h1>Usuarios</h1>
          <p className="page-sub">Cuentas, roles, jornada laboral y vinculación con el bot de Telegram.</p>
        </div>
        {canWrite ? (
          <button className="btn btn-primary" onClick={openCreate}>
            ＋ Nuevo usuario
          </button>
        ) : null}
      </div>

      {requests.length ? (
        <Card
          title={`Solicitudes de acceso desde el bot (${requests.length})`}
          hint="Estas personas compartieron su número por Telegram y aún no tienen cuenta."
        >
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Persona</th>
                  <th>Teléfono</th>
                  <th>Telegram</th>
                  <th>Solicitada</th>
                  <th className="right">Acciones</th>
                </tr>
              </thead>
              <tbody>
                {requests.map((r) => (
                  <tr key={r.id}>
                    <td>
                      <strong>
                        {[r.firstName, r.lastName].filter(Boolean).join(' ') || 'Sin nombre'}
                      </strong>
                      {r.existingUser ? (
                        <div className="tiny muted-2">ya existe: {r.existingUser.email}</div>
                      ) : (
                        <div className="tiny muted-2">cuenta nueva</div>
                      )}
                    </td>
                    <td className="mono small">{r.phone}</td>
                    <td className="small muted">{r.username ? `@${r.username}` : r.telegramId}</td>
                    <td className="small muted nowrap">{formatDateTime(r.createdAt)}</td>
                    <td>
                      <div className="td-actions">
                        {canWrite ? (
                          <>
                            <button className="btn btn-sm btn-primary" onClick={() => void approveRequest(r)}>
                              {r.existingUser ? 'Vincular' : 'Crear cuenta'}
                            </button>
                            <button className="btn btn-sm btn-ghost" onClick={() => void rejectRequest(r)}>
                              Rechazar
                            </button>
                          </>
                        ) : (
                          <span className="tiny muted-2">solo lectura</span>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      ) : null}

      <Card>
        <div className="row" style={{ marginBottom: 14 }}>
          <input
            className="input"
            style={{ maxWidth: 300 }}
            placeholder="Buscar por nombre, correo o Telegram…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <select className="select" style={{ width: 'auto' }} value={roleFilter} onChange={(e) => setRoleFilter(e.target.value)}>
            <option value="">Todos los roles</option>
            {roles.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
          <select className="select" style={{ width: 'auto' }} value={activeFilter} onChange={(e) => setActiveFilter(e.target.value)}>
            <option value="">Todos los estados</option>
            <option value="true">Activos</option>
            <option value="false">Desactivados</option>
          </select>
          <span className="muted small">{users.length} usuario(s)</span>
        </div>

        {loading ? (
          <Spinner />
        ) : users.length === 0 ? (
          <Empty>No hay usuarios que coincidan con el filtro.</Empty>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Usuario</th>
                  <th>Rol</th>
                  <th>Jornada</th>
                  <th>Telegram</th>
                  <th>Teléfono</th>
                  <th>Estado</th>
                  <th>Último acceso</th>
                  {canWrite || canDelete ? <th className="right">Acciones</th> : null}
                </tr>
              </thead>
              <tbody>
                {users.map((u) => (
                  <tr key={u.id}>
                    <td>
                      <div className="stack-sm" style={{ gap: 1 }}>
                        <strong>{u.fullName}</strong>
                        <span className="tiny muted-2">{u.email}</span>
                      </div>
                    </td>
                    <td>
                      <Badge kind={u.role?.key === 'ADMIN' ? 'badge-primary' : u.role?.key === 'MANAGER' ? 'badge-info' : ''}>
                        {u.role?.name ?? '—'}
                      </Badge>
                    </td>
                    <td className="small muted nowrap">
                      {u.workStart}–{u.workEnd}
                      <br />
                      <span className="tiny">
                        {(u.workDays ?? []).map((d) => WEEKDAYS[d]).join(' ')}
                      </span>
                    </td>
                    <td className="small">
                      {u.telegramId ? (
                        <div className="stack-sm" style={{ gap: 1 }}>
                          <Badge kind="badge-success">Vinculado</Badge>
                          <span className="tiny muted-2">
                            {u.telegramUsername ? `@${u.telegramUsername}` : u.telegramId}
                          </span>
                        </div>
                      ) : (
                        <Badge kind="badge-warning">Sin vincular</Badge>
                      )}
                    </td>
                    <td className="small mono nowrap">{u.phone ?? '—'}</td>
                    <td>{u.isActive ? <Badge kind="badge-success">Activo</Badge> : <Badge kind="badge-danger">Inactivo</Badge>}</td>
                    <td className="small muted nowrap">{u.lastLoginAt ? formatDateTime(u.lastLoginAt) : 'nunca'}</td>
                    {canWrite || canDelete ? (
                      <td>
                        <div className="td-actions">
                          {canWrite ? (
                            <>
                              <button className="btn btn-sm" onClick={() => openEdit(u)}>
                                Editar
                              </button>
                              <button className="btn btn-sm" onClick={() => void linkCode(u)} title="Generar código de vinculación">
                                🔗
                              </button>
                              <button className="btn btn-sm" onClick={() => void resetPassword(u)} title="Restablecer contraseña">
                                🔑
                              </button>
                              {u.telegramId ? (
                                <button className="btn btn-sm" onClick={() => void unlink(u)} title="Desvincular Telegram">
                                  ✖️
                                </button>
                              ) : null}
                              <button className="btn btn-sm" onClick={() => void toggleActive(u)} disabled={u.id === me?.id}>
                                {u.isActive ? 'Desactivar' : 'Activar'}
                              </button>
                            </>
                          ) : null}
                          {canDelete ? (
                            <button className="btn btn-sm btn-danger" onClick={() => void hardDelete(u)} disabled={u.id === me?.id} title="Eliminar definitivamente">
                              🗑
                            </button>
                          ) : null}
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

      {modalOpen ? (
        <Modal
          title={editing ? `Editar ${editing.fullName}` : 'Nuevo usuario'}
          onClose={() => setModalOpen(false)}
          wide
          footer={
            <>
              <button className="btn btn-ghost" onClick={() => setModalOpen(false)}>
                Cancelar
              </button>
              <button className="btn btn-primary" onClick={() => void save()} disabled={saving}>
                {saving ? 'Guardando…' : 'Guardar'}
              </button>
            </>
          }
        >
          <div className="form-grid">
            <Field label="Nombre completo">
              <input className="input" value={form.fullName} onChange={(e) => setForm({ ...form, fullName: e.target.value })} />
            </Field>
            <Field label="Correo electrónico">
              <input className="input" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
            </Field>
            {!editing ? (
              <Field label="Contraseña inicial" hint="Mínimo 8 caracteres, con letras y números.">
                <input className="input" type="text" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} placeholder="Temporal123" />
              </Field>
            ) : null}
            <Field label="Rol">
              <select className="select" value={form.roleId} onChange={(e) => setForm({ ...form, roleId: e.target.value })}>
                <option value="">Selecciona un rol…</option>
                {roles.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name} ({r.key})
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Supervisor / manager" hint="Determina qué reportes puede ver (reports:team).">
              <select className="select" value={form.managerId} onChange={(e) => setForm({ ...form, managerId: e.target.value })}>
                <option value="">Sin supervisor</option>
                {managerOptions.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.fullName}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Zona horaria" hint="IANA, ej. America/Bogota">
              <input className="input" value={form.timezone} onChange={(e) => setForm({ ...form, timezone: e.target.value })} />
            </Field>
            <Field label="Hora de entrada">
              <input className="input" type="time" value={form.workStart} onChange={(e) => setForm({ ...form, workStart: e.target.value })} />
            </Field>
            <Field label="Hora de salida">
              <input className="input" type="time" value={form.workEnd} onChange={(e) => setForm({ ...form, workEnd: e.target.value })} />
            </Field>
            <Field label="Alerta de inactividad (min)" hint="Minutos sin tarea corriendo antes de avisar por Telegram.">
              <input
                className="input"
                type="number"
                min={5}
                max={480}
                value={form.idleAlertMin}
                onChange={(e) => setForm({ ...form, idleAlertMin: Number(e.target.value) })}
              />
            </Field>
            <Field
              label="Teléfono"
              hint="Permite entrar al panel con «Teléfono + código» y vincular el bot compartiendo el número."
            >
              <input
                className="input"
                type="tel"
                value={form.phone}
                onChange={(e) => setForm({ ...form, phone: e.target.value })}
                placeholder="+57 300 123 4567"
              />
            </Field>
            <Field label="Telegram ID" hint="Se llena solo al vincular con el código o el teléfono. También puedes pegarlo aquí.">
              <input className="input" value={form.telegramId} onChange={(e) => setForm({ ...form, telegramId: e.target.value })} placeholder="123456789" />
            </Field>
            <Field label="Usuario GitHub" hint="Opcional: usado para enriquecer tareas con commits/PRs.">
              <input className="input" value={form.githubUsername} onChange={(e) => setForm({ ...form, githubUsername: e.target.value })} placeholder="octocat" />
            </Field>
            <Field label="Token GitHub personal" hint="Se guarda cifrado. Deja vacío para no cambiarlo.">
              <input className="input" type="password" value={form.githubToken} onChange={(e) => setForm({ ...form, githubToken: e.target.value })} placeholder="ghp_…" />
            </Field>
          </div>

          <Field label="Días laborables">
            <div className="row">
              {WEEKDAYS.map((day, index) => (
                <label key={day} className="checkbox">
                  <input
                    type="checkbox"
                    checked={form.workDays.includes(index)}
                    onChange={(e) =>
                      setForm({
                        ...form,
                        workDays: e.target.checked ? [...form.workDays, index].sort() : form.workDays.filter((d) => d !== index),
                      })
                    }
                  />
                  {day}
                </label>
              ))}
            </div>
          </Field>

          <div className="row">
            <label className="checkbox">
              <input type="checkbox" checked={form.isActive} onChange={(e) => setForm({ ...form, isActive: e.target.checked })} />
              Cuenta activa
            </label>
            <label className="checkbox">
              <input type="checkbox" checked={form.dailyDigest} onChange={(e) => setForm({ ...form, dailyDigest: e.target.checked })} />
              Enviar resumen diario por Telegram
            </label>
            {!editing ? (
              <label className="checkbox">
                <input type="checkbox" checked={form.sendLinkCode} onChange={(e) => setForm({ ...form, sendLinkCode: e.target.checked })} />
                Generar código de vinculación de Telegram
              </label>
            ) : null}
          </div>

          <Alert kind="info">
            La jornada define cuándo el bot puede enviar alertas de inactividad. Los avisos nunca llegan fuera de ese horario ni los días no laborables.
          </Alert>
        </Modal>
      ) : null}

      {generated ? (
        <Modal
          title={generated.title}
          onClose={() => setGenerated(null)}
          footer={
            <>
              <button
                className="btn"
                onClick={() => {
                  void navigator.clipboard.writeText(generated.code);
                  push('Copiado al portapapeles', 'success');
                }}
              >
                Copiar
              </button>
              <button className="btn btn-primary" onClick={() => setGenerated(null)}>
                Entendido
              </button>
            </>
          }
        >
          <p className="muted small">{generated.hint}</p>
          <div className="card center" style={{ padding: 22 }}>
            <div className="mono" style={{ fontSize: '1.7rem', letterSpacing: '0.16em' }}>
              {generated.code}
            </div>
          </div>
        </Modal>
      ) : null}
    </div>
  );
}
