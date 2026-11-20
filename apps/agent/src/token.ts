import { randomBytes, timingSafeEqual } from 'node:crypto';

/** Fresh session token: 32 CSPRNG bytes, base64url (43 characters). */
export function generateToken(): string {
  return randomBytes(32).toString('base64url');
}

/** Constant-time comparison. Inputs of different length are compared against themselves. */
export function tokensEqual(received: string, expected: string): boolean {
  const a = Buffer.from(received, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.byteLength !== b.byteLength) {
    timingSafeEqual(b, b);
    return false;
  }
  return timingSafeEqual(a, b);
}
