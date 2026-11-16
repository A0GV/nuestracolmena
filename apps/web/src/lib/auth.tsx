import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { message } from 'antd';
import { loginRequest, meRequest, ORG_KEY, TOKEN_KEY, api } from './api';

export interface SessionUser {
  id: string;
  login: string;
  name: string;
  email?: string;
  type?: string;
  activeOrganisation?: string;
  profile?: string;
  permissions: string[];
  organisations: { id: string; name: string; profile: string; isDefault: boolean }[];
}

interface AuthContextValue {
  user: SessionUser | null;
  loading: boolean;
  login: (login: string, password: string) => Promise<void>;
  logout: () => void;
  switchOrganisation: (name: string) => Promise<void>;
  refresh: () => Promise<void>;
  can: (permission?: string | string[]) => boolean;
}

const AuthContext = createContext<AuthContextValue>(null as any);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = async () => {
    const token = localStorage.getItem(TOKEN_KEY);
    if (!token) {
      setUser(null);
      setLoading(false);
      return;
    }
    try {
      const me = await meRequest();
      setUser(me);
      if (!localStorage.getItem(ORG_KEY) && me.activeOrganisation) {
        localStorage.setItem(ORG_KEY, me.activeOrganisation);
      }
    } catch {
      setUser(null);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    refresh();
  }, []);

  const login = async (loginValue: string, password: string) => {
    const data = await loginRequest(loginValue, password);
    localStorage.setItem(TOKEN_KEY, data.token);
    localStorage.setItem(ORG_KEY, data.activeOrganisation);
    const me = await meRequest();
    setUser(me);
  };

  const logout = () => {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(ORG_KEY);
    setUser(null);
    window.location.href = '/login';
  };

  const switchOrganisation = async (name: string) => {
    const { data } = await api.post('/auth/organisation', { organisation: name });
    localStorage.setItem(TOKEN_KEY, data.token);
    localStorage.setItem(ORG_KEY, data.activeOrganisation);
    await refresh();
    message.success(`Organisation: ${data.activeOrganisation}`);
  };

  const can = (permission?: string | string[]) => {
    if (!permission) return true;
    if (!user) return false;
    const required = Array.isArray(permission) ? permission : [permission];
    return required.every((p) => user.permissions?.includes(p));
  };

  const value = useMemo(
    () => ({ user, loading, login, logout, switchOrganisation, refresh, can }),
    [user, loading],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  return useContext(AuthContext);
}
