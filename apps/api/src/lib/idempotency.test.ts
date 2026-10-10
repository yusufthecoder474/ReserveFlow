import assert from 'node:assert/strict';
import test from 'node:test';
import { fingerprint } from './fingerprint.js';

test('request fingerprints are deterministic for the same payload', () => {
  assert.equal(fingerprint({ requestId: 'a', action: 'approve' }), fingerprint({ requestId: 'a', action: 'approve' }));
  assert.notEqual(fingerprint({ requestId: 'a', action: 'approve' }), fingerprint({ requestId: 'a', action: 'cancel' }));
});
