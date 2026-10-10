import type { Response } from 'express';

export function apiError(res: Response, status: number, code: string, message: string, details?: unknown) {
  res.status(status).json({
    error: {
      code,
      message,
      requestId: res.locals.requestId,
      ...(details === undefined ? {} : { details })
    }
  });
}

export function parseMinorUnits(input: string | number): bigint | null {
  const value = String(input).trim();
  if (!/^(?:0|[1-9]\d{0,10})(?:\.\d{1,2})?$/.test(value)) return null;
  const [whole, fraction = ''] = value.split('.');
  try {
    return BigInt(whole!) * 100n + BigInt((fraction + '00').slice(0, 2));
  } catch {
    return null;
  }
}

export function formatMinorUnits(minorUnits: string | bigint, currencyCode: string) {
  const amount = BigInt(minorUnits);
  const negative = amount < 0n;
  const absolute = negative ? -amount : amount;
  const major = absolute / 100n;
  const minor = (absolute % 100n).toString().padStart(2, '0');
  return `${negative ? '-' : ''}${currencyCode} ${(major).toString()}.${minor}`;
}
