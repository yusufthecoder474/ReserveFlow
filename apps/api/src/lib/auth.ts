import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { pool } from '../database.js';
import { env } from '../config.js';
import { apiError } from './http.js';

export type Role = 'employee' | 'approver' | 'finance_admin';
export type Actor = {
  sessionId: string;
  userId: string;
  organizationId: string;
  organizationSlug: string;
  organizationName: string;
  currencyCode: string;
  email: string;
  fullName: string;
  role: Role;
  departmentId: string | null;
  csrfToken: string;
};

export const SESSION_COOKIE = 'rf_session';
export const safeEqualText = (left: string, right: string) => {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
};

export const hashSessionToken = (token: string) => createHash('sha256').update(token).digest('hex');

export function readCookie(req: Request, name: string): string | null {
  const cookieHeader = req.headers.cookie;
  if (!cookieHeader) return null;
  for (const pair of cookieHeader.split(';')) {
    const separator = pair.indexOf('=');
    if (separator < 0) continue;
    const key = pair.slice(0, separator).trim();
    if (key !== name) continue;
    try { return decodeURIComponent(pair.slice(separator + 1).trim()); } catch { return null; }
  }
  return null;
}

export function setSessionCookie(res: Response, token: string) {
  const maxAge = env.SESSION_TTL_HOURS * 60 * 60;
  res.append('Set-Cookie', `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${env.SESSION_COOKIE_SECURE ? '; Secure' : ''}`);
}

export function clearSessionCookie(res: Response) {
  res.append('Set-Cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${env.SESSION_COOKIE_SECURE ? '; Secure' : ''}`);
}

export function newSessionToken() { return randomBytes(32).toString('base64url'); }
export function newCsrfToken() { return randomBytes(32).toString('hex'); }

export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  const token = readCookie(req, SESSION_COOKIE);
  if (!token || token.length > 256) {
    apiError(res, 401, 'AUTHENTICATION_REQUIRED', 'Sign in to continue.');
    return;
  }
  try {
    const result = await pool.query<{
      session_id: string; csrf_token: string; user_id: string; organization_id: string;
      organization_slug: string; organization_name: string; currency_code: string; email: string;
      full_name: string; role: Role; department_id: string | null;
    }>(`
      SELECT s.id AS session_id, s.csrf_token, u.id AS user_id, o.id AS organization_id,
             o.slug AS organization_slug, o.name AS organization_name, o.currency_code,
             u.email, u.full_name, m.role, m.department_id
      FROM sessions s
      JOIN users u ON u.id = s.user_id
      JOIN organizations o ON o.id = s.organization_id
      JOIN memberships m ON m.user_id = s.user_id AND m.organization_id = s.organization_id
      WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now() AND u.is_active = true
      LIMIT 1
    `, [hashSessionToken(token)]);
    const row = result.rows[0];
    if (!row) {
      clearSessionCookie(res);
      apiError(res, 401, 'SESSION_EXPIRED', 'Your session has expired. Sign in again.');
      return;
    }
    res.locals.actor = {
      sessionId: row.session_id, userId: row.user_id, organizationId: row.organization_id,
      organizationSlug: row.organization_slug, organizationName: row.organization_name,
      currencyCode: row.currency_code.trim(), email: row.email, fullName: row.full_name,
      role: row.role, departmentId: row.department_id, csrfToken: row.csrf_token
    } satisfies Actor;
    await pool.query('UPDATE sessions SET last_seen_at = now() WHERE id = $1', [row.session_id]);
    next();
  } catch (error) {
    next(error);
  }
}

export function actorFrom(res: Response): Actor {
  return res.locals.actor as Actor;
}

export function requireRole(...roles: Role[]) {
  return (_req: Request, res: Response, next: NextFunction) => {
    const actor = res.locals.actor as Actor | undefined;
    if (!actor || !roles.includes(actor.role)) {
      apiError(res, 403, 'FORBIDDEN', 'You do not have permission to perform this action.');
      return;
    }
    next();
  };
}

export function requireCsrf(req: Request, res: Response, next: NextFunction) {
  const actor = res.locals.actor as Actor | undefined;
  const csrf = req.header('x-csrf-token');
  if (!actor || !csrf || !safeEqualText(csrf, actor.csrfToken)) {
    apiError(res, 403, 'CSRF_VALIDATION_FAILED', 'Refresh the session and retry the request.');
    return;
  }
  next();
}
