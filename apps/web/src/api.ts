export type Role = 'employee' | 'approver' | 'finance_admin';
export type User = { id: string; email: string; fullName: string; role: Role; departmentId: string | null };
export type Organization = { id: string; slug: string; name: string; currencyCode: string };
export type Session = { user: User; organization: Organization; csrfToken: string };
export type ApiFailure = { error?: { code?: string; message?: string; requestId?: string } };

let csrfToken: string | null = null;
export function setCsrfToken(value: string | null) { csrfToken = value; }

export class ApiError extends Error {
  status: number;
  code: string;
  requestId: string | undefined;
  constructor(status: number, code: string, message: string, requestId?: string) {
    super(message);
    this.status = status;
    this.code = code;
    this.requestId = requestId;
  }
}

export async function api<T>(path: string, init: RequestInit = {}, idempotencyKey?: string): Promise<T> {
  const method = (init.method ?? 'GET').toUpperCase();
  const headers = new Headers(init.headers);
  headers.set('Accept', 'application/json');
  if (init.body !== undefined && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  if (!['GET', 'HEAD', 'OPTIONS'].includes(method) && !path.endsWith('/login') && csrfToken) headers.set('X-CSRF-Token', csrfToken);
  if (idempotencyKey) headers.set('Idempotency-Key', idempotencyKey);
  const response = await fetch(path, { ...init, method, headers, credentials: 'include' });
  if (response.status === 204) return undefined as T;
  const payload = await response.json().catch(() => ({})) as ApiFailure & T;
  if (!response.ok) {
    const failure = (payload as ApiFailure).error;
    throw new ApiError(response.status, failure?.code ?? 'REQUEST_FAILED', failure?.message ?? 'The request could not be completed.', failure?.requestId);
  }
  return payload as T;
}

export function makeIdempotencyKey() {
  return globalThis.crypto?.randomUUID?.() ?? `rf-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
