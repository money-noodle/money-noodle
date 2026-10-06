import { describe, expect, it } from 'vitest';

import {
  SESSION_COOKIE_NAME,
  readSessionCookie,
  serializeClearedSessionCookie,
  serializeSessionCookie,
} from './session-cookie.js';

const ID = 'a'.repeat(43);

describe('the session cookie', () => {
  it('always carries every attribute that makes it safe', () => {
    // These are not defaults with an opt-out: there is no parameter that could
    // turn one of them off, and this test is what keeps it that way.
    const cookie = serializeSessionCookie(ID, new Date(Date.now() + 3_600_000));

    expect(cookie.startsWith(`${SESSION_COOKIE_NAME}=${ID}`)).toBe(true);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('SameSite=Strict');
    expect(cookie).toContain('Path=/');
    // `__Host-` makes the browser enforce the rest, and forbids a `Domain`.
    expect(SESSION_COOKIE_NAME.startsWith('__Host-')).toBe(true);
    expect(cookie).not.toContain('Domain=');
  });

  it('never emits a negative lifetime for an already-expired session', () => {
    expect(serializeSessionCookie(ID, new Date(Date.now() - 60_000))).toContain('Max-Age=0');
  });

  it('refuses to serialize anything that is not an identifier this service mints', () => {
    for (const bad of ['', 'short', `${ID};Domain=example.invalid`, 'a'.repeat(129)]) {
      expect(() => serializeSessionCookie(bad, new Date())).toThrow();
    }
  });

  it('clears with the same attributes and no value', () => {
    const cleared = serializeClearedSessionCookie();
    expect(cleared).toContain('Max-Age=0');
    expect(cleared).toContain('HttpOnly');
    expect(cleared).toContain('Secure');
    expect(cleared).toContain('SameSite=Strict');
    expect(cleared.startsWith(`${SESSION_COOKIE_NAME}=;`)).toBe(true);
  });
});

describe('reading the cookie back', () => {
  it('finds the identifier among other cookies', () => {
    expect(readSessionCookie(`theme=dark; ${SESSION_COOKIE_NAME}=${ID}; other=1`)).toBe(ID);
    expect(readSessionCookie(`${SESSION_COOKIE_NAME}=${ID}`)).toBe(ID);
  });

  it('returns nothing rather than handing a store an out-of-shape key', () => {
    expect(readSessionCookie(undefined)).toBeUndefined();
    expect(readSessionCookie('theme=dark')).toBeUndefined();
    expect(readSessionCookie(`${SESSION_COOKIE_NAME}=`)).toBeUndefined();
    expect(readSessionCookie(`${SESSION_COOKIE_NAME}=short`)).toBeUndefined();
    expect(
      readSessionCookie(`${SESSION_COOKIE_NAME}=${"'; drop table session --"}`),
    ).toBeUndefined();
    expect(readSessionCookie('malformed')).toBeUndefined();
    // A header large enough to be an attack is not parsed at all.
    expect(readSessionCookie('x'.repeat(5000))).toBeUndefined();
  });
});
