import { createHash } from 'node:crypto';

/** Deterministic fingerprint for JSON request payloads. Callers validate payloads first. */
export function fingerprint(value: unknown) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
