import { describe, expect, it } from 'vitest';
import { CitadelParseError, parseCitadelJson } from '../src/index.js';

describe('parseCitadelJson', () => {
  it('keeps every integer beyond Number.MAX_SAFE_INTEGER as its exact string', () => {
    const value = parseCitadelJson('{"discord_id":123456789012345678}') as { discord_id: unknown };
    expect(value.discord_id).toBe('123456789012345678');
    expect(typeof value.discord_id).toBe('string');
  });

  it('round-trips an 18-digit snowflake and a steam 64 id exactly', () => {
    const value = parseCitadelJson(
      '{"discord_id":123456789012345678,"steam_64":76561198012345678}',
    ) as {
      discord_id: string;
      steam_64: string;
    };
    expect(value.discord_id).toBe('123456789012345678');
    expect(value.steam_64).toBe('76561198012345678');
  });

  it('keeps 2**53 itself a string while MAX_SAFE_INTEGER stays a number', () => {
    const value = parseCitadelJson('{"safe":9007199254740991,"unsafe":9007199254740992}') as {
      safe: unknown;
      unsafe: unknown;
    };
    expect(value.safe).toBe(9007199254740991);
    expect(value.unsafe).toBe('9007199254740992');
  });

  it('keeps distinct integers above 2**53 distinct, unlike JSON.parse', () => {
    const json = '[123456789012345678,123456789012345679,123456789012345680]';
    expect(parseCitadelJson(json)).toEqual([
      '123456789012345678',
      '123456789012345679',
      '123456789012345680',
    ]);
    // The same body through JSON.parse collapses all three values.
    const lossy = JSON.parse(json) as number[];
    expect(lossy[0]).toBe(lossy[1]);
    expect(lossy[1]).toBe(lossy[2]);
  });

  it('keeps a negative integer beyond the safe range as a string', () => {
    const value = parseCitadelJson('{"value":-123456789012345678}') as { value: unknown };
    expect(value.value).toBe('-123456789012345678');
  });

  it('parses ordinary numbers, floats and booleans as normal values', () => {
    const value = parseCitadelJson('{"id":42,"score":3.5,"ok":true,"none":null}') as {
      id: unknown;
      score: unknown;
      ok: unknown;
      none: unknown;
    };
    expect(value.id).toBe(42);
    expect(value.score).toBe(3.5);
    expect(value.ok).toBe(true);
    expect(value.none).toBeNull();
  });

  it('revives large integers at every nesting depth', () => {
    const value = parseCitadelJson(
      '{"rosters":[{"players":[{"discord_id":123456789012345678}]}],"meta":{"ids":[76561198012345678]}}',
    ) as { rosters: Array<{ players: Array<{ discord_id: unknown }> }>; meta: { ids: unknown[] } };
    expect(value.rosters[0]?.players[0]?.discord_id).toBe('123456789012345678');
    expect(value.meta.ids[0]).toBe('76561198012345678');
  });

  it('leaves string values untouched, including numeric-looking ones', () => {
    const value = parseCitadelJson('{"steam_64_str":"76561198012345678"}') as {
      steam_64_str: unknown;
    };
    expect(value.steam_64_str).toBe('76561198012345678');
  });

  it('raises a typed CitadelParseError on malformed input', () => {
    expect(() => parseCitadelJson('{"id":')).toThrow(CitadelParseError);
    expect(() => parseCitadelJson('not json')).toThrow(CitadelParseError);
    expect(() => parseCitadelJson('')).toThrow(CitadelParseError);
    expect(() => parseCitadelJson('<html>502 Bad Gateway</html>')).toThrow(CitadelParseError);
  });

  it('names the error and keeps the original cause', () => {
    try {
      parseCitadelJson('nope');
      throw new Error('expected CitadelParseError');
    } catch (error) {
      const parseError = error as CitadelParseError;
      expect(parseError.name).toBe('CitadelParseError');
      expect(parseError.message).toContain('malformed JSON body');
      expect(parseError.cause).toBeInstanceOf(Error);
    }
  });
});
