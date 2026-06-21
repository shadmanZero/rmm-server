/**
 * Password hashing — scrypt via Node's built-in `crypto`, no native dependency.
 *
 * The stored string is self-describing so the parameters can evolve without a
 * migration:  `scrypt$N$r$p$<salt-hex>$<key-hex>`. Verification is constant-time.
 */

import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from "crypto";

/** Cost parameters. N must be a power of two; these are a sensible interactive cost. */
const PARAMS = { N: 16384, r: 8, p: 1 } as const;
const KEY_LENGTH = 64;
const SALT_LENGTH = 16;
/** scrypt with N=16384,r=8 needs >16MB; lift the default cap so it never throws. */
const MAX_MEM = 64 * 1024 * 1024;

/** Promise wrapper around the options-taking `scrypt` overload (kept fully typed). */
function derive(password: string, salt: Buffer, keylen: number, options: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keylen, options, (err, derivedKey) => {
      if (err) reject(err);
      else resolve(derivedKey);
    });
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_LENGTH);
  const derived = await derive(password, salt, KEY_LENGTH, { ...PARAMS, maxmem: MAX_MEM });
  return `scrypt$${PARAMS.N}$${PARAMS.r}$${PARAMS.p}$${salt.toString("hex")}$${derived.toString("hex")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;

  const [, nRaw, rRaw, pRaw, saltHex, keyHex] = parts;
  const N = Number(nRaw);
  const r = Number(rRaw);
  const p = Number(pRaw);
  if (![N, r, p].every(Number.isFinite)) return false;

  const expected = Buffer.from(keyHex, "hex");
  const derived = await derive(password, Buffer.from(saltHex, "hex"), expected.length, {
    N,
    r,
    p,
    maxmem: MAX_MEM,
  });

  return expected.length === derived.length && timingSafeEqual(expected, derived);
}
