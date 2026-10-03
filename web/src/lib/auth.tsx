import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, tokens, onUnauthorized } from '../lib/api';

/** Usuario tal como lo devuelve /api/auth/me */
export interface SessionUser {
  id: string;
  email: string;
  fullName: string;
  isActive: boolean;
  role: { id: string; key: string; name: string; permissions: string[] };
  telegramId: string | null;
  telegramUsername: string | null;
  telegramLinkedAt: string | null;
  phone: string | null;
  phoneVerifiedAt: string | null;
  githubUsername: string | null;
  hasGithubToken: boolean;
  timezone: string;
  workDays: number[];
  workStart: string;
  workEnd: string;
  idleAlertMin: number;
  dailyDigest: boolean;
  managerId: string | null;
  managerName?: string | null;
  lastLoginAt: string | null;
  createdAt: string;
}

interface AuthState {
  user: SessionUser | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  refreshUser: () => Promise<void>;
  can: (permission: string) => boolean;
  isRole: (...roles: string[]) => boolean;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<SessionUser | null>(() => tokens.cachedUser);
  const [loading, setLoading] = useState(true);

  const refreshUser = useCallback(async () => {
    if (!tokens.access) {
      setUser(null);
      return;
    }
    try {
      const data = await api.get<{ user: SessionUser }>('/auth/me');
      setUser(data.user);
      tokens.saveUser(data.user);
    } catch {
      tokens.clear();
      setUser(null);
    }
  }, []);

  // Carga inicial: valida el token guardado contra el backend.
  useEffect(() => {
    void (async () => {
      await refreshUser();
      setLoading(false);
    })();
  }, [refreshUser]);

  // Cuando el cliente HTTP detecta un 401 definitivo, se limpia la sesion.
  useEffect(() => {
    onUnauthorized.handler = () => setUser(null);
    return () => {
      onUnauthorized.handler = null;
    };
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    const data = await api.post<{ accessToken: string; refreshToken: string; user: SessionUser }>('/auth/login', {
      email,
      password,
    });
    tokens.save(data);
    setUser(data.user);
  }, []);

  const logout = useCallback(async () => {
    try {
      await api.post('/auth/logout');
    } catch {
      /* la sesion se limpia igual */
    }
    tokens.clear();
    setUser(null);
  }, []);

  const can = useCallback(
    (permission: string): boolean => {
      if (!user) return false;
      const perms = user.role?.permissions ?? [];
      if (perms.includes('*') || perms.includes(permission)) return true;
      const [ns, action] = permission.split(':');
      return perms.includes(`${ns}:*`) || perms.includes(`${ns}:${action}:*`);
    },
    [user],
  );

  const isRole = useCallback((...roles: string[]) => (user ? roles.includes(user.role.key) : false), [user]);

  const value = useMemo<AuthState>(
    () => ({ user, loading, login, logout, refreshUser, can, isRole }),
    [user, loading, login, logout, refreshUser, can, isRole],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth debe usarse dentro de <AuthProvider>');
  return ctx;
}
