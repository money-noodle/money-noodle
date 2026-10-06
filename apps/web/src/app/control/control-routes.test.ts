// The session callback and the control post, against a fetch and a cookie store
// the test supplies.
//
// What is checked is the carrier, because that is all these handlers are: that a
// sign-in stores the identifier the API issued under a cookie with every safe
// attribute, that a refusal stores nothing and publishes no reason, that signing
// out clears the cookie even when the API could not be reached, and that a
// control post forwards the session and the action and nothing else.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const cookieStore = {
  entries: new Map<string, { options: Record<string, unknown>; value: string }>(),
  get(name: string) {
    const entry = cookieStore.entries.get(name);
    return entry === undefined ? undefined : { name, value: entry.value };
  },
  set(name: string, value: string, options: Record<string, unknown> = {}) {
    cookieStore.entries.set(name, { options, value });
  },
};

vi.mock('next/headers', () => ({ cookies: async () => cookieStore }));

const { POST: signIn } = await import('../session/route');
const { POST: signOut } = await import('../session/end/route');
const { POST: recordControl } = await import('./[kind]/route');

const WEB_COOKIE = '__Host-mn_web_session';
const ID = 'a'.repeat(43);

function production(): void {
  vi.stubEnv('NODE_ENV', 'production');
  vi.stubEnv('PLATFORM_API_ORIGIN', 'https://api.example.test');
  vi.stubEnv('ARTIFACT_VERSION', 'release-1.2.3');
  vi.stubEnv('MONEY_NOODLE_COMMIT', 'a'.repeat(40));
  vi.stubEnv('MONEY_NOODLE_SERVICE', 'web');
  vi.stubEnv('MONEY_NOODLE_ENVIRONMENT', 'production');
}

function formRequest(body: Record<string, string>): Request {
  return new Request('https://web.example.test/session', {
    body: new URLSearchParams(body),
    method: 'POST',
  });
}

function jsonRequest(body: unknown): Request {
  return new Request('https://web.example.test/session', {
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
    method: 'POST',
  });
}

beforeEach(() => {
  cookieStore.entries.clear();
  production();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('signing in through the web', () => {
  it('stores the identifier the API issued, with every safe attribute', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(null, {
            headers: { 'set-cookie': `__Host-mn_session=${ID}; Path=/; HttpOnly; Secure` },
            status: 201,
          }),
      ),
    );

    const response = await signIn(formRequest({ idToken: 'a-token' }));

    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('/control');
    const stored = cookieStore.entries.get(WEB_COOKIE);
    expect(stored?.value).toBe(ID);
    expect(stored?.options).toMatchObject({
      httpOnly: true,
      path: '/',
      sameSite: 'strict',
      secure: true,
    });
  });

  it('answers a JSON client without a redirect', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(null, {
            headers: { 'set-cookie': `__Host-mn_session=${ID}` },
            status: 201,
          }),
      ),
    );

    expect((await signIn(jsonRequest({ idToken: 'a-token' }))).status).toBe(204);
  });

  it('stores nothing when the API refuses, and publishes no reason', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ errorCode: 'MN-SECOND-FACTOR-REQUIRED' }), {
            status: 401,
          }),
      ),
    );

    const form = await signIn(formRequest({ idToken: 'a-token' }));
    expect(form.headers.get('location')).toBe('/control?signIn=refused');
    expect(cookieStore.entries.has(WEB_COOKIE)).toBe(false);

    const json = await signIn(jsonRequest({ idToken: 'a-token' }));
    expect(json.status).toBe(401);
    // The API's own code does not travel through this second contract.
    expect(await json.text()).not.toContain('SECOND-FACTOR');
  });

  it('refuses a body with no usable token before reaching the API', async () => {
    const reached = vi.fn();
    vi.stubGlobal('fetch', reached);

    expect((await signIn(formRequest({ idToken: '   ' }))).headers.get('location')).toBe(
      '/control?signIn=refused',
    );
    expect((await signIn(jsonRequest({ idToken: 42 }))).status).toBe(400);
    expect((await signIn(jsonRequest('not an object'))).status).toBe(400);
    expect(reached).not.toHaveBeenCalled();
  });

  it('stores nothing when the API could not be reached, or issued no session', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('connect ECONNREFUSED 10.0.0.1:443');
      }),
    );
    expect((await signIn(formRequest({ idToken: 't' }))).headers.get('location')).toBe(
      '/control?signIn=refused',
    );
    expect((await signIn(jsonRequest({ idToken: 't' }))).status).toBe(503);

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 201 })),
    );
    expect((await signIn(jsonRequest({ idToken: 't' }))).status).toBe(503);
    expect(cookieStore.entries.has(WEB_COOKIE)).toBe(false);
  });
});

describe('signing out through the web', () => {
  it('clears the cookie and asks the API to revoke the row', async () => {
    cookieStore.set(WEB_COOKIE, ID);
    const sent = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', sent);

    const response = await signOut();

    expect(response.headers.get('location')).toBe('/control');
    expect(cookieStore.entries.get(WEB_COOKIE)?.value).toBe('');
    expect(cookieStore.entries.get(WEB_COOKIE)?.options).toMatchObject({ maxAge: 0 });
    expect(sent).toHaveBeenCalledOnce();
  });

  it('clears the cookie even when the revocation could not be delivered, and says so', async () => {
    cookieStore.set(WEB_COOKIE, ID);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('timeout');
      }),
    );

    const response = await signOut();

    expect(cookieStore.entries.get(WEB_COOKIE)?.value).toBe('');
    // "The browser forgot it" and "the platform revoked it" are different facts.
    expect(response.headers.get('location')).toBe('/control?signOut=unconfirmed');
  });

  it('asks nothing of the API when there was no session', async () => {
    const reached = vi.fn();
    vi.stubGlobal('fetch', reached);

    expect((await signOut()).headers.get('location')).toBe('/control');
    expect(reached).not.toHaveBeenCalled();
  });
});

describe('recording a control through the web', () => {
  const params = (kind: string) => ({ params: Promise.resolve({ kind }) });

  it('forwards the session and the action, and names the row that was recorded', async () => {
    cookieStore.set(WEB_COOKIE, ID);
    const sent = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            action: 'pause',
            capability: 'budget:paper',
            intentId: 'intent-1',
            recorded: true,
            requestId: 'r',
            schemaVersion: '1',
          }),
          { headers: { 'content-type': 'application/json' }, status: 202 },
        ),
    );
    vi.stubGlobal('fetch', sent);

    const response = await recordControl(
      new Request('https://web.example.test/control/paper', {
        body: new URLSearchParams({ action: 'pause' }),
        method: 'POST',
      }),
      params('paper'),
    );

    expect(response.headers.get('location')).toBe(
      '/control?budget=paper&recorded=pause%3Aintent-1',
    );
    // The generated client sends a `Request`, so the session is read off it
    // rather than off an init object.
    const [sentRequest] = sent.mock.calls[0] as unknown as [Request];
    expect(sentRequest.headers.get('cookie')).toBe(`__Host-mn_session=${ID}`);
    expect(await sentRequest.clone().text()).toContain('"pause"');
  });

  it('refuses an unpublished action or budget kind before reaching the API', async () => {
    cookieStore.set(WEB_COOKIE, ID);
    const reached = vi.fn();
    vi.stubGlobal('fetch', reached);

    const badAction = await recordControl(
      new Request('https://web.example.test/control/paper', {
        body: new URLSearchParams({ action: 'arm' }),
        method: 'POST',
      }),
      params('paper'),
    );
    expect(badAction.headers.get('location')).toBe('/control?budget=paper&recorded=failed');

    const badKind = await recordControl(
      new Request('https://web.example.test/control/shadow', {
        body: new URLSearchParams({ action: 'pause' }),
        method: 'POST',
      }),
      params('shadow'),
    );
    expect(badKind.headers.get('location')).toBe('/control?budget=paper&recorded=failed');
    expect(reached).not.toHaveBeenCalled();
  });

  it('reports a refusal as nothing recorded', async () => {
    cookieStore.set(WEB_COOKIE, ID);
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ errorCode: 'MN-SESSION-REJECTED' }), { status: 401 }),
      ),
    );

    const response = await recordControl(
      new Request('https://web.example.test/control/live', {
        body: new URLSearchParams({ action: 'provider-enable' }),
        method: 'POST',
      }),
      params('live'),
    );

    expect(response.headers.get('location')).toBe('/control?budget=live&recorded=failed');
  });
});
