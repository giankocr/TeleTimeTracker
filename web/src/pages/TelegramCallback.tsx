import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, tokens } from '../lib/api';
import { useAuth, type SessionUser } from '../lib/auth';
import {
  clearPersistedLoginNext,
  getTelegramAuthOrigin,
  hasTelegramAuthHash,
  readPersistedLoginNext,
} from '../lib/telegram-oauth';

/**
 * Callback del Telegram OAuth.
 *
 * Telegram devuelve al usuario a esta página con `#tgAuthResult=...`. El hash no
 * se envía al servidor en la petición de navegación, así que se lee aquí y se
 * reenvía a `/api/auth/telegram/oauth`, que es quien verifica la firma.
 */
export default function TelegramCallbackPage() {
  const navigate = useNavigate();
  const { refreshUser } = useAuth();
  const [message, setMessage] = useState('Completando inicio de sesión con Telegram…');

  useEffect(() => {
    const next = readPersistedLoginNext() || '/';

    const fail = (text: string) => {
      setMessage(text);
      const url = new URL('/login', getTelegramAuthOrigin());
      url.searchParams.set('telegram_error', text);
      window.setTimeout(() => window.location.replace(url.toString()), 1600);
    };

    if (!hasTelegramAuthHash()) {
      fail('No recibimos los datos de Telegram. Intenta de nuevo.');
      return;
    }

    void (async () => {
      try {
        const data = await api.post<{ accessToken: string; refreshToken: string; user: SessionUser }>(
          '/auth/telegram/oauth',
          { hash: window.location.hash },
        );
        tokens.save(data);
        await refreshUser();
        clearPersistedLoginNext();
        setMessage('¡Listo! Entrando al panel…');
        navigate(next, { replace: true });
      } catch (err) {
        fail((err as Error).message);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="login-wrap">
      <div className="login-card center">
        <div className="login-logo" style={{ margin: '0 auto 16px' }}>
          ✈️
        </div>
        <p className="muted small">{message}</p>
      </div>
    </div>
  );
}
