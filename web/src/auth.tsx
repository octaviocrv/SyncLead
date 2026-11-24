import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';

export type Role = 'admin' | 'gestor';
export interface User { email: string; name: string; role: Role }

interface AuthState {
  user: User | null;
  loading: boolean;
  login: (identifier: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);
const unauthorizedEvent = 'synclead:unauthorized';

// Chamado pela camada de API quando o servidor responde 401 (sessão expirada).
export const notifyUnauthorized = () => window.dispatchEvent(new Event(unauthorizedEvent));

const jsonPost = (url: string, body: unknown) =>
  fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), credentials: 'same-origin' });

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch('/api/auth/me', { credentials: 'same-origin' })
      .then(async (r) => setUser(r.ok ? ((await r.json()) as { user: User }).user : null))
      .catch(() => setUser(null))
      .finally(() => setLoading(false));
    const onUnauthorized = () => setUser(null);
    window.addEventListener(unauthorizedEvent, onUnauthorized);
    return () => window.removeEventListener(unauthorizedEvent, onUnauthorized);
  }, []);

  const login = useCallback(async (identifier: string, password: string) => {
    const response = await jsonPost('/api/auth/login', { login: identifier, password });
    const body = (await response.json().catch(() => ({}))) as { user?: User; error?: string };
    if (!response.ok || !body.user) throw new Error(body.error ?? `Falha no login (HTTP ${response.status}).`);
    setUser(body.user);
  }, []);

  const logout = useCallback(async () => {
    await jsonPost('/api/auth/logout', {}).catch(() => undefined);
    setUser(null);
  }, []);

  return <AuthContext.Provider value={{ user, loading, login, logout }}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used inside AuthProvider.');
  return context;
}

export const roleLabel = (role: Role) => (role === 'admin' ? 'Administrador' : 'Gestor de tráfego');
