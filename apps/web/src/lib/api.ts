// Tiny fetch wrapper. Carries cookies (session + csrf) automatically; reads
// the CSRF token from the cookie set by GET /api/auth/csrf and adds it to
// mutating requests.

// Path prefix prepended to every API request and login redirect so the
// fetch stays inside whatever path-prefix the SPA is being served
// under. Resolves to "" (empty) for standalone deploys
// (import.meta.env.BASE_URL = "/") and to "/<slug>" behind the
// Vibe-Appliance shared Caddy in LAN / Tailscale modes (the build-time
// sentinel /__VIBE_BASE_PATH__/ is sed-replaced at container start to
// /<slug>/, see scripts/web-base-path.sh). Without this, fetches to
// /api/auth/csrf and the 401-redirect to /login escape the prefix and
// either 404 against the shared ingress or hit a wrong upstream.
export const APP_BASE = import.meta.env.BASE_URL.replace(/\/$/, '');
export const withBase = (p: string): string => APP_BASE + p;

const CSRF_COOKIE = 'vibetc_csrf';

const readCookie = (name: string): string | undefined => {
  const all = (document.cookie ?? '').split('; ');
  for (const pair of all) {
    const [k, v] = pair.split('=');
    if (k === name) return decodeURIComponent(v ?? '');
  }
  return undefined;
};

const ensureCsrf = async (): Promise<string> => {
  let token = readCookie(CSRF_COOKIE);
  if (!token) {
    const res = await fetch(withBase('/api/auth/csrf'), { credentials: 'include' });
    if (!res.ok) throw new Error('failed to fetch CSRF token');
    const body = (await res.json()) as { token: string };
    token = body.token;
  }
  return token;
};

export class ApiError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly details?: unknown;
  constructor(status: number, body: { message?: string; code?: string; details?: unknown }) {
    super(body.message ?? `HTTP ${status}`);
    this.name = 'ApiError';
    this.status = status;
    if (body.code) this.code = body.code;
    if (body.details !== undefined) this.details = body.details;
  }
}

export type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface FetchOptions {
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined>;
}

const buildUrl = (path: string, query?: FetchOptions['query']): string => {
  // The CSRF + path.startsWith / path !== checks below compare against
  // the unprefixed path on purpose, so we apply the base prefix only at
  // the outgoing-URL boundary here. Callers continue to pass paths like
  // "/api/auth/login" verbatim.
  const full = withBase(path);
  if (!query) return full;
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined) params.set(k, String(v));
  }
  const qs = params.toString();
  return qs ? `${full}?${qs}` : full;
};

export const fetchJson = async <T = unknown>(
  method: Method,
  path: string,
  opts: FetchOptions = {},
): Promise<T> => {
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  if (method !== 'GET' && path !== '/api/auth/login') {
    headers['x-csrf-token'] = await ensureCsrf();
  }

  const res = await fetch(buildUrl(path, opts.query), {
    method,
    credentials: 'include',
    headers,
    body: opts.body === undefined ? null : JSON.stringify(opts.body),
  });

  if (res.status === 204) return undefined as unknown as T;

  const contentType = res.headers.get('content-type') ?? '';
  const isJson = contentType.includes('application/json');
  const body = isJson ? await res.json() : await res.text();

  if (!res.ok) {
    if (res.status === 401 && !path.startsWith('/api/auth/')) {
      window.location.assign(withBase('/login'));
    }
    throw new ApiError(res.status, isJson ? body : { message: String(body) });
  }
  return body as T;
};

export const api = {
  get: <T = unknown>(path: string, query?: FetchOptions['query']) =>
    fetchJson<T>('GET', path, query ? { query } : {}),
  post: <T = unknown>(path: string, body?: unknown) => fetchJson<T>('POST', path, { body }),
  patch: <T = unknown>(path: string, body?: unknown) => fetchJson<T>('PATCH', path, { body }),
  put: <T = unknown>(path: string, body?: unknown) => fetchJson<T>('PUT', path, { body }),
  delete: <T = unknown>(path: string) => fetchJson<T>('DELETE', path),
};
