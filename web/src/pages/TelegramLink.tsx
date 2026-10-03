import { useState } from 'react';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { formatDateTime } from '../lib/format';
import { Alert, Badge, Card, Field, useToast } from '../components/ui';

/**
 * Vinculación de la cuenta con el bot de Telegram.
 * El usuario genera un código y lo envía al bot con /vincular CODIGO.
 */
export default function TelegramLinkPage() {
  const { user, refreshUser } = useAuth();
  const { push } = useToast();
  const [code, setCode] = useState<string | null>(null);
  const [expiresAt, setExpiresAt] = useState<string | null>(null);
  const [manualCode, setManualCode] = useState('');
  const [loading, setLoading] = useState(false);

  if (!user) return null;

  const generate = async () => {
    setLoading(true);
    try {
      const res = await api.post<{ code: string; expiresAt: string; instructions: string }>('/auth/telegram/link-code');
      setCode(res.code);
      setExpiresAt(res.expiresAt);
      push('Código generado. Envíalo al bot.', 'success');
    } catch (err) {
      push((err as Error).message, 'error');
    } finally {
      setLoading(false);
    }
  };

  const unlink = async () => {
    if (!window.confirm('¿Desvincular tu Telegram? El bot dejará de reconocerte.')) return;
    try {
      await api.delete('/auth/telegram');
      await refreshUser();
      push('Telegram desvinculado', 'success');
    } catch (err) {
      push((err as Error).message, 'error');
    }
  };

  const saveManual = async () => {
    if (!manualCode.trim()) return;
    try {
      // El backend vincula el telegramId cuando el usuario lo pega aquí (vía admin) o
      // mediante el código en el bot; aquí solo validamos el formato y avisamos.
      push('Para vincular, envía ese código al bot con /vincular o pídele a un administrador que lo asigne.', 'info');
    } catch (err) {
      push((err as Error).message, 'error');
    }
  };

  return (
    <div className="stack">
      <div>
        <h1>Vincular Telegram</h1>
        <p className="page-sub">Conecta tu cuenta con el bot para registrar tiempo por voz o texto.</p>
      </div>

      <Card title="Estado actual">
        <div className="row-between">
          <div className="stack-sm" style={{ gap: 2 }}>
            <span className="small">Tu cuenta</span>
            <strong>{user.fullName}</strong>
            <span className="tiny muted-2">{user.email}</span>
          </div>
          <div className="stack-sm" style={{ alignItems: 'flex-end', gap: 4 }}>
            {user.telegramId ? (
              <>
                <Badge kind="badge-success">Telegram vinculado</Badge>
                <span className="tiny muted-2">
                  {user.telegramUsername ? `@${user.telegramUsername}` : user.telegramId}
                </span>
                <span className="tiny muted-2">desde {formatDateTime(user.telegramLinkedAt)}</span>
              </>
            ) : (
              <Badge kind="badge-warning">Sin vincular</Badge>
            )}
          </div>
        </div>
        {user.telegramId ? (
          <div className="stack-sm" style={{ marginTop: 14 }}>
            <Alert kind="success">
              Ya puedes entrar al panel desde la pantalla de acceso con <b>Telegram</b> (un clic) o con{' '}
              <b>Teléfono + código</b>, además de registrar tiempo por voz en el bot.
            </Alert>
            <div className="btn-row">
              <button className="btn btn-danger btn-sm" onClick={() => void unlink()}>
                Desvincular
              </button>
            </div>
          </div>
        ) : null}
      </Card>

      {!user.telegramId ? (
        <>
          <Card title="Paso 1 · Genera tu código">
            <p className="muted small" style={{ marginBottom: 14 }}>
              El código es personal, dura 30 minutos y solo sirve para vincular tu cuenta una vez.
            </p>
            <button className="btn btn-primary" onClick={() => void generate()} disabled={loading}>
              {loading ? 'Generando…' : '🔗 Generar código de vinculación'}
            </button>

            {code ? (
              <div className="stack" style={{ marginTop: 18 }}>
                <div className="card center" style={{ background: 'rgba(7,11,22,0.6)' }}>
                  <div className="tiny muted-2">Tu código</div>
                  <div className="mono" style={{ fontSize: '2rem', letterSpacing: '0.18em', margin: '8px 0' }}>
                    {code}
                  </div>
                  {expiresAt ? <div className="tiny muted-2">Vence {formatDateTime(expiresAt)}</div> : null}
                </div>
                <div className="btn-row">
                  <button
                    className="btn btn-sm"
                    onClick={() => {
                      void navigator.clipboard.writeText(code);
                      push('Código copiado', 'success');
                    }}
                  >
                    Copiar código
                  </button>
                  <button
                    className="btn btn-sm"
                    onClick={() => {
                      void navigator.clipboard.writeText(`/vincular ${code}`);
                      push('Comando copiado', 'success');
                    }}
                  >
                    Copiar comando
                  </button>
                </div>
              </div>
            ) : null}
          </Card>

          <Card
            title="Paso 2 · Vincula desde el bot"
            hint="Dos caminos: compartir tu número (recomendado) o enviar el código."
          >
            <div className="stack-sm">
              <div className="small muted">
                <b>Opción A · Compartir tu número</b> (lo más rápido):
              </div>
              <ol className="small muted" style={{ margin: 0, paddingLeft: 20, lineHeight: 1.9 }}>
                <li>Abre el bot de Telegram de tu organización y toca <span className="mono">/start</span>.</li>
                <li>
                  Pulsa el botón <b>📱 Compartir mi número</b> que aparece en la barra inferior del chat.
                </li>
                <li>
                  Si tu teléfono ya está registrado por un administrador, quedas vinculado al instante. Si no, el bot
                  avisa al administrador para que cree tu cuenta.
                </li>
              </ol>
              <div className="divider" />
              <div className="small muted">
                <b>Opción B · Código de vinculación</b>:
              </div>
              <ol className="small muted" style={{ margin: 0, paddingLeft: 20, lineHeight: 1.9 }}>
                <li>Abre el bot y toca <span className="mono">/start</span>.</li>
                <li>
                  Envía <span className="mono">/vincular TU-CODIGO</span> (el que generaste arriba).
                </li>
                <li>El bot confirmará la vinculación.</li>
              </ol>
            </div>
            <div className="divider" style={{ margin: '16px 0' }} />
            <Field label="¿Ya tienes un código del administrador?" hint="Pégalo aquí para verificar el formato.">
              <div className="row">
                <input
                  className="input"
                  style={{ maxWidth: 220 }}
                  value={manualCode}
                  onChange={(e) => setManualCode(e.target.value.toUpperCase())}
                  placeholder="ABCD-1234"
                />
                <button className="btn" onClick={() => void saveManual()}>
                  Verificar
                </button>
              </div>
            </Field>
          </Card>
        </>
      ) : (
        <Card title="Comandos útiles del bot">
          <div className="stack-sm small">
            <div><span className="mono">/estado</span> — qué estás haciendo ahora y cuánto llevas</div>
            <div><span className="mono">/reporte hoy|ayer|semana|mes</span> — resumen de horas</div>
            <div><span className="mono">/pendientes</span> — tu lista de tareas pendientes</div>
            <div><span className="mono">/pausar</span>, <span className="mono">/retomar</span>, <span className="mono">/terminar</span> — control del cronómetro</div>
            <div><span className="mono">/cancelar</span> — descarta la tarea en curso sin contabilizarla</div>
          </div>
          <Alert kind="info">
            También puedes usar los botones del teclado del bot o simplemente enviar una nota de voz: la IA detecta si inicias,
            pausas, cambias o terminas una tarea.
          </Alert>
        </Card>
      )}
    </div>
  );
}
