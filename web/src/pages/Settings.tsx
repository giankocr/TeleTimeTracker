import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { WEEKDAYS, formatDateTime } from '../lib/format';
import { Alert, Badge, Card, Empty, Field, Spinner, useToast } from '../components/ui';

interface SettingRow {
  key: string;
  value: string;
  isSecret: boolean;
  isSet: boolean;
}

const SECTIONS: Array<{ title: string; hint?: string; keys: string[] }> = [
  {
    title: 'Identidad y jornada por defecto',
    hint: 'Se aplican como valores iniciales al crear usuarios nuevos.',
    keys: ['ui.company_name', 'work.default_timezone', 'work.default_days', 'work.default_start', 'work.default_end'],
  },
  {
    title: 'Alertas del bot',
    hint: 'El bot solo escribe dentro de la jornada laboral de cada usuario.',
    keys: ['alerts.enabled', 'alerts.idle_minutes', 'alerts.digest_cron'],
  },
  {
    title: 'Inteligencia artificial',
    hint: 'Whisper transcribe las notas de voz; el modelo NLU decide la intención.',
    keys: ['openai.api_key', 'openai.whisper_model', 'openai.nlu_model', 'openai.nlu_enabled'],
  },
  {
    title: 'Telegram',
    hint: 'Si cambias el token, vuelve a registrar el webhook.',
    keys: ['telegram.bot_token', 'telegram.webhook_secret'],
  },
  {
    title: 'GitHub',
    hint: 'Token global (opcional): los usuarios pueden configurar el suyo en su perfil.',
    keys: ['github.token', 'github.enrich_enabled'],
  },
  { title: 'Bot', keys: ['bot.welcome_message'] },
];

const LABELS: Record<string, string> = {
  'ui.company_name': 'Nombre de la empresa',
  'work.default_timezone': 'Zona horaria por defecto',
  'work.default_days': 'Días laborables (0=Dom … 6=Sáb)',
  'work.default_start': 'Hora de entrada por defecto',
  'work.default_end': 'Hora de salida por defecto',
  'alerts.enabled': 'Alertas activas',
  'alerts.idle_minutes': 'Minutos sin tarea antes de alertar',
  'alerts.digest_cron': 'Cron del resumen diario',
  'openai.api_key': 'OPENAI_API_KEY',
  'openai.whisper_model': 'Modelo de transcripción',
  'openai.nlu_model': 'Modelo de interpretación (NLU)',
  'openai.nlu_enabled': 'Usar IA para interpretar mensajes',
  'telegram.bot_token': 'TELEGRAM_BOT_TOKEN',
  'telegram.webhook_secret': 'TELEGRAM_WEBHOOK_SECRET',
  'github.token': 'GITHUB_TOKEN',
  'github.enrich_enabled': 'Adjuntar commits/PRs al cerrar tareas',
  'bot.welcome_message': 'Mensaje de bienvenida',
};

/** Configuración global del sistema: tokens, jornada por defecto e integraciones. */
export default function SettingsPage() {
  const { can } = useAuth();
  const { push } = useToast();
  const [settings, setSettings] = useState<SettingRow[]>([]);
  const [integration, setIntegration] = useState<any>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [logs, setLogs] = useState<any[]>([]);
  const [botMessages, setBotMessages] = useState<any[]>([]);
  // Estadisticas para la tarjeta de "Inicio de sesion con Telegram".
  const [linkedUsers, setLinkedUsers] = useState(0);
  const [totalUsers, setTotalUsers] = useState(0);
  const [withPhone, setWithPhone] = useState(0);
  const [simulateText, setSimulateText] = useState('Iniciando tarea de maquetación en el proyecto Portal Web del cliente Acme');
  const [simulation, setSimulation] = useState<any>(null);

  const canWrite = can('settings:write');
  const isBotAdmin = can('bot:admin');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get<{ settings: SettingRow[]; integration: any }>('/settings');
      setSettings(res.settings);
      setIntegration(res.integration);
      setDraft({});
      if (can('audit:read')) {
        const audit = await api.get<{ logs: any[] }>('/settings/audit', { take: 25 }).catch(() => ({ logs: [] }));
        setLogs(audit.logs);
      }
      if (can('bot:admin')) {
        const messages = await api.get<{ messages: any[] }>('/settings/bot-messages', { take: 15 }).catch(() => ({ messages: [] }));
        setBotMessages(messages.messages);
        const users = await api
          .get<{ users: Array<{ telegramId: string | null; phone: string | null }> }>('/users', { take: 500 })
          .catch(() => ({ users: [] }));
        setTotalUsers(users.users.length);
        setLinkedUsers(users.users.filter((u) => u.telegramId).length);
        setWithPhone(users.users.filter((u) => u.phone).length);
      }
    } catch (err) {
      push((err as Error).message, 'error');
    } finally {
      setLoading(false);
    }
  }, [can, push]);

  useEffect(() => {
    void load();
  }, [load]);

  const valueOf = (key: string): string => (key in draft ? draft[key]! : settings.find((s) => s.key === key)?.value ?? '');

  const save = async () => {
    setSaving(true);
    try {
      const payload: Record<string, string> = {};
      for (const [key, value] of Object.entries(draft)) {
        const original = settings.find((s) => s.key === key);
        // Si el campo secreto no se tocó, no se reenvía.
        if (original?.isSecret && value === original.value) continue;
        payload[key] = value;
      }
      if (!Object.keys(payload).length) {
        push('No hay cambios por guardar', 'info');
        setSaving(false);
        return;
      }
      await api.put('/settings', { settings: payload });
      push('Configuración guardada', 'success');
      await load();
    } catch (err) {
      push((err as Error).message, 'error');
    } finally {
      setSaving(false);
    }
  };

  const testTelegram = async () => {
    try {
      const res = await api.post<{ ok: boolean; bot?: any; error?: string }>('/settings/telegram/test');
      push(res.ok ? `Bot conectado: @${res.bot?.username}` : res.error ?? 'Error', res.ok ? 'success' : 'error');
      await load();
    } catch (err) {
      push((err as Error).message, 'error');
    }
  };

  const setWebhook = async () => {
    try {
      const res = await api.post<{ ok: boolean; error?: string }>('/settings/telegram/webhook');
      push(res.ok ? 'Webhook registrado en Telegram' : res.error ?? 'Error', res.ok ? 'success' : 'error');
      await load();
    } catch (err) {
      push((err as Error).message, 'error');
    }
  };

  const removeWebhook = async () => {
    if (!window.confirm('¿Eliminar el webhook? El bot dejará de recibir mensajes (útil si usarás long polling).')) return;
    try {
      await api.delete('/settings/telegram/webhook');
      push('Webhook eliminado', 'success');
      await load();
    } catch (err) {
      push((err as Error).message, 'error');
    }
  };

  const simulate = async () => {
    try {
      const res = await api.post<any>('/telegram/simulate', { text: simulateText });
      setSimulation(res.parsed);
    } catch (err) {
      push((err as Error).message, 'error');
    }
  };

  if (loading) return <Spinner label="Cargando configuración…" />;

  return (
    <div className="stack">
      <div className="row-between">
        <div>
          <h1>Configuración</h1>
          <p className="page-sub">Tokens de API, jornada por defecto, alertas e integraciones.</p>
        </div>
        {canWrite ? (
          <button className="btn btn-primary" onClick={() => void save()} disabled={saving || !Object.keys(draft).length}>
            {saving ? 'Guardando…' : 'Guardar cambios'}
          </button>
        ) : null}
      </div>

      {!canWrite ? <Alert kind="info">Tienes acceso de solo lectura a la configuración.</Alert> : null}

      <div className="grid grid-2">
        <Card title="Estado de integraciones">
          <div className="stack-sm">
            <div className="row-between">
              <span className="small">Bot de Telegram</span>
              {integration?.telegramConfigured ? (
                <Badge kind="badge-success">
                  {integration.bot ? `@${integration.bot.username}` : 'token configurado'}
                </Badge>
              ) : (
                <Badge kind="badge-danger">sin token</Badge>
              )}
            </div>
            <div className="row-between">
              <span className="small">Modo</span>
              <Badge kind="badge-info">{integration?.telegramMode ?? '—'}</Badge>
            </div>
            <div className="row-between">
              <span className="small">URL pública</span>
              <span className="mono tiny muted">{integration?.publicUrl ?? 'no definida (PUBLIC_URL)'}</span>
            </div>
            <div className="row-between">
              <span className="small">OpenAI (voz/NLU)</span>
              {integration?.openaiConfigured ? <Badge kind="badge-success">configurado</Badge> : <Badge kind="badge-warning">no configurado</Badge>}
            </div>
            <div className="row-between">
              <span className="small">GitHub</span>
              {integration?.githubConfigured ? <Badge kind="badge-success">configurado</Badge> : <Badge kind="badge-warning">opcional</Badge>}
            </div>
            {integration?.webhook?.url ? (
              <div className="stack-sm" style={{ marginTop: 6 }}>
                <span className="tiny muted-2">Webhook actual: <span className="mono">{integration.webhook.url}</span></span>
                {integration.webhook.last_error_message ? (
                  <Alert kind="warning">Último error de Telegram: {integration.webhook.last_error_message}</Alert>
                ) : (
                  <span className="tiny muted-2">
                    Pendientes: {integration.webhook.pending_update_count ?? 0}
                  </span>
                )}
              </div>
            ) : (
              <span className="tiny muted-2">Sin webhook registrado.</span>
            )}
          </div>

          {isBotAdmin ? (
            <div className="btn-row" style={{ marginTop: 14 }}>
              <button className="btn btn-sm" onClick={() => void testTelegram()}>
                🔌 Probar token
              </button>
              <button className="btn btn-sm btn-primary" onClick={() => void setWebhook()}>
                🔗 Registrar webhook
              </button>
              <button className="btn btn-sm btn-ghost" onClick={() => void removeWebhook()}>
                Quitar webhook
              </button>
            </div>
          ) : null}
        </Card>

        <Card title="Probar el intérprete del bot" hint="Simula una nota de voz transcrita y revisa la intención detectada.">
          <Field label="Texto de ejemplo">
            <textarea className="textarea" value={simulateText} onChange={(e) => setSimulateText(e.target.value)} />
          </Field>
          <button className="btn btn-sm" onClick={() => void simulate()}>
            ▶ Interpretar
          </button>
          {simulation ? (
            <div className="stack-sm" style={{ marginTop: 12 }}>
              <div className="row">
                <Badge kind="badge-primary">{simulation.intent}</Badge>
                <span className="tiny muted-2">
                  confianza {Math.round((simulation.confidence ?? 0) * 100)}% · motor {simulation.engine}
                </span>
              </div>
              <pre className="mono tiny" style={{ background: 'rgba(7,11,22,0.6)', padding: 12, borderRadius: 10, overflowX: 'auto', margin: 0 }}>
                {JSON.stringify(simulation.entities, null, 2)}
              </pre>
            </div>
          ) : null}
        </Card>
      </div>

      {SECTIONS.map((section) => {
        const rows = section.keys.filter((key) => settings.some((s) => s.key === key) || key in draft);
        if (!rows.length) return null;
        return (
          <Card key={section.title} title={section.title} hint={section.hint}>
            <div className="form-grid">
              {rows.map((key) => {
                const row = settings.find((s) => s.key === key);
                const current = valueOf(key);
                const isBool = ['true', 'false'].includes(current) || ['alerts.enabled', 'openai.nlu_enabled', 'github.enrich_enabled'].includes(key);
                return (
                  <Field
                    key={key}
                    label={LABELS[key] ?? key}
                    hint={row?.isSecret ? 'Guardado cifrado. Deja el valor enmascarado para no cambiarlo.' : undefined}
                  >
                    {isBool ? (
                      <label className="checkbox">
                        <input
                          type="checkbox"
                          checked={current === 'true'}
                          disabled={!canWrite}
                          onChange={(e) => setDraft({ ...draft, [key]: e.target.checked ? 'true' : 'false' })}
                        />
                        {current === 'true' ? 'Activado' : 'Desactivado'}
                      </label>
                    ) : key === 'work.default_days' ? (
                      <div className="row">
                        {WEEKDAYS.map((day, index) => {
                          const days = current.split(',').map((d) => d.trim());
                          const checked = days.includes(String(index));
                          return (
                            <label key={day} className="checkbox">
                              <input
                                type="checkbox"
                                checked={checked}
                                disabled={!canWrite}
                                onChange={(e) => {
                                  const next = e.target.checked
                                    ? [...days, String(index)]
                                    : days.filter((d) => d !== String(index));
                                  setDraft({ ...draft, [key]: next.filter(Boolean).sort().join(',') });
                                }}
                              />
                              {day}
                            </label>
                          );
                        })}
                      </div>
                    ) : (
                      <input
                        className="input"
                        type={key.includes('default_start') || key.includes('default_end') ? 'time' : row?.isSecret ? 'password' : 'text'}
                        value={current}
                        disabled={!canWrite}
                        onChange={(e) => setDraft({ ...draft, [key]: e.target.value })}
                        placeholder={row?.isSecret ? 'valor enmascarado (sin cambios)' : ''}
                      />
                    )}
                  </Field>
                );
              })}
            </div>
          </Card>
        );
      })}

      {isBotAdmin ? (
        <Card
          title="Acceso al panel con Telegram"
          hint="Tres vías: Telegram (un clic), Teléfono + código enviado por el bot, y Correo + contraseña."
        >
          <div className="stack-sm">
            <div className="row-between">
              <span className="small">Bot para el login</span>
              {integration?.bot?.username ? (
                <Badge kind="badge-success">@{integration.bot.username}</Badge>
              ) : (
                <Badge kind="badge-warning">configura el token del bot</Badge>
              )}
            </div>
            <div className="row-between">
              <span className="small">Origen autorizado (el navegador del panel)</span>
              <span className="mono tiny muted">{window.location.origin}</span>
            </div>
            <div className="row-between">
              <span className="small">Usuarios con Telegram vinculado</span>
              <Badge>
                {linkedUsers} de {totalUsers}
              </Badge>
            </div>
            <div className="row-between">
              <span className="small">Usuarios con teléfono registrado</span>
              <Badge>{withPhone} de {totalUsers}</Badge>
            </div>
          </div>

          <Alert kind="info">
            <b>No hace falta configurar /setdomain en BotFather</b> para este flujo: el botón usa la autorización
            oficial de Telegram y valida el origen en el servidor. Solo necesitas:
            <ol style={{ margin: '8px 0 0', paddingLeft: 18, lineHeight: 1.8 }}>
              <li>Guardar aquí el <b>token del bot</b> (de @BotFather).</li>
              <li>
                Que cada usuario <b>vincule su Telegram</b>: abre el bot, toca <span className="mono">/start</span> y
                pulsa <b>📱 Compartir mi número</b> (o usa el código de vinculación del panel).
              </li>
              <li>
                Que su <b>teléfono</b> esté registrado en su usuario (columna «Teléfono» en Usuarios) para poder entrar
                con «Teléfono + código».
              </li>
            </ol>
            En producción el panel debe servirse por <b>HTTPS</b> para que Telegram acepte el retorno.
          </Alert>

          <p className="tiny muted-2">
            Seguridad: el servidor recomputa la firma HMAC-SHA256 con el token del bot, rechaza autorizaciones de más
            de 1 hora, compara en tiempo constante y exige que la cuenta esté vinculada y activa. Los códigos OTP duran
            10 minutos, son de un solo uso, admiten 5 intentos y se guardan cifrados (SHA-256).
          </p>
        </Card>
      ) : null}

      {can('bot:admin') ? (
        <Card title="Últimos mensajes recibidos por el bot" hint="Trazabilidad del NLU: útil para afinar alias y nombres de proyectos.">
          {botMessages.length ? (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Fecha</th>
                    <th>Usuario</th>
                    <th>Tipo</th>
                    <th>Texto / transcripción</th>
                    <th>Intención</th>
                    <th className="right">ms</th>
                  </tr>
                </thead>
                <tbody>
                  {botMessages.map((m) => (
                    <tr key={m.id}>
                      <td className="tiny nowrap">{formatDateTime(m.createdAt)}</td>
                      <td className="small">{m.user?.fullName ?? m.telegramId ?? '—'}</td>
                      <td><Badge>{m.kind}</Badge></td>
                      <td className="small" style={{ maxWidth: 320 }}>
                        {m.transcript ?? m.rawText ?? '—'}
                      </td>
                      <td className="small">
                        {m.intent ? <Badge kind={m.ok ? 'badge-success' : 'badge-danger'}>{m.intent}</Badge> : '—'}
                        {m.error ? <div className="tiny" style={{ color: '#f87171' }}>{m.error.slice(0, 80)}</div> : null}
                      </td>
                      <td className="right tiny muted">{m.latencyMs ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <Empty>Aún no hay mensajes registrados. Escribe algo al bot y pulsa actualizar.</Empty>
          )}
          <button className="btn btn-sm" style={{ marginTop: 12 }} onClick={() => void load()}>
            ↻ Actualizar
          </button>
        </Card>
      ) : null}

      {can('audit:read') ? (
        <Card title="Auditoría" hint="Últimas acciones sobre el sistema">
          {logs.length ? (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Fecha</th>
                    <th>Usuario</th>
                    <th>Acción</th>
                    <th>Entidad</th>
                    <th>IP</th>
                  </tr>
                </thead>
                <tbody>
                  {logs.map((l) => (
                    <tr key={l.id}>
                      <td className="tiny nowrap">{formatDateTime(l.createdAt)}</td>
                      <td className="small">{l.user?.fullName ?? '—'}</td>
                      <td className="small mono">{l.action}</td>
                      <td className="small muted">{l.entity ?? '—'}</td>
                      <td className="tiny muted-2 mono">{l.ip ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <Empty>Sin eventos de auditoría.</Empty>
          )}
        </Card>
      ) : null}
    </div>
  );
}
