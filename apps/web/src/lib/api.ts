import axios from 'axios';

export const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:4100/api/v1';
export const TOKEN_KEY = 'myhive.token';
export const ORG_KEY = 'myhive.org';

export const api = axios.create({ baseURL: API_URL });

api.interceptors.request.use((config) => {
  const token = localStorage.getItem(TOKEN_KEY);
  if (token) config.headers.Authorization = `Bearer ${token}`;
  const org = localStorage.getItem(ORG_KEY);
  if (org) config.headers['X-Organisation'] = org;
  return config;
});

api.interceptors.response.use(
  (response) => response,
  (error) => {
    const config: any = error?.config;
    const status = error?.response?.status;
    const message = error?.response?.data?.message;
    const orgUnavailable =
      status === 403 &&
      (message === 'Organisation not available' ||
        (Array.isArray(message) && message.includes('Organisation not available')));
    if (orgUnavailable && config && !config._orgRetried) {
      const storedOrg = localStorage.getItem(ORG_KEY);
      const headerOrg = config.headers?.['X-Organisation'];
      if (storedOrg || headerOrg) {
        localStorage.removeItem(ORG_KEY);
        config._orgRetried = true;
        if (config.headers) {
          if (typeof config.headers.delete === 'function') config.headers.delete('X-Organisation');
          else delete config.headers['X-Organisation'];
        }
        return api.request(config);
      }
    }
    if (status === 401) {
      localStorage.removeItem(TOKEN_KEY);
      localStorage.removeItem(ORG_KEY);
      if (!window.location.pathname.startsWith('/login')) {
        window.location.href = '/login';
      }
    }
    return Promise.reject(error);
  },
);

export function errorMessage(error: any): string {
  return (
    error?.response?.data?.message ||
    error?.message ||
    'Unexpected error'
  );
}

export async function loginRequest(login: string, password: string) {
  const { data } = await api.post('/auth/login', { login, password });
  return data;
}

export async function meRequest() {
  const { data } = await api.get('/auth/me');
  return data;
}
