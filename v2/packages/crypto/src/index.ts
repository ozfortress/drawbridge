/**
 * Envelope encryption for secrets stored in the database.
 *
 * Algorithm: AES-256-GCM with a 96-bit random IV per encryption and a key id
 * in the envelope, so keys can be rotated without re-reading every row first.
 *
 * Associated data binds a ciphertext to its location (for example
 * `league_citadel_keys|42|key_envelope`), so a ciphertext copied to another row
 * or column fails to decrypt.
 */
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

export class CryptoError extends Error {
  override readonly name = 'CryptoError';
  readonly code: 'invalid_key' | 'invalid_envelope' | 'unknown_key' | 'decrypt_failed';

  constructor(code: CryptoError['code'], message: string) {
    super(message);
    this.code = code;
  }
}

export interface Envelope {
  v: 1;
  kid: string;
  iv: string;
  ct: string;
  tag: string;
}

const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

function decodeKey(base64: string, kid: string): Buffer {
  const key = Buffer.from(base64, 'base64');
  if (key.length !== KEY_BYTES) {
    throw new CryptoError('invalid_key', `key ${kid} must be ${KEY_BYTES} bytes of base64 data`);
  }
  return key;
}

export class Cipher {
  readonly #activeKid: string;
  readonly #keys: Map<string, Buffer>;

  constructor(activeKid: string, keys: Map<string, Buffer>) {
    if (!keys.has(activeKid)) {
      throw new CryptoError('invalid_key', `active key ${activeKid} is not in the key ring`);
    }
    this.#activeKid = activeKid;
    this.#keys = keys;
  }

  static fromMasterKey(masterKeyBase64: string, kid = 'k1'): Cipher {
    return new Cipher(kid, new Map([[kid, decodeKey(masterKeyBase64, kid)]]));
  }

  static fromEntries(
    activeKid: string,
    entries: ReadonlyArray<{ kid: string; keyBase64: string }>,
  ): Cipher {
    const keys = new Map<string, Buffer>();
    for (const entry of entries) keys.set(entry.kid, decodeKey(entry.keyBase64, entry.kid));
    return new Cipher(activeKid, keys);
  }

  /** Adds or replaces a key. Used during rotation. */
  withKey(kid: string, keyBase64: string): Cipher {
    const keys = new Map(this.#keys);
    keys.set(kid, decodeKey(keyBase64, kid));
    return new Cipher(this.#activeKid, keys);
  }

  get activeKeyId(): string {
    return this.#activeKid;
  }

  seal(plaintext: string, aad: string): string {
    const kid = this.#activeKid;
    const key = this.#keys.get(kid);
    if (!key) throw new CryptoError('unknown_key', `no key for ${kid}`);
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.from(aad, 'utf8'));
    const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    const envelope: Envelope = {
      v: 1,
      kid,
      iv: iv.toString('base64'),
      ct: ct.toString('base64'),
      tag: tag.toString('base64'),
    };
    return JSON.stringify(envelope);
  }

  open(sealed: string, aad: string): string {
    let envelope: Envelope;
    try {
      envelope = JSON.parse(sealed) as Envelope;
    } catch {
      throw new CryptoError('invalid_envelope', 'envelope is not valid JSON');
    }
    if (envelope.v !== 1 || !envelope.kid || !envelope.iv || !envelope.ct || !envelope.tag) {
      throw new CryptoError('invalid_envelope', 'envelope is missing required fields');
    }
    const key = this.#keys.get(envelope.kid);
    if (!key) throw new CryptoError('unknown_key', `no key for ${envelope.kid}`);
    const iv = Buffer.from(envelope.iv, 'base64');
    const tag = Buffer.from(envelope.tag, 'base64');
    if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
      throw new CryptoError('invalid_envelope', 'envelope has an invalid iv or tag length');
    }
    try {
      const decipher = createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAAD(Buffer.from(aad, 'utf8'));
      decipher.setAuthTag(tag);
      const plaintext = Buffer.concat([
        decipher.update(Buffer.from(envelope.ct, 'base64')),
        decipher.final(),
      ]);
      return plaintext.toString('utf8');
    } catch {
      throw new CryptoError('decrypt_failed', 'ciphertext failed authentication');
    }
  }

  /** Re-seals an envelope under the active key. */
  rotate(sealed: string, aad: string): string {
    return this.seal(this.open(sealed, aad), aad);
  }

  /** Key ids present in the envelope store are not tracked here; this reports the ring. */
  hasKey(kid: string): boolean {
    return this.#keys.has(kid);
  }
}

export function buildAad(table: string, rowId: string, column: string): string {
  return `${table}|${rowId}|${column}`;
}

/** Random opaque token, URL safe. Used for session ids, OAuth state and API keys. */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** Constant-time comparison for hex digests or tokens of equal length. */
export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) {
    // Compare against itself so the timing does not reveal the length mismatch.
    timingSafeEqual(left, left);
    return false;
  }
  return timingSafeEqual(left, right);
}
