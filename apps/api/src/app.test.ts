import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';

// The test deliberately exercises only the liveness/404 boundary. It does not
// require PostgreSQL, because the readiness endpoint is tested in a later milestone.
process.env.DATABASE_URL ??= 'postgresql://unused:unused@127.0.0.1:5432/unused';

const [{ createApp }, { pool }] = await Promise.all([
  import('./app.js'),
  import('./database.js')
]);

test('API assigns a request ID, responds to liveness, and returns a stable 404', async () => {
  const server = createApp().listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const liveResponse = await fetch(`${baseUrl}/api/health/live`);
    assert.equal(liveResponse.status, 200);
    assert.ok(liveResponse.headers.get('x-request-id'));
    assert.deepEqual(await liveResponse.json(), { status: 'ok', service: 'reserveflow-api' });

    const missingResponse = await fetch(`${baseUrl}/not-a-route`);
    assert.equal(missingResponse.status, 404);
    assert.ok(missingResponse.headers.get('x-request-id'));
    const missingBody = await missingResponse.json() as { error?: { code?: string } };
    assert.equal(missingBody.error?.code, 'ROUTE_NOT_FOUND');

    const rejectedOrigin = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://untrusted.example' },
      body: JSON.stringify({ email: 'employee@reserveflow.local', password: 'irrelevant' })
    });
    assert.equal(rejectedOrigin.status, 403);
    const originBody = await rejectedOrigin.json() as { error?: { code?: string } };
    assert.equal(originBody.error?.code, 'ORIGIN_NOT_ALLOWED');
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
    await pool.end();
  }
});
