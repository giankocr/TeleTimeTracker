import { useState, useEffect } from 'react';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { WEEKDAYS, formatDateTime } from '../lib/format';
import { Alert, Badge, Card, Field, useToast } from '../components/ui';
import type { SessionUser } from '../lib/auth';

interface ApiToken {
  id: string;
  name: string;
  prefix: string;
  maskedToken: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
}

/** Perfil propio: datos personales, jornada, GitHub y cambio de contraseña. */
export default function ProfilePage() {
  const { user, refreshUser } = useAuth();
  const { push } = useToast();

  const [form, setForm] = useState({
    fullName: user?.fullName ?? '',
    timezone: user?.timezone ?? 'America/Bogota',
    workDays: user?.workDays?.length ? user.workDays : [1, 2, 3, 4, 5],
    workStart: user?.workStart ?? '09:00',
    workEnd: user?.workEnd ?? '18:00',
    idleAlertMin: user?.idleAlertMin ?? 45,
    dailyDigest: user?.dailyDigest ?? true,
    githubUsername: user?.githubUsername ?? '',
    githubToken: '',
  });
  const [passwords, setPasswords] = useState({ currentPassword: '', newPassword: '', confirm: '' });
  const [savingProfile, setSavingProfile] = useState(false);
  const [savingPassword, setSavingPassword] = useState(false);

  // API Tokens
  const [tokens, setTokens] = useState<ApiToken[]>([]);
  const [loadingTokens, setLoadingTokens] = useState(false);
  const [creatingToken, setCreatingToken] = useState(false);
  const [newTokenForm, setNewTokenForm] = useState({ name: '', expiresInDays: 365 });
  const [newlyCreatedToken, setNewlyCreatedToken] = useState<string | null>(null);
  const [showCreateForm, setShowCreateForm] = useState(false);

  useEffect(() => {
    void loadTokens();
  }, []);

  if (!user) return null;

  const loadTokens = async () => {
    setLoadingTokens(true);
    try {
      const res = await api.get<{ tokens: ApiToken[] }>('/tokens');
      setTokens(res.tokens);
    } catch (err) {
      push((err as Error).message, 'error');
    } finally {
      setLoadingTokens(false);
    }
  };

  const createToken = async () => {
    if (!newTokenForm.name.trim()) {
      push('Escribe un nombre para el token', 'error');
      return;
    }
    setCreatingToken(true);
    try {
      const res = await api.post<{ token: string; info: ApiToken }>('/tokens', newTokenForm);
      setNewlyCreatedToken(res.token);
      setTokens([res.info, ...tokens]);
      setNewTokenForm({ name: '', expiresInDays: 365 });
      setShowCreateForm(false);
      push('Token creado. Cópialo ahora, no volverás a verlo.', 'success');
    } catch (err) {
      push((err as Error).message, 'error');
    } finally {
      setCreatingToken(false);
    }
  };

  const revokeToken = async (id: string) => {
    if (!confirm('¿Revocar este token? No se podrá recuperar.')) return;
    try {
      await api.delete(`/tokens/${id}`);
      setTokens(tokens.filter((t) => t.id !== id));
      push('Token revocado', 'success');
    } catch (err) {
      push((err as Error).message, 'error');
    }
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text).then(
      () => push('Copiado al portapapeles', 'success'),
      () => push('No se pudo copiar', 'error'),
    );
  };

  const saveProfile = async () => {
    setSavingProfile(true);
    try {
      await api.patch('/auth/me', {
        fullName: form.fullName,
        timezone: form.timezone,
        workDays: form.workDays,
        workStart: form.workStart,
        workEnd: form.workEnd,
        idleAlertMin: Number(form.idleAlertMin),
        dailyDigest: form.dailyDigest,
        githubUsername: form.githubUsername || null,
        ...(form.githubToken ? { githubToken: form.githubToken } : {}),
      });
      await refreshUser();
      setForm((f) => ({ ...f, githubToken: '' }));
      push('Perfil actualizado', 'success');
    } catch (err) {
      push((err as Error).message, 'error');
    } finally {
      setSavingProfile(false);
    }
  };

  const changePassword = async () => {
    if (passwords.newPassword !== passwords.confirm) {
      push('Las contraseñas nuevas no coinciden', 'error');
      return;
    }
    setSavingPassword(true);
    try {
      await api.post('/auth/change-password', {
        currentPassword: passwords.currentPassword,
        newPassword: passwords.newPassword,
      });
      setPasswords({ currentPassword: '', newPassword: '', confirm: '' });
      push('Contraseña actualizada. Se cerraron las demás sesiones.', 'success');
    } catch (err) {
      push((err as Error).message, 'error');
    } finally {
      setSavingPassword(false);
    }
  };

  return (
    <div className="stack">
      <div>
        <h1>Mi perfil</h1>
        <p className="page-sub">Tus datos, tu jornada laboral y la configuración de tus integraciones.</p>
      </div>

      <div className="grid grid-2">
        <Card title="Datos personales">
          <div className="form-grid">
            <Field label="Nombre completo">
              <input className="input" value={form.fullName} onChange={(e) => setForm({ ...form, fullName: e.target.value })} />
            </Field>
            <Field label="Correo electrónico" hint="Solo un administrador puede cambiarlo.">
              <input className="input" value={user.email} disabled />
            </Field>
            <Field label="Rol asignado">
              <input className="input" value={`${user.role.name} (${user.role.key})`} disabled />
            </Field>
            <Field label="Supervisor">
              <input className="input" value={user.managerName ?? 'sin asignar'} disabled />
            </Field>
          </div>
        </Card>

        <Card title="Estado de la cuenta">
          <div className="stack-sm">
            <div className="row-between">
              <span className="small">Último acceso</span>
              <span className="small muted">{user.lastLoginAt ? formatDateTime(user.lastLoginAt) : '—'}</span>
            </div>
            <div className="row-between">
              <span className="small">Cuenta creada</span>
              <span className="small muted">{formatDateTime(user.createdAt)}</span>
            </div>
            <div className="row-between">
              <span className="small">Telegram</span>
              {user.telegramId ? (
                <Badge kind="badge-success">{user.telegramUsername ? `@${user.telegramUsername}` : 'vinculado'}</Badge>
              ) : (
                <Badge kind="badge-warning">sin vincular</Badge>
              )}
            </div>
            <div className="row-between">
              <span className="small">Token GitHub</span>
              {user.hasGithubToken ? <Badge kind="badge-success">configurado</Badge> : <Badge>no configurado</Badge>}
            </div>
            <div className="row-between">
              <span className="small">Permisos</span>
              <span className="tiny muted mono">
                {user.role.permissions.includes('*') ? '*' : `${user.role.permissions.length} permisos`}
              </span>
            </div>
          </div>
        </Card>
      </div>

      <Card title="Jornada laboral y alertas" hint="El bot solo envía recordatorios dentro de este horario.">
        <div className="form-grid">
          <Field label="Zona horaria" hint="Formato IANA. Ej: America/Bogota, Europe/Madrid.">
            <input className="input" value={form.timezone} onChange={(e) => setForm({ ...form, timezone: e.target.value })} />
          </Field>
          <Field label="Hora de entrada">
            <input className="input" type="time" value={form.workStart} onChange={(e) => setForm({ ...form, workStart: e.target.value })} />
          </Field>
          <Field label="Hora de salida">
            <input className="input" type="time" value={form.workEnd} onChange={(e) => setForm({ ...form, workEnd: e.target.value })} />
          </Field>
          <Field label="Recordarme si no tengo tarea (minutos)">
            <input
              className="input"
              type="number"
              min={5}
              max={480}
              value={form.idleAlertMin}
              onChange={(e) => setForm({ ...form, idleAlertMin: Number(e.target.value) })}
            />
          </Field>
        </div>
        <div className="row" style={{ marginTop: 12 }}>
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
        <label className="checkbox" style={{ marginTop: 12 }}>
          <input type="checkbox" checked={form.dailyDigest} onChange={(e) => setForm({ ...form, dailyDigest: e.target.checked })} />
          Quiero recibir el resumen diario de horas y pendientes por Telegram
        </label>
      </Card>

      <Card title="GitHub" hint="Se usan para adjuntar tus commits y PRs al cerrar una tarea.">
        <div className="form-grid">
          <Field label="Usuario de GitHub">
            <input className="input" value={form.githubUsername} onChange={(e) => setForm({ ...form, githubUsername: e.target.value })} placeholder="octocat" />
          </Field>
          <Field label="Token personal (opcional)" hint="Se guarda cifrado. Solo se actualiza si escribes uno nuevo.">
            <input
              className="input"
              type="password"
              value={form.githubToken}
              onChange={(e) => setForm({ ...form, githubToken: e.target.value })}
              placeholder={user.hasGithubToken ? '•••••• (configurado)' : 'ghp_…'}
            />
          </Field>
        </div>
      </Card>

      <div className="btn-row" style={{ justifyContent: 'flex-end' }}>
        <button className="btn btn-primary" onClick={() => void saveProfile()} disabled={savingProfile}>
          {savingProfile ? 'Guardando…' : 'Guardar perfil'}
        </button>
      </div>

      <Card title="Cambiar contraseña" hint="Al cambiarla se cierran las sesiones abiertas en otros dispositivos.">
        <div className="form-grid">
          <Field label="Contraseña actual">
            <input
              className="input"
              type="password"
              value={passwords.currentPassword}
              onChange={(e) => setPasswords({ ...passwords, currentPassword: e.target.value })}
              autoComplete="current-password"
            />
          </Field>
          <Field label="Nueva contraseña" hint="Mínimo 8 caracteres, con letras y números.">
            <input
              className="input"
              type="password"
              value={passwords.newPassword}
              onChange={(e) => setPasswords({ ...passwords, newPassword: e.target.value })}
              autoComplete="new-password"
            />
          </Field>
          <Field label="Repetir nueva contraseña">
            <input
              className="input"
              type="password"
              value={passwords.confirm}
              onChange={(e) => setPasswords({ ...passwords, confirm: e.target.value })}
              autoComplete="new-password"
            />
          </Field>
        </div>
        <div className="btn-row" style={{ marginTop: 14, justifyContent: 'flex-end' }}>
          <button
            className="btn btn-warn"
            onClick={() => void changePassword()}
            disabled={savingPassword || !passwords.currentPassword || !passwords.newPassword}
          >
            {savingPassword ? 'Actualizando…' : 'Cambiar contraseña'}
          </button>
        </div>
      </Card>

      {!user.telegramId ? (
        <Alert kind="info">
          Aún no has vinculado tu Telegram. Ve a la sección <b>Vincular Telegram</b> para empezar a registrar tiempo por voz.
        </Alert>
      ) : null}

      <Card
        title="Tokens de API"
        hint="Crea tokens personales para autenticación desde asistentes externos, scripts o herramientas. Los tokens heredan tus permisos y respetan el estado de tu cuenta."
      >
        {newlyCreatedToken && (
          <Alert kind="success" style={{ marginBottom: 16 }}>
            <div className="stack-sm">
              <p>
                <strong>¡Token creado!</strong> Cópialo ahora, no volverás a verlo:
              </p>
              <div className="row" style={{ gap: 8 }}>
                <code
                  style={{
                    flex: 1,
                    padding: 12,
                    background: 'var(--bg-2)',
                    borderRadius: 6,
                    fontSize: 14,
                    wordBreak: 'break-all',
                  }}
                >
                  {newlyCreatedToken}
                </code>
                <button className="btn btn-sm" onClick={() => copyToClipboard(newlyCreatedToken)}>
                  Copiar
                </button>
              </div>
              <button className="btn btn-sm btn-ghost" onClick={() => setNewlyCreatedToken(null)}>
                Cerrar
              </button>
            </div>
          </Alert>
        )}

        {showCreateForm && (
          <div className="stack-sm" style={{ marginBottom: 16, padding: 16, background: 'var(--bg-2)', borderRadius: 8 }}>
            <Field label="Nombre del token" hint="Ej: 'Asistente de IA', 'Script de reportes', 'CLI personal'">
              <input
                className="input"
                value={newTokenForm.name}
                onChange={(e) => setNewTokenForm({ ...newTokenForm, name: e.target.value })}
                placeholder="Mi token"
              />
            </Field>
            <Field label="Caduca en (días)" hint="Opcional. El token dejará de funcionar después de este tiempo.">
              <input
                className="input"
                type="number"
                min={1}
                max={365}
                value={newTokenForm.expiresInDays}
                onChange={(e) => setNewTokenForm({ ...newTokenForm, expiresInDays: Number(e.target.value) })}
              />
            </Field>
            <div className="btn-row">
              <button className="btn btn-sm" onClick={() => setShowCreateForm(false)}>
                Cancelar
              </button>
              <button className="btn btn-sm btn-primary" onClick={() => void createToken()} disabled={creatingToken}>
                {creatingToken ? 'Creando…' : 'Crear token'}
              </button>
            </div>
          </div>
        )}

        {!showCreateForm && (
          <button className="btn btn-sm" onClick={() => setShowCreateForm(true)} style={{ marginBottom: 16 }}>
            ➕ Crear token
          </button>
        )}

        {loadingTokens ? (
          <p className="muted small">Cargando tokens…</p>
        ) : tokens.length === 0 ? (
          <p className="muted small">No tienes tokens creados.</p>
        ) : (
          <div className="stack-sm">
            {tokens.map((token) => (
              <div
                key={token.id}
                style={{
                  padding: 12,
                  background: 'var(--bg-2)',
                  borderRadius: 6,
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  gap: 12,
                }}
              >
                <div className="stack-sm" style={{ flex: 1 }}>
                  <div className="row" style={{ gap: 8, alignItems: 'center' }}>
                    <strong>{token.name}</strong>
                    <code className="tiny mono" style={{ opacity: 0.6 }}>
                      {token.maskedToken}
                    </code>
                  </div>
                  <div className="row" style={{ gap: 12, fontSize: 13, opacity: 0.7 }}>
                    <span>Creado: {formatDateTime(token.createdAt)}</span>
                    {token.lastUsedAt && <span>Último uso: {formatDateTime(token.lastUsedAt)}</span>}
                    {token.expiresAt && <span>Caduca: {formatDateTime(token.expiresAt)}</span>}
                  </div>
                </div>
                <button className="btn btn-sm btn-warn" onClick={() => void revokeToken(token.id)}>
                  Revocar
                </button>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}

export type { SessionUser };
