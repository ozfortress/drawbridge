import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { sha256Hex } from '../src/index.js';

const nodeDigest = (input: string): string =>
  createHash('sha256').update(input, 'utf8').digest('hex');

describe('sha256Hex', () => {
  it('matches node for the empty string', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });

  it('matches node for ascii text', () => {
    expect(sha256Hex('abc')).toBe(nodeDigest('abc'));
    expect(sha256Hex('The quick brown fox jumps over the lazy dog')).toBe(
      nodeDigest('The quick brown fox jumps over the lazy dog'),
    );
  });

  it('matches node for utf-8 emoji', () => {
    const input = 'héllo wörld 🎉👨‍👩‍👧‍👦';
    expect(sha256Hex(input)).toBe(nodeDigest(input));
  });

  it('matches node for a long input', () => {
    const input = 'a'.repeat(100_000);
    expect(sha256Hex(input)).toBe(nodeDigest(input));
  });

  it('matches node across the padding boundary', () => {
    for (const length of [54, 55, 56, 57, 63, 64, 65, 119, 120, 127, 128]) {
      const input = 'x'.repeat(length);
      expect(sha256Hex(input)).toBe(nodeDigest(input));
    }
  });
});
