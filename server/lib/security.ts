import crypto from 'node:crypto';
import { API_KEY, INVITE_CODE_LENGTH } from '@shared/constants';

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

/** Cryptographically random base62 string (uniform: no modulo bias). */
export function randomBase62(length: number): string {
  let out = '';
  while (out.length < length) {
    for (const byte of crypto.randomBytes(length * 2)) {
      // 248 = 62 * 4: discard bytes that would bias the distribution.
      if (byte < 248) out += BASE62[byte % 62];
      if (out.length === length) break;
    }
  }
  return out;
}

export function sha256Hex(input: string | Uint8Array): string {
  return crypto.createHash('sha256').update(input).digest('hex');
}

const API_KEY_PATTERN = new RegExp(`^${API_KEY.prefix}[0-9A-Za-z]{${API_KEY.randomLength}}$`);

export function isApiKeyFormat(value: string): boolean {
  return API_KEY_PATTERN.test(value);
}

export interface GeneratedApiKey {
  /** Plaintext key, shown to the user once. */
  key: string;
  /** Stored in clear for display (`bat_<prefix>…`). */
  prefix: string;
  /** SHA-256 hex, stored and looked up. */
  hash: string;
}

export function generateApiKey(): GeneratedApiKey {
  const random = randomBase62(API_KEY.randomLength);
  const key = `${API_KEY.prefix}${random}`;
  return { key, prefix: random.slice(0, API_KEY.displayPrefixLength), hash: hashApiKey(key) };
}

export function hashApiKey(key: string): string {
  return sha256Hex(key);
}

export function generateInviteCode(): string {
  return randomBase62(INVITE_CODE_LENGTH);
}
