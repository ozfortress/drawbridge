import { describe, expect, it } from 'vitest';
import { buildAad, Cipher, CryptoError, hashToken, randomToken, safeEqual } from '../src/index.js';

const KEY_A = Buffer.alloc(32, 1).toString('base64');
const KEY_B = Buffer.alloc(32, 2).toString('base64');
const AAD = buildAad('league_citadel_keys', 'league-1', 'key_envelope');

function cipher(): Cipher {
  return Cipher.fromMasterKey(KEY_A, 'k1');
}

describe('envelope encryption', () => {
  it('round-trips UTF-8 plaintext', () => {
    const sealed = cipher().seal('citadel-key-☃-秘密', AAD);
    expect(cipher().open(sealed, AAD)).toBe('citadel-key-☃-秘密');
  });

  it('produces a versioned envelope with all fields and a fresh IV each time', () => {
    const a = JSON.parse(cipher().seal('same', AAD));
    const b = JSON.parse(cipher().seal('same', AAD));
    expect(a).toMatchObject({ v: 1, kid: 'k1' });
    expect(typeof a.ct).toBe('string');
    expect(a.iv).not.toBe(b.iv);
    expect(a.ct).not.toBe(b.ct);
  });

  it('fails when the associated data does not match', () => {
    const sealed = cipher().seal('secret', AAD);
    expect(() =>
      cipher().open(sealed, buildAad('league_citadel_keys', 'other', 'key_envelope')),
    ).toThrow(CryptoError);
    expect(() => cipher().open(sealed, '')).toThrow(/authentication/);
  });

  it('fails on a tampered ciphertext, tag or iv', () => {
    const sealed = JSON.parse(cipher().seal('secret', AAD));
    for (const field of ['ct', 'tag', 'iv'] as const) {
      const tampered = { ...sealed, [field]: Buffer.from('0000000000000000').toString('base64') };
      expect(() => cipher().open(JSON.stringify(tampered), AAD)).toThrow(CryptoError);
    }
  });

  it('rejects an unknown key id and an invalid envelope', () => {
    const sealed = JSON.parse(cipher().seal('secret', AAD));
    expect(() => cipher().open(JSON.stringify({ ...sealed, kid: 'k9' }), AAD)).toThrow(/no key/);
    expect(() => cipher().open('not json', AAD)).toThrow(/not valid JSON/);
    expect(() => cipher().open(JSON.stringify({ v: 1 }), AAD)).toThrow(/missing required fields/);
  });

  it('rejects a key of the wrong length', () => {
    expect(() => Cipher.fromMasterKey(Buffer.alloc(16, 1).toString('base64'))).toThrow(/32 bytes/);
  });

  it('rotates an envelope to the active key without losing the plaintext', () => {
    const old = cipher();
    const sealed = old.seal('rotate-me', AAD);

    const rotatedRing = Cipher.fromEntries('k2', [
      { kid: 'k1', keyBase64: KEY_A },
      { kid: 'k2', keyBase64: KEY_B },
    ]);
    const rotated = rotatedRing.rotate(sealed, AAD);
    expect(JSON.parse(rotated).kid).toBe('k2');
    expect(rotatedRing.open(rotated, AAD)).toBe('rotate-me');
    // The old envelope still opens with the old key while it is in the ring.
    expect(rotatedRing.open(sealed, AAD)).toBe('rotate-me');
  });

  it('cannot decrypt with the wrong key, even with a matching key id', () => {
    const sealed = cipher().seal('secret', AAD);
    const wrong = Cipher.fromMasterKey(KEY_B, 'k1');
    expect(() => wrong.open(sealed, AAD)).toThrow(CryptoError);
  });
});

describe('tokens', () => {
  it('generates unique URL-safe tokens and deterministic hashes', () => {
    const a = randomToken();
    const b = randomToken();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(hashToken(a)).toBe(hashToken(a));
    expect(hashToken(a)).not.toBe(hashToken(b));
    expect(hashToken(a)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('compares safely', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
  });
});
