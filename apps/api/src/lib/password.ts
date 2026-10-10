import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';

const scrypt = (password: string, salt: Buffer, keyLength: number, cost: number) => new Promise<Buffer>((resolve, reject) => {
  scryptCallback(password, salt, keyLength, { N: cost, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (error, derivedKey) => {
    if (error) reject(error);
    else resolve(derivedKey as Buffer);
  });
});

const COST = 16_384;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await scrypt(password, salt, 64, COST);
  return `scrypt$${COST}$8$1$${salt.toString('base64url')}$${derived.toString('base64url')}`;
}

export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const parts = encoded.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const cost = Number(parts[1]);
  const blockSize = Number(parts[2]);
  const parallelization = Number(parts[3]);
  if (cost !== COST || blockSize !== 8 || parallelization !== 1) return false;

  try {
    const salt = Buffer.from(parts[4]!, 'base64url');
    const expected = Buffer.from(parts[5]!, 'base64url');
    if (salt.length < 16 || expected.length !== 64) return false;
    const actual = await scrypt(password, salt, expected.length, cost);
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}
