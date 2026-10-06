import { describe, expect, it, vi } from 'vitest';

// The repository's convention for a server-only module under test.
vi.mock('server-only', () => ({}));

import {
  SESSION_COOKIE_ATTRIBUTES,
  WEB_SESSION_COOKIE,
  isSessionId,
  readIssuedSessionId,
  sessionHeader,
} from './session';

const ID = 'a'.repeat(43);

describe('the web session cookie', () => {
  it('always carries every attribute that makes it safe', () => {
    // The same four the API's cookie carries, and for the same reasons. There is
    // no parameter that could turn one off, and this is what keeps it that way.
    expect(SESSION_COOKIE_ATTRIBUTES).toEqual({
      httpOnly: true,
      path: '/',
      sameSite: 'strict',
      secure: true,
    });
    // `__Host-` makes the browser enforce the rest, and forbids a `Domain`.
    expect(WEB_SESSION_COOKIE.startsWith('__Host-')).toBe(true);
  });

  it('is named distinctly from the API’s, so a same-site deployment is unambiguous', () => {
    expect(WEB_SESSION_COOKIE).not.toBe('__Host-mn_session');
  });
});

describe('recognising an identifier', () => {
  it('accepts what the API mints and refuses everything else', () => {
    expect(isSessionId(ID)).toBe(true);
    for (const bad of [undefined, '', 'short', `${ID};Domain=x`, 'a'.repeat(129), 42]) {
      expect(isSessionId(bad)).toBe(false);
    }
  });
});

describe('forwarding the session to the API', () => {
  it('relabels the identifier under the API’s own cookie name', () => {
    expect(sessionHeader(ID)).toEqual({ cookie: `__Host-mn_session=${ID}` });
  });

  it('sends no header at all when there is no session', () => {
    // An unauthenticated read must be indistinguishable from one that never had a
    // session, rather than carrying an empty header that says "there was one".
    expect(sessionHeader(undefined)).toEqual({});
  });
});

describe('reading the identifier the API issued', () => {
  it('takes the value and none of the API’s own attributes', () => {
    expect(
      readIssuedSessionId(`__Host-mn_session=${ID}; Path=/; HttpOnly; Secure; SameSite=Strict`),
    ).toBe(ID);
  });

  it('returns nothing for anything it should not store', () => {
    expect(readIssuedSessionId(null)).toBeUndefined();
    expect(readIssuedSessionId('theme=dark')).toBeUndefined();
    expect(readIssuedSessionId('__Host-mn_session=')).toBeUndefined();
    expect(readIssuedSessionId('__Host-mn_session=short')).toBeUndefined();
    expect(readIssuedSessionId('malformed')).toBeUndefined();
  });
});
