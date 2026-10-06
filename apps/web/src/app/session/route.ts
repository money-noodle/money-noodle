// The web-only session callback `overview.md` reserves.
//
// Two methods and no judgement: POST hands an identity token to the API and
// stores whatever session the API established; DELETE asks the API to revoke it
// and clears the cookie either way. It decides nothing about who may sign in —
// the API verifies the token, requires the second factor and owns the session row
// — and it holds no platform state of its own.
//
// Nothing from the API's response body is forwarded. A refusal becomes this
// site's own small problem document, because the API's problem document is the
// API's contract and re-emitting it here would make this route look like the
// platform API, which it is not.

import { randomUUID } from 'node:crypto';

import { cookies } from 'next/headers';

import { readRuntimeConfig } from '../../adapters/config/read-runtime-config';
import {
  SESSION_COOKIE_ATTRIBUTES,
  WEB_SESSION_COOKIE,
  readIssuedSessionId,
  readSessionId,
} from '../../adapters/platform-api/session';

const SIGN_IN_TIMEOUT_MS = 6_000;

function problem(status: number, errorCode: string, title: string): Response {
  const requestId = randomUUID();
  return Response.json(
    {
      errorCode,
      requestId,
      status,
      title,
      type: `https://errors.noodle.money/${errorCode.toLowerCase()}`,
    },
    {
      headers: { 'content-type': 'application/problem+json', 'x-request-id': requestId },
      status,
    },
  );
}

/**
 * The token, from a form post or from JSON.
 *
 * The form is the one that matters: the sign-in page is a plain `<form>` so it
 * works without JavaScript, which is both an accessibility property and the
 * reason this site still needs no client component.
 */
async function submittedToken(request: Request): Promise<string | undefined> {
  const contentType = request.headers.get('content-type') ?? '';
  try {
    const value = contentType.includes('application/json')
      ? ((await request.json()) as { idToken?: unknown }).idToken
      : (await request.formData()).get('idToken');
    if (typeof value !== 'string') return undefined;
    const trimmed = value.trim();
    return trimmed.length === 0 || trimmed.length > 8192 ? undefined : trimmed;
  } catch {
    return undefined;
  }
}

function wantsJson(request: Request): boolean {
  return (request.headers.get('content-type') ?? '').includes('application/json');
}

/** Back to the signed-in page, saying only whether it worked. */
function back(request: Request, outcome: 'refused' | 'ok'): Response {
  const location = outcome === 'ok' ? '/control' : '/control?signIn=refused';
  return new Response(null, { headers: { location }, status: 303 });
}

export async function POST(request: Request): Promise<Response> {
  const idToken = await submittedToken(request);
  if (idToken === undefined) {
    return wantsJson(request)
      ? problem(400, 'MN-WEB-REQUEST-INVALID', 'Bad Request')
      : back(request, 'refused');
  }

  const { platformApiOrigin } = readRuntimeConfig(process.env);
  let response: Response;
  try {
    response = await fetch(`${platformApiOrigin}/v1/identity/session`, {
      body: JSON.stringify({ idToken }),
      cache: 'no-store',
      headers: { 'content-type': 'application/json' },
      method: 'POST',
      signal: AbortSignal.timeout(SIGN_IN_TIMEOUT_MS),
    });
  } catch {
    return wantsJson(request)
      ? problem(503, 'MN-WEB-SIGN-IN-UNAVAILABLE', 'Service Unavailable')
      : back(request, 'refused');
  }

  if (response.status !== 201) {
    if (!wantsJson(request)) return back(request, 'refused');
    // The API already decided how much to say, and said it to this server rather
    // than to the browser. Re-emitting it would publish a refusal reason through a
    // second contract, so the browser gets the status and nothing else.
    return problem(
      response.status === 401 ? 401 : 503,
      response.status === 401 ? 'MN-WEB-SIGN-IN-REFUSED' : 'MN-WEB-SIGN-IN-UNAVAILABLE',
      response.status === 401 ? 'Unauthorized' : 'Service Unavailable',
    );
  }

  const sessionId = readIssuedSessionId(response.headers.get('set-cookie'));
  if (sessionId === undefined) {
    return wantsJson(request)
      ? problem(503, 'MN-WEB-SIGN-IN-UNAVAILABLE', 'Service Unavailable')
      : back(request, 'refused');
  }

  const store = await cookies();
  store.set(WEB_SESSION_COOKIE, sessionId, SESSION_COOKIE_ATTRIBUTES);
  return wantsJson(request) ? new Response(null, { status: 204 }) : back(request, 'ok');
}

/**
 * Clear this site's cookie and ask the API to revoke the row behind it.
 *
 * Shared by the JSON `DELETE` below and by the form post at `/session/end`,
 * because an HTML form cannot send `DELETE` and the sign-out button must work
 * without JavaScript.
 */
export async function endSession(): Promise<'revoked' | 'cleared'> {
  const sessionId = await readSessionId();
  const store = await cookies();
  // The cookie goes first and unconditionally. A revocation this server could not
  // deliver must still not leave the browser holding a session.
  store.set(WEB_SESSION_COOKIE, '', { ...SESSION_COOKIE_ATTRIBUTES, maxAge: 0 });
  if (sessionId === undefined) return 'revoked';

  const { platformApiOrigin } = readRuntimeConfig(process.env);
  try {
    await fetch(`${platformApiOrigin}/v1/identity/session`, {
      cache: 'no-store',
      headers: { cookie: `__Host-mn_session=${sessionId}` },
      method: 'DELETE',
      signal: AbortSignal.timeout(SIGN_IN_TIMEOUT_MS),
    });
    return 'revoked';
  } catch {
    // The row stays until it expires. Said plainly rather than reported as a clean
    // sign-out, because "revoked" and "the browser forgot it" are different facts.
    return 'cleared';
  }
}

export async function DELETE(): Promise<Response> {
  return new Response(null, { status: (await endSession()) === 'revoked' ? 204 : 202 });
}
