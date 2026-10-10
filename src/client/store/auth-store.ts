import { create } from 'zustand';
import { apiUrl } from '../services/api-config';

interface UserInfo {
  id: number;
  username: string;
  account: string;
  last_login_at: string | null;
  last_logout_at: string | null;
}

interface AuthStore {
  token: string | null;
  user: UserInfo | null;
  isChecking: boolean;

  login: (account: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  checkAuth: () => Promise<void>;
}

export const useAuthStore = create<AuthStore>((set, get) => ({
  token: localStorage.getItem('myagent_token'),
  user: null,
  isChecking: true,

  login: async (account, password) => {
    const res = await fetch(apiUrl('/api/auth/login'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ account, password }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '登录失败');

    localStorage.setItem('myagent_token', data.token);
    set({ token: data.token, user: data.user });
  },

  logout: async () => {
    const { token } = get();
    try {
      await fetch(apiUrl('/api/auth/logout'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
      });
    } catch {
      /* ignore */
    }
    localStorage.removeItem('myagent_token');
    set({ token: null, user: null });
  },

  checkAuth: async () => {
    const { token } = get();
    if (!token) {
      set({ isChecking: false });
      return;
    }
    try {
      const res = await fetch(apiUrl('/api/auth/me'), {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json();
      if (res.ok) {
        set({ user: data.user, isChecking: false });
      } else {
        localStorage.removeItem('myagent_token');
        set({ token: null, user: null, isChecking: false });
      }
    } catch {
      set({ isChecking: false });
    }
  },
}));
