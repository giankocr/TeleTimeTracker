import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { Alert, Badge, Card, Empty, Field, Modal, Spinner, useToast } from '../components/ui';

interface Role {
  id: string;
  key: string;
  name: string;
  description: string | null;
  permissions: string[];
  isSystem: boolean;
  usersCount: number;
}

/** Editor de roles y permisos (RBAC). */
export default function RolesPage() {
  const { can } = useAuth();
  const { push } = useToast();
  const [roles, setRoles] = useState<Role[]>([]);
  const [available, setAvailable] = useState<string[]>([]);
  const [presets, setPresets] = useState<Record<string, { name: string; description: string; permissions: string[] }>>({});
  const [loading, setLoading] = useState(true);
  const [modal, setModal] = useState<{ open: boolean; editing: Role | null }>({ open: false, editing: null });
  const [form, setForm] = useState({ key: '', name: '', description: '', permissions: [] as string[] });
  const [saving, setSaving] = useState(false);

  const canWrite = can('roles:write');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get<{ roles: Role[]; availablePermissions: string[] }>('/roles');
      setRoles(res.roles);
      setAvailable(res.availablePermissions);
      const permRes = await api.get<{ presets: any }>('/auth/permissions').catch(() => null);
      if (permRes?.presets) setPresets(permRes.presets);
    } catch (err) {
      push((err as Error).message, 'error');
    } finally {
      setLoading(false);
    }
  }, [push]);

  useEffect(() => {
    void load();
  }, [load]);

  /** Agrupa los permisos por namespace para pintarlos ordenados. */
  const grouped = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const permission of available) {
      const ns = permission.split(':')[0]!;
      map.set(ns, [...(map.get(ns) ?? []), permission]);
    }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [available]);

  const save = async () => {
    setSaving(true);
    try {
      if (modal.editing) {
        await api.patch(`/roles/${modal.editing.id}`, {
          name: form.name,
          description: form.description || null,
          permissions: form.permissions,
        });
        push('Rol actualizado', 'success');
      } else {
        await api.post('/roles', {
          key: form.key.toUpperCase(),
          name: form.name,
          description: form.description || null,
          permissions: form.permissions,
        });
        push('Rol creado', 'success');
      }
      setModal({ open: false, editing: null });
      await load();
    } catch (err) {
      push((err as Error).message, 'error');
    } finally {
      setSaving(false);
    }
  };

  const remove = async (role: Role) => {
    if (!window.confirm(`¿Eliminar el rol ${role.name}?`)) return;
    try {
      await api.delete(`/roles/${role.id}`);
      push('Rol eliminado', 'success');
      await load();
    } catch (err) {
      push((err as Error).message, 'error');
    }
  };

  const togglePermission = (permission: string) => {
    setForm((f) => ({
      ...f,
      permissions: f.permissions.includes(permission)
        ? f.permissions.filter((p) => p !== permission)
        : [...f.permissions, permission],
    }));
  };

  return (
    <div className="stack">
      <div className="row-between">
        <div>
          <h1>Roles y permisos</h1>
          <p className="page-sub">Control de acceso basado en roles (RBAC). Los roles de sistema no se pueden eliminar.</p>
        </div>
        {canWrite ? (
          <button
            className="btn btn-primary"
            onClick={() => {
              setForm({ key: '', name: '', description: '', permissions: [] });
              setModal({ open: true, editing: null });
            }}
          >
            ＋ Nuevo rol
          </button>
        ) : null}
      </div>

      {loading ? (
        <Spinner />
      ) : (
        <div className="grid grid-auto">
          {roles.map((role) => (
            <Card key={role.id}>
              <div className="row-between">
                <div>
                  <h3>{role.name}</h3>
                  <span className="mono tiny muted-2">{role.key}</span>
                </div>
                <Badge kind={role.isSystem ? 'badge-primary' : ''}>{role.isSystem ? 'sistema' : 'personalizado'}</Badge>
              </div>
              <p className="small muted" style={{ marginTop: 8, minHeight: 34 }}>
                {role.description ?? '—'}
              </p>
              <div className="row tiny muted-2" style={{ marginTop: 6 }}>
                <span>👥 {role.usersCount} usuario(s)</span>
                <span>·</span>
                <span>🔑 {role.permissions.includes('*') ? 'acceso total' : `${role.permissions.length} permisos`}</span>
              </div>
              <div className="btn-row" style={{ marginTop: 14 }}>
                {canWrite ? (
                  <button
                    className="btn btn-sm"
                    onClick={() => {
                      setForm({ key: role.key, name: role.name, description: role.description ?? '', permissions: [...role.permissions] });
                      setModal({ open: true, editing: role });
                    }}
                  >
                    Editar permisos
                  </button>
                ) : null}
                {canWrite && !role.isSystem ? (
                  <button className="btn btn-sm btn-danger" onClick={() => void remove(role)} disabled={role.usersCount > 0}>
                    Eliminar
                  </button>
                ) : null}
              </div>
            </Card>
          ))}
        </div>
      )}

      <Card title="Cómo funciona" hint="Referencia rápida para asignar roles">
        <div className="stack-sm small muted">
          <div>• <b>ADMIN</b>: permiso <span className="mono">*</span> — gestiona usuarios, roles, configuración y ve todos los reportes.</div>
          <div>• <b>MANAGER</b>: gestiona clientes/proyectos y ve los reportes de su equipo (quienes lo tienen como supervisor).</div>
          <div>• <b>USER</b>: registra su tiempo con el bot y consulta su propio historial.</div>
          <div>• Los permisos con <span className="mono">:read</span> permiten ver; los <span className="mono">:write</span> permiten editar; <span className="mono">:delete</span> eliminar.</div>
        </div>
      </Card>

      {modal.open ? (
        <Modal
          title={modal.editing ? `Editar rol ${modal.editing.name}` : 'Nuevo rol'}
          onClose={() => setModal({ open: false, editing: null })}
          wide
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
            <Field label="Clave (MAYÚSCULAS)" hint="Identificador interno; no se puede cambiar después.">
              <input
                className="input"
                value={form.key}
                disabled={Boolean(modal.editing)}
                onChange={(e) => setForm({ ...form, key: e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, '') })}
                placeholder="SUPERVISOR"
              />
            </Field>
            <Field label="Nombre visible">
              <input className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Supervisor de área" />
            </Field>
          </div>
          <Field label="Descripción">
            <input className="input" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
          </Field>

          {!modal.editing && Object.keys(presets).length ? (
            <div className="row small">
              <span className="muted">Empezar desde una plantilla:</span>
              {Object.entries(presets).map(([key, preset]) => (
                <button
                  key={key}
                  className="btn btn-sm"
                  onClick={() => setForm({ ...form, permissions: [...preset.permissions] })}
                >
                  {preset.name}
                </button>
              ))}
            </div>
          ) : null}

          {modal.editing?.key === 'ADMIN' ? (
            <Alert kind="warning">
              El rol ADMIN siempre conserva el permiso <span className="mono">*</span> (acceso total); el sistema no permite quitarlo.
            </Alert>
          ) : null}

          <div className="stack">
            <div className="row-between">
              <span className="small muted">Permisos ({form.permissions.length} seleccionados)</span>
              <div className="btn-row">
                <button className="btn btn-sm" onClick={() => setForm({ ...form, permissions: [...available] })}>
                  Seleccionar todos
                </button>
                <button className="btn btn-sm" onClick={() => setForm({ ...form, permissions: [] })}>
                  Limpiar
                </button>
              </div>
            </div>
            {grouped.map(([ns, perms]) => (
              <Card key={ns} style={{ padding: 14 }}>
                <div className="row-between" style={{ marginBottom: 8 }}>
                  <strong className="small" style={{ textTransform: 'capitalize' }}>{ns}</strong>
                  <button
                    className="btn btn-sm btn-ghost"
                    onClick={() =>
                      setForm((f) => {
                        const allSelected = perms.every((p) => f.permissions.includes(p));
                        return {
                          ...f,
                          permissions: allSelected
                            ? f.permissions.filter((p) => !perms.includes(p))
                            : [...new Set([...f.permissions, ...perms])],
                        };
                      })
                    }
                  >
                    alternar
                  </button>
                </div>
                <div className="row">
                  {perms.map((permission) => (
                    <label key={permission} className="checkbox">
                      <input type="checkbox" checked={form.permissions.includes(permission)} onChange={() => togglePermission(permission)} />
                      <span className="mono tiny">{permission}</span>
                    </label>
                  ))}
                </div>
              </Card>
            ))}
          </div>
        </Modal>
      ) : null}

      {!roles.length && !loading ? <Empty>No hay roles definidos.</Empty> : null}
    </div>
  );
}
