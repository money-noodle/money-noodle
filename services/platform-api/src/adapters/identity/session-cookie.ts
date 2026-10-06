// How an opaque session id travels, and nothing else about sessions.
//
// `HttpOnly` so no script can read it, `Secure` so it never crosses plain HTTP,
// `SameSite=Strict` so a third-party page cannot cause a control to be recorded,
// and `Path=/` so one sign-out clears it everywhere. These are not defaults with
// an opt-out: `serializeSessionCookie` is the only way this service sets the
// cookie, and it has no parameter that could turn one of them off.
//
// `__Host-` is the prefix a browser enforces rather than trusts: it refuses the
// cookie unless it is `Secure`, has `Path=/`, and carries no `Domain`. That makes
// a subdomain unable to set a session cookie for the API's origin, which is worth
// having the moment a platform has more than one hostname.
//
// The value is an opaque id and carries no claim, no signature and no expiry of
// its own. Everything a request needs to know is in the session row, so a stolen
// cookie is undone by one `UPDATE` (ADR-0013 §4).

export const SESSION_COOKIE_NAME = '__Host-mn_session';

/** An id as this service mints them: base64url, bounded, no structure. */
const SESSION_ID = /^[A-Za-z0-9_-]{22,128}$/u;

export function serializeSessionCookie(sessionId: string, expiresAt: Date): string {
  if (!SESSION_ID.test(sessionId)) {
    // A caller that reached here with something else has a defect, and sending it
    // would put an unvalidated value in a response header.
    throw new Error('A session cookie carries a bounded opaque identifier.');
  }
  const maxAge = Math.max(0, Math.floor((expiresAt.getTime() - Date.now()) / 1000));
  return [
    `${SESSION_COOKIE_NAME}=${sessionId}`,
    'Path=/',
    'HttpOnly',
    'Secure',
    'SameSite=Strict',
    `Max-Age=${maxAge}`,
  ].join('; ');
}

/** The cookie that clears the session. Same attributes, no value, no lifetime. */
export function serializeClearedSessionCookie(): string {
  return [
    `${SESSION_COOKIE_NAME}=`,
    'Path=/',
    'HttpOnly',
    'Secure',
    'SameSite=Strict',
    'Max-Age=0',
  ].join('; ');
}

/**
 * Pull the session id out of a `Cookie` header.
 *
 * Returns the id only when it is one this service could have minted. An
 * unparseable or out-of-shape value is `undefined` rather than something handed
 * to a store as a lookup key.
 */
export function readSessionCookie(header: string | undefined): string | undefined {
  if (header === undefined || header.length > 4096) return undefined;
  for (const pair of header.split(';')) {
    const index = pair.indexOf('=');
    if (index < 0) continue;
    if (pair.slice(0, index).trim() !== SESSION_COOKIE_NAME) continue;
    const value = pair.slice(index + 1).trim();
    return SESSION_ID.test(value) ? value : undefined;
  }
  return undefined;
}
