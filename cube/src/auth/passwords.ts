/**
 * Password hashing/verification. Supports imported MediaWiki hash formats
 * (:pbkdf2:, legacy :B:/:A:) for account continuity, and rehashes to scrypt
 * (node:crypto built-in, no native deps) on successful login.
 *
 * MediaWiki formats:
 *   :pbkdf2:<digest>:<iterations>:<keylen>:<b64 salt>:<b64 hash>
 *   :B:<salt>:<md5hex>       where hash = md5(salt + "-" + md5(password))
 *   :A:<md5hex>              plain md5(password)
 * Cube format:
 *   :scrypt:<N>:<r>:<p>:<b64 salt>:<b64 hash>
 */

import { createHash, pbkdf2Sync, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

const SCRYPT = { N: 1 << 15, r: 8, p: 1, keylen: 64 };

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, SCRYPT.keylen, {
    N: SCRYPT.N,
    r: SCRYPT.r,
    p: SCRYPT.p,
    maxmem: 128 * SCRYPT.N * SCRYPT.r * 2,
  });
  return [":scrypt", SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString("base64"), hash.toString("base64")].join(":");
}

export function verifyPassword(stored: string | null | undefined, password: string): boolean {
  if (!stored) return false;
  try {
    if (stored.startsWith(":scrypt:")) return verifyScrypt(stored, password);
    if (stored.startsWith(":pbkdf2:")) return verifyMwPbkdf2(stored, password);
    if (stored.startsWith(":B:")) return verifyMwB(stored, password);
    if (stored.startsWith(":A:")) return verifyMwA(stored, password);
    return false;
  } catch {
    return false;
  }
}

/** True when a successful login should transparently upgrade the hash. */
export function needsRehash(stored: string): boolean {
  return !stored.startsWith(":scrypt:");
}

function verifyScrypt(stored: string, password: string): boolean {
  const [, , n, r, p, saltB64, hashB64] = stored.split(":");
  const salt = Buffer.from(saltB64!, "base64");
  const expected = Buffer.from(hashB64!, "base64");
  const N = Number(n);
  const actual = scryptSync(password, salt, expected.length, {
    N,
    r: Number(r),
    p: Number(p),
    maxmem: 128 * N * Number(r) * 2,
  });
  return timingSafeEqual(actual, expected);
}

function verifyMwPbkdf2(stored: string, password: string): boolean {
  // ":pbkdf2:sha512:30000:64:<salt>:<hash>": salt/hash base64.
  const parts = stored.split(":");
  if (parts.length !== 7) return false;
  const [, , digest, iterations, keylen, saltB64, hashB64] = parts;
  const salt = Buffer.from(saltB64!, "base64");
  const expected = Buffer.from(hashB64!, "base64");
  const actual = pbkdf2Sync(password, salt, Number(iterations), Number(keylen), digest!);
  return expected.length === actual.length && timingSafeEqual(actual, expected);
}

function md5hex(s: string | Buffer): string {
  return createHash("md5").update(s).digest("hex");
}

function verifyMwB(stored: string, password: string): boolean {
  const parts = stored.split(":");
  if (parts.length !== 4) return false;
  const [, , salt, hex] = parts;
  const actual = md5hex(`${salt}-${md5hex(password)}`);
  return safeHexEqual(actual, hex!);
}

function verifyMwA(stored: string, password: string): boolean {
  const parts = stored.split(":");
  if (parts.length !== 3) return false;
  return safeHexEqual(md5hex(password), parts[2]!);
}

function safeHexEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, "hex");
  const bb = Buffer.from(b, "hex");
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}
