// The web's half of the session, and the only part of this site that knows one
// exists.
//
// `overview.md`'s accepted boundary reserves exactly this: "Next.js Route
// Handlers may support web-only session callbacks or a narrow same-origin browser
// adapter when identity requires one. They are not the canonical platform API and
// cannot import platform repositories or execution code." That is what this file
// and the route handler beside it are, and nothing more.
//
// Why the web holds a cookie at all, when the API is the authority: the API sets
// its session cookie on the API's own origin, and today the two deployments are
// on unrelated provider hostnames, so a browser would never send it back. The web
// therefore keeps its own cookie, carrying the same opaque identifier, and
// forwards it on every server-side read. The authority does not move — every
// request is still authorised against the API's session row, and signing out
// still revokes that row — only the carrier does.
//
// The identifier is opaque and this file never interprets it. The web stores no
// account, no claim and no provider token, and it has no database of any kind.

import 'server-only';

import { cookies } from 'next/headers';

/**
 * The web's own cookie name, deliberately distinct from the API's.
 *
 * Two different origins set two different cookies carrying the same value, and
 * giving them the same name would make a same-site deployment ambiguous about
 * which one a request carried.
 */
export const WEB_SESSION_COOKIE = '__Host-mn_web_session';

/** An identifier as the API mints them: base64url, bounded, no structure. */
const SESSION_ID = /^[A-Za-z0-9_-]{22,128}$/u;

export function isSessionId(value: unknown): value is string {
  return typeof value === 'string' && SESSION_ID.test(value);
}

/**
 * The attributes the web's cookie always carries.
 *
 * The same four the API's carries, for the same reasons, and with no parameter
 * that could turn one off: `HttpOnly` so no script can read it, `Secure` so it
 * never crosses plain HTTP, `SameSite=Strict` so a third-party page cannot cause
 * a control to be recorded, and `Path=/` with the `__Host-` prefix so a browser
 * enforces the rest.
 */
export const SESSION_COOKIE_ATTRIBUTES = Object.freeze({
  httpOnly: true,
  path: '/',
  sameSite: 'strict',
  secure: true,
} as const);

/** The identifier this request carries, or undefined when it carries none. */
export async function readSessionId(): Promise<string | undefined> {
  const store = await cookies();
  const value = store.get(WEB_SESSION_COOKIE)?.value;
  return isSessionId(value) ? value : undefined;
}

/**
 * The header that carries the session to the API.
 *
 * The API reads its own cookie name, so the web re-labels the identifier on the
 * way through. Returning an empty object rather than an empty header keeps an
 * unauthenticated read indistinguishable from one that never had a session.
 */
export function sessionHeader(sessionId: string | undefined): Record<string, string> {
  return sessionId === undefined ? {} : { cookie: `__Host-mn_session=${sessionId}` };
}

/**
 * Pull the API's session identifier out of its `Set-Cookie`.
 *
 * Only the value is taken. The API's own attributes are not copied, because they
 * described a cookie for the API's origin; the web re-states its own above.
 */
export function readIssuedSessionId(setCookie: string | null): string | undefined {
  if (setCookie === null) return undefined;
  for (const pair of setCookie.split(';')) {
    const index = pair.indexOf('=');
    if (index < 0) continue;
    if (pair.slice(0, index).trim() !== '__Host-mn_session') continue;
    const value = pair.slice(index + 1).trim();
    return isSessionId(value) ? value : undefined;
  }
  return undefined;
}
