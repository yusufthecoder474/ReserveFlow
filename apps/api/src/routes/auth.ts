import { Router } from 'express';
import { z } from 'zod';
import { env } from '../config.js';
import { pool } from '../database.js';
import { apiError } from '../lib/http.js';
import { hashSessionToken, newCsrfToken, newSessionToken, clearSessionCookie, setSessionCookie, requireAuth, requireCsrf, actorFrom } from '../lib/auth.js';
import { hashPassword, verifyPassword } from '../lib/password.js';

const router = Router();
const dummyPasswordHash = hashPassword('ReserveFlowDummyPasswordForTimingOnly!2026');
const loginSchema = z.object({
  email: z.string().trim().email().max(254).transform((value) => value.toLowerCase()),
  password: z.string().min(1).max(256),
  organizationSlug: z.string().trim().min(2).max(50).optional()
}).strict();

const failedAttempts = new Map<string, { count: number; resetAt: number }>();
function isRateLimited(key: string) {
  const now = Date.now();
  if (failedAttempts.size > 10_000) {
    for (const [entryKey, entry] of failedAttempts) if (entry.resetAt <= now) failedAttempts.delete(entryKey);
    if (failedAttempts.size > 10_000) failedAttempts.clear();
  }
  const previous = failedAttempts.get(key);
  if (!previous || previous.resetAt <= now) {
    failedAttempts.set(key, { count: 0, resetAt: now + 60_000 });
    return false;
  }
  return previous.count >= 10;
}
function recordFailure(key: string) {
  const current = failedAttempts.get(key);
  if (current && current.resetAt > Date.now()) current.count += 1;
  else failedAttempts.set(key, { count: 1, resetAt: Date.now() + 60_000 });
}

router.post('/login', async (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    apiError(res, 400, 'VALIDATION_ERROR', 'Provide a valid email and password.');
    return;
  }
  const email = parsed.data.email;
  const rateKey = `${req.ip ?? 'unknown'}:${email}`;
  if (isRateLimited(rateKey)) {
    res.setHeader('Retry-After', '60');
    apiError(res, 429, 'LOGIN_RATE_LIMITED', 'Too many sign-in attempts. Wait before trying again.');
    return;
  }

  const result = await pool.query<{
    user_id: string; password_hash: string; organization_id: string; is_active: boolean;
  }>(`
    SELECT u.id AS user_id, u.password_hash, m.organization_id, u.is_active
    FROM users u
    JOIN memberships m ON m.user_id = u.id
    JOIN organizations o ON o.id = m.organization_id
    WHERE u.email = $1 AND ($2::text IS NULL OR o.slug = $2)
    ORDER BY m.created_at ASC LIMIT 1
  `, [email, parsed.data.organizationSlug ?? null]);

  const row = result.rows[0];
  // A dummy verification helps reduce obvious timing differences for nonexistent accounts.
  const validPassword = row ? await verifyPassword(parsed.data.password, row.password_hash) : await verifyPassword(parsed.data.password, await dummyPasswordHash);
  if (!row || !row.is_active || !validPassword) {
    recordFailure(rateKey);
    apiError(res, 401, 'INVALID_CREDENTIALS', 'Email or password is incorrect.');
    return;
  }
  failedAttempts.delete(rateKey);
  const token = newSessionToken();
  const csrfToken = newCsrfToken();
  await pool.query(`
    INSERT INTO sessions (token_hash, csrf_token, user_id, organization_id, expires_at)
    VALUES ($1, $2, $3, $4, now() + ($5 * interval '1 hour'))
  `, [hashSessionToken(token), csrfToken, row.user_id, row.organization_id, env.SESSION_TTL_HOURS]);
  setSessionCookie(res, token);
  res.status(200).json({ authenticated: true, csrfToken });
});

router.get('/me', requireAuth, (_req, res) => {
  const actor = actorFrom(res);
  res.json({
    user: { id: actor.userId, email: actor.email, fullName: actor.fullName, role: actor.role, departmentId: actor.departmentId },
    organization: { id: actor.organizationId, slug: actor.organizationSlug, name: actor.organizationName, currencyCode: actor.currencyCode },
    csrfToken: actor.csrfToken
  });
});

router.post('/logout', requireAuth, requireCsrf, async (_req, res) => {
  const actor = actorFrom(res);
  await pool.query('UPDATE sessions SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL', [actor.sessionId]);
  clearSessionCookie(res);
  res.status(204).end();
});

export { router as authRouter };
