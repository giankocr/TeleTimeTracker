import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { api, tokens } from '../lib/api';
import { useAuth, type SessionUser } from '../lib/auth';
import { Alert } from '../components/ui';
import {
  buildTelegramOAuthUrl,
  clearPersistedLoginNext,
  getTelegramAuthOrigin,
  hasTelegramAuthHash,
  isTelegramWebView,
  persistLoginNext,
  readPersistedLoginNext,
  sanitizeNext,
} from '../lib/telegram-oauth';

const ATTEMPTS_KEY = 'ttt.login.attempts';

type Mode = 'telegram' | 'phone' | 'email';

interface LoginConfig {
  companyName: string;
  telegram: {
    enabled: boolean;
    botId: string | null;
    botUsername: string | null;
    /**
     * 'oidc'   = librería oficial telegram-login.js (popup + id_token)  [recomendado]
     * 'widget' = widget iframe legacy (HMAC + /setdomain)  [en desuso]
     * 'oauth'  = redirección oauth.telegram.org sin OIDC  [en desuso]
     */
    loginMode: 'oidc' | 'widget' | 'oauth';
    clientId: string | null;
    clientIdFromBotFather: boolean;
    oidcConfigured: boolean;
    /** URL que Telegram exige registrar en BotFather (Allowed URL). */
    webRedirectUri: string;
  };
  phoneOtp: { enabled: boolean };
}

/**
 * Pantalla de acceso con tres vías, igual que en NosotrosConstruimos:
 *   1) Telegram (un clic, Telegram OAuth)
 *   2) Teléfono + código enviado por el bot
 *   3) Correo + contraseña (administradores)
 *
 * Dentro del navegador de Telegram se prioriza el código: el botón de OAuth
 * suele devolver al usuario a la app de Telegram y se pierde el retorno.
 */
export default function LoginPage() {
  const { login, refreshUser } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  const next = sanitizeNext(new URLSearchParams(location.search).get('next') || readPersistedLoginNext() || '/');

  const [config, setConfig] = useState<LoginConfig | null>(null);
  const widgetRef = useRef<HTMLDivElement | null>(null);
  const [mode, setMode] = useState<Mode>('telegram');
  const [inTelegramWebView, setInTelegramWebView] = useState(false);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Correo + contraseña
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  // Teléfono + OTP
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [otpSentTo, setOtpSentTo] = useState<string | null>(null);

  const attempts = Number(sessionStorage.getItem(ATTEMPTS_KEY) ?? '0');
  const telegramUrlNext = new URLSearchParams(location.search).get('next');
  const telegramError = new URLSearchParams(location.search).get('telegram_error');

  useEffect(() => {
    persistLoginNext(telegramUrlNext ?? next);
  }, [next, telegramUrlNext]);

  useEffect(() => {
    if (telegramError) setError(telegramError);
  }, [telegramError]);

  // Configuración pública + detección de WebView de Telegram.
  useEffect(() => {
    const webView = isTelegramWebView();
    setInTelegramWebView(webView);
    if (webView) setMode('phone');
    void (async () => {
      try {
        const res = await api.get<LoginConfig>('/auth/config');
        setConfig(res);
      } catch {
        setConfig(null);
      }
    })();
  }, []);

  /** Guarda la sesión y entra al panel. */
  const finishLogin = async (data: { accessToken: string; refreshToken: string; user: SessionUser }) => {
    tokens.save(data);
    await refreshUser();
    clearPersistedLoginNext();
    sessionStorage.removeItem(ATTEMPTS_KEY);
    navigate(next, { replace: true });
  };

  // Si Telegram deja el resultado en el hash de esta misma página, se reenvía.
  useEffect(() => {
    if (!hasTelegramAuthHash()) return;
    void (async () => {
      setBusy(true);
      setNotice('Completando inicio de sesión con Telegram…');
      try {
        const data = await api.post<{ accessToken: string; refreshToken: string; user: SessionUser }>(
          '/auth/telegram/oauth',
          { hash: window.location.hash },
        );
        await finishLogin(data);
      } catch (err) {
        setError((err as Error).message);
        setNotice(null);
        window.history.replaceState(null, '', window.location.pathname);
      } finally {
        setBusy(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // El widget oficial responde en un iframe/popup y nos avisa por postMessage.
  useEffect(() => {
    if (config?.telegram.loginMode !== 'widget') return;
    const onMessage = (event: MessageEvent) => {
      // Solo se aceptan mensajes de nuestro propio origen.
      if (event.origin !== window.location.origin) return;
      const payload = event.data as
        | { type?: string; data?: { accessToken: string; refreshToken: string; user: SessionUser }; error?: string }
        | undefined;
      if (!payload || payload.type !== 'ttt-telegram-widget-auth') return;
      if (payload.error) {
        setError(payload.error);
        return;
      }
      if (payload.data) void finishLogin(payload.data);
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config?.telegram.loginMode]);

  // --- Modo OIDC: librería oficial telegram-login.js (popup + id_token) ---
  useEffect(() => {
    if (config?.telegram.loginMode !== 'oidc') return;
    const clientId = config.telegram.clientId;
    const container = widgetRef.current;
    if (!clientId || !container) return;

    let cancelled = false;
    const SRC = 'https://telegram.org/js/telegram-login.js?5';

    const onAuth = async (result: { id_token?: string; user?: unknown; error?: string }) => {
      if (result?.error) {
        const raw = result.error;
        // Telegram responde esto cuando la URL del panel no esta registrada en
        // BotFather -> Login Widget -> Allowed URLs.
        if (/redirect_uri/i.test(raw)) {
          setError(
            `Telegram rechazó la URL del panel: hay que registrarla en BotFather → Login Widget → Allowed URLs → ${config?.telegram.webRedirectUri ?? window.location.origin + '/login'}`,
          );
        } else {
          setError(raw);
        }
        return;
      }
      if (!result?.id_token) {
        setError('Telegram no devolvió el id_token. Intenta de nuevo.');
        return;
      }
      setBusy(true);
      try {
        const data = await api.post<{ accessToken: string; refreshToken: string; user: SessionUser }>(
          '/auth/telegram/oidc',
          { idToken: result.id_token },
        );
        await finishLogin(data);
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setBusy(false);
      }
    };

    const init = () => {
      const lib = (window as any).Telegram?.Login;
      if (!lib) {
        setError('No se pudo cargar la librería de Telegram. Revisa tu conexión o usa «Teléfono + código».');
        return;
      }
      // init() registra el callback; el botón se dibuja dentro del contenedor.
      lib.init(
        { client_id: Number(clientId), scope: ['profile', 'phone'], lang: 'es' },
        onAuth,
      );
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn btn-block';
      btn.style.cssText = 'background:#2AABEE;border-color:transparent;color:#fff';
      btn.innerHTML = '<span style="display:inline-flex;align-items:center;gap:8px">Entrar con Telegram</span>';
      btn.onclick = () => lib.open(onAuth);
      container.replaceChildren(btn);
    };

    const existing = document.querySelector<HTMLScriptElement>(`script[src^="https://telegram.org/js/telegram-login.js"]`);
    if (existing) {
      if ((window as any).Telegram?.Login) init();
      else existing.addEventListener('load', init, { once: true });
    } else {
      const script = document.createElement('script');
      script.src = SRC;
      script.async = true;
      script.addEventListener('load', init, { once: true });
      script.addEventListener('error', () =>
        setError('No se pudo cargar telegram-login.js. Puedes entrar con «Teléfono + código».'),
      );
      document.head.appendChild(script);
    }

    return () => {
      cancelled = true;
      void cancelled;
      container.replaceChildren();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config?.telegram.loginMode, config?.telegram.clientId]);

  // Inyecta el script del widget iframe legacy (Telegram sustituye el div por el botón).
  useEffect(() => {
    const telegram = config?.telegram;
    if (telegram?.loginMode !== 'widget' || !telegram.botUsername || !widgetRef.current) return;

    const container = widgetRef.current;
    container.replaceChildren();
    const script = document.createElement('script');
    script.src = 'https://telegram.org/js/telegram-widget.js?22';
    script.async = true;
    script.setAttribute('data-telegram-login', telegram.botUsername);
    script.setAttribute('data-size', 'large');
    script.setAttribute('data-radius', '9');
    script.setAttribute('data-request-access', 'write');
    // Los datos llegan por POST (form-urlencoded) a este endpoint, que responde
    // HTML y nos devuelve la sesión por postMessage.
    script.setAttribute('data-auth-url', `${window.location.origin}/api/auth/telegram/widget`);
    container.appendChild(script);

    return () => container.replaceChildren();
  }, [config?.telegram.loginMode, config?.telegram.botUsername]);

  const startTelegramLogin = () => {
    const botId = config?.telegram.botId;
    if (!botId) {
      setError('Falta configurar el bot de Telegram (token) en el panel.');
      return;
    }
    setError(null);
    persistLoginNext(next);
    window.location.href = buildTelegramOAuthUrl(botId, getTelegramAuthOrigin());
  };

  const submitEmail = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await login(email.trim(), password);
      clearPersistedLoginNext();
      sessionStorage.removeItem(ATTEMPTS_KEY);
      navigate(next, { replace: true });
    } catch (err) {
      setError((err as Error).message);
      sessionStorage.setItem(ATTEMPTS_KEY, String(attempts + 1));
    } finally {
      setBusy(false);
    }
  };

  const requestOtp = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      const res = await api.post<{ maskedPhone: string; expiresInMinutes: number; message: string }>('/auth/phone/request', {
        phone: phone.trim(),
      });
      setOtpSentTo(res.maskedPhone);
      setCode('');
      setNotice(`Te enviamos un código de 6 números a ${res.maskedPhone} por Telegram. Caduca en ${res.expiresInMinutes} minutos.`);
    } catch (err) {
      const apiError = err as Error & { code?: string };
      setError(apiError.message);
      if ((apiError as any).needsTelegram) setNotice(null);
    } finally {
      setBusy(false);
    }
  };

  const verifyOtp = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const data = await api.post<{ accessToken: string; refreshToken: string; user: SessionUser }>('/auth/phone/verify', {
        phone: phone.trim(),
        code: code.trim(),
      });
      await finishLogin(data);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const telegramReady = Boolean(config?.telegram.enabled && config.telegram.botId);
  const modes: Array<{ key: Mode; label: string; enabled: boolean }> = [
    { key: 'telegram', label: 'Telegram', enabled: true },
    { key: 'phone', label: 'Teléfono + código', enabled: Boolean(config?.phoneOtp.enabled) },
    { key: 'email', label: 'Correo', enabled: true },
  ];

  return (
    <div className="login-wrap">
      <div className="login-card">
        <div className="login-logo">⏱</div>
        <h1>{config?.companyName || 'TeleTimeTracker'}</h1>
        <p className="muted small" style={{ marginTop: 6, marginBottom: 18 }}>
          Panel de administración · control de tiempo con bot de Telegram
        </p>

        <div className="row" style={{ gap: 6, marginBottom: 18 }}>
          {modes
            .filter((m) => m.enabled)
            .map((m) => (
              <button
                key={m.key}
                type="button"
                className={mode === m.key ? 'btn btn-sm btn-primary' : 'btn btn-sm btn-ghost'}
                onClick={() => {
                  setMode(m.key);
                  setError(null);
                }}
              >
                {m.label}
              </button>
            ))}
        </div>

        {inTelegramWebView ? (
          <div style={{ marginBottom: 14 }}>
            <Alert kind="info">
              Estás dentro de Telegram. Usa <b>Teléfono + código</b>: el botón de Telegram suele devolverte a la app y se
              pierde el retorno al panel.
            </Alert>
          </div>
        ) : null}

        {error ? (
          <div style={{ marginBottom: 14 }}>
            <Alert kind="error">{error}</Alert>
          </div>
        ) : null}
        {notice ? (
          <div style={{ marginBottom: 14 }}>
            <Alert kind="info">{notice}</Alert>
          </div>
        ) : null}

        {/* ---------------------------- TELEGRAM ---------------------------- */}
        {mode === 'telegram' ? (
          <div className="stack">
            {telegramReady ? (
              <>
                <p className="small muted">
                  Entra con tu cuenta de Telegram ya vinculada. No necesitas recordar contraseña.
                </p>

                {config?.telegram.loginMode === 'oidc' ? (
                  <>
                    {/* Librería oficial (OIDC): popup + id_token verificado con JWKS. */}
                    <div ref={widgetRef} style={{ display: 'flex', justifyContent: 'center', minHeight: 48 }} />
                    {!config.telegram.clientIdFromBotFather ? (
                      <Alert kind="warning">
                        <b>Falta el Client ID de BotFather.</b> En Telegram el botón puede fallar con
                        «redirect_uri required» hasta que lo configures:
                        <ol style={{ margin: '6px 0 0', paddingLeft: 18, lineHeight: 1.7 }}>
                          <li>
                            <span className="mono">@BotFather</span> → <span className="mono">/mybots</span> → tu bot →{' '}
                            <b>Login Widget</b>
                          </li>
                          <li>
                            Añade esta <b>Allowed URL</b>:{' '}
                            <span className="mono">{config.telegram.webRedirectUri || `${window.location.origin}/login`}</span>
                          </li>
                          <li>
                            Copia el <b>Client ID</b> en <i>Configuración → TELEGRAM_LOGIN_CLIENT_ID</i>
                          </li>
                        </ol>
                      </Alert>
                    ) : (
                      <p className="tiny muted-2" style={{ textAlign: 'center' }}>
                        Si Telegram responde «redirect_uri required», añade esta URL en BotFather → Login Widget → Allowed
                        URLs: <span className="mono">{config.telegram.webRedirectUri}</span>
                      </p>
                    )}
                  </>
                ) : config?.telegram.loginMode === 'widget' ? (
                  <>
                    {/* Widget oficial de Telegram: requiere el dominio registrado en BotFather (/setdomain). */}
                    <div ref={widgetRef} style={{ display: 'flex', justifyContent: 'center', minHeight: 48 }} />
                    <p className="tiny muted-2" style={{ textAlign: 'center' }}>
                      ¿No ves el botón? El dominio debe estar registrado en BotFather con{' '}
                      <span className="mono">/setdomain</span>. Mientras tanto usa la pestaña{' '}
                      <b>Teléfono + código</b>.
                    </p>
                  </>
                ) : (
                  <>
                    <button type="button" className="btn btn-block" onClick={startTelegramLogin} disabled={busy} style={{ background: '#2AABEE', borderColor: 'transparent', color: '#fff' }}>
                      <TelegramLogo />
                      {busy ? 'Completando…' : 'Entrar con Telegram'}
                    </button>
                    <p className="tiny muted-2" style={{ textAlign: 'center' }}>
                      Si aún no vinculaste tu cuenta, abre el bot {config?.telegram.botUsername ? `(@${config.telegram.botUsername})` : ''} y toca{' '}
                      <b>📱 Compartir mi número</b>.
                    </p>
                  </>
                )}
              </>
            ) : (
              <Alert kind="warning">
                El bot de Telegram aún no está configurado. Un administrador debe guardar el <b>token del bot</b> en
                Configuración. Mientras tanto puedes entrar con <b>Correo</b>.
              </Alert>
            )}
          </div>
        ) : null}

        {/* ------------------------- TELÉFONO + OTP ------------------------- */}
        {mode === 'phone' ? (
          otpSentTo ? (
            <form className="stack" onSubmit={verifyOtp}>
              <p className="small muted">
                Abre Telegram y busca el mensaje del bot con tu código de 6 números, luego escríbelo aquí.
              </p>
              <div className="field">
                <label htmlFor="otp">Código de 6 dígitos</label>
                <input
                  id="otp"
                  className="input mono"
                  inputMode="numeric"
                  pattern="[0-9]{6}"
                  maxLength={6}
                  autoComplete="one-time-code"
                  required
                  autoFocus
                  value={code}
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
                  placeholder="123456"
                  style={{ textAlign: 'center', fontSize: '1.5rem', letterSpacing: '0.35em' }}
                />
              </div>
              <button className="btn btn-primary btn-block" type="submit" disabled={busy || code.length !== 6}>
                {busy ? 'Comprobando…' : 'Entrar'}
              </button>
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => { setOtpSentTo(null); setNotice(null); setError(null); }}>
                  Cambiar número
                </button>
                <button type="button" className="btn btn-ghost btn-sm" onClick={(e) => void requestOtp(e)} disabled={busy}>
                  Reenviar código
                </button>
              </div>
            </form>
          ) : (
            <form className="stack" onSubmit={requestOtp}>
              <p className="small muted">
                Escribe el mismo número que registró tu administrador. Te enviamos un código por el bot de Telegram — sin
                contraseñas.
              </p>
              <div className="field">
                <label htmlFor="phone">Tu teléfono</label>
                <input
                  id="phone"
                  className="input"
                  type="tel"
                  inputMode="tel"
                  required
                  autoFocus
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  placeholder="+57 300 123 4567"
                />
                <span className="tiny muted-2">Si lo escribes sin prefijo se asume Colombia (+57).</span>
              </div>
              <button className="btn btn-primary btn-block" type="submit" disabled={busy || phone.trim().length < 7}>
                {busy ? 'Enviando…' : 'Enviarme el código'}
              </button>
              <p className="tiny muted-2" style={{ textAlign: 'center' }}>
                ¿Aún no vinculaste Telegram? Abre el bot, toca <b>/start</b> y comparte tu número.
              </p>
            </form>
          )
        ) : null}

        {/* ----------------------------- CORREO ----------------------------- */}
        {mode === 'email' ? (
          <form className="stack" onSubmit={submitEmail}>
            <p className="small muted">Acceso con correo para administradores y supervisores.</p>
            <div className="field">
              <label htmlFor="email">Correo electrónico</label>
              <input
                id="email"
                className="input"
                type="email"
                autoComplete="username"
                required
                autoFocus
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="admin@tudominio.com"
              />
            </div>
            <div className="field">
              <label htmlFor="password">Contraseña</label>
              <input
                id="password"
                className="input"
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
              />
            </div>
            <button className="btn btn-primary btn-block" type="submit" disabled={busy}>
              {busy ? 'Verificando…' : 'Entrar'}
            </button>
            {attempts >= 1 ? (
              <p className="tiny muted-2" style={{ textAlign: 'center' }}>
                Si olvidaste tu contraseña, pide a un administrador que la restablezca desde el panel de Usuarios.
              </p>
            ) : null}
          </form>
        ) : null}
      </div>
    </div>
  );
}

/** Logotipo oficial de Telegram (avión de papel). */
function TelegramLogo() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true">
      <path d="M12 0C5.373 0 0 5.373 0 12s5.373 12 12 12 12-5.373 12-12S18.627 0 12 0zm5.562 8.161c-.18 1.897-.962 6.502-1.359 8.627-.168.9-.5 1.201-.82 1.23-.697.064-1.226-.461-1.901-.903-1.056-.693-1.653-1.124-2.678-1.799-1.185-.781-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.139-5.062 3.345-.479.329-.913.489-1.302.481-.428-.009-1.252-.242-1.865-.442-.752-.244-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.831-2.529 6.998-3.014 3.333-1.386 4.025-1.627 4.477-1.635.099-.002.321.023.465.141a.51.51 0 0 1 .171.325c.016.093.003.229-.001.359z" />
    </svg>
  );
}
