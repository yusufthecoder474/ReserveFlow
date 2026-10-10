import assert from 'node:assert/strict';
import test from 'node:test';
import { formatMinorUnits, parseMinorUnits } from './http.js';

test('parseMinorUnits preserves two-decimal precision without floating point', () => {
  assert.equal(parseMinorUnits('0.01'), 1n);
  assert.equal(parseMinorUnits('12'), 1200n);
  assert.equal(parseMinorUnits('12.3'), 1230n);
  assert.equal(parseMinorUnits('9999999999.99'), 999999999999n);
  assert.equal(parseMinorUnits('1.234'), null);
  assert.equal(parseMinorUnits('-1.00'), null);
  assert.equal(parseMinorUnits('1e3'), null);
  assert.equal(parseMinorUnits('01.00'), null);
});

test('formatMinorUnits renders minor units exactly', () => {
  assert.equal(formatMinorUnits('12345', 'AED'), 'AED 123.45');
  assert.equal(formatMinorUnits('1', 'SAR'), 'SAR 0.01');
});
