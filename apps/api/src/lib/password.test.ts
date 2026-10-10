import assert from 'node:assert/strict';
import test from 'node:test';
import { hashPassword, verifyPassword } from './password.js';

test('password hashes are salted and can be verified', async () => {
  const first = await hashPassword('ExampleOnly!Password2026');
  const second = await hashPassword('ExampleOnly!Password2026');
  assert.notEqual(first, second);
  assert.equal(await verifyPassword('ExampleOnly!Password2026', first), true);
  assert.equal(await verifyPassword('incorrect', first), false);
  assert.equal(await verifyPassword('anything', 'not-a-hash'), false);
});
