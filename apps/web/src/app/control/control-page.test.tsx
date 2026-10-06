// The signed-in page, rendered against a fetch and a cookie store the test
// supplies.
//
// The point of rendering the page rather than only its views: the decisions that
// matter here are the page's, not the view's — which reader sees the sign-in form,
// what happens when the API stops accepting a session this browser still holds,
// and whether a failed read takes down the whole page or only its own section.

import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const cookieStore = {
  entries: new Map<string, string>(),
  get(name: string) {
    const value = cookieStore.entries.get(name);
    return value === undefined ? undefined : { name, value };
  },
  set(name: string, value: string) {
    cookieStore.entries.set(name, value);
  },
};

vi.mock('next/headers', () => ({ cookies: async () => cookieStore }));

const { default: ControlPage } = await import('./page');

const WEB_COOKIE = '__Host-mn_web_session';
const ID = 'a'.repeat(43);

const detail = {
  appliedState: null,
  budget: {
    createdAt: '2026-10-06T12:00:00.000Z',
    hasExecutionAuthority: true,
    id: 'account:paper',
    kind: 'paper',
  },
  capability: 'budget:paper',
  desiredState: 'unset',
  epoch: 0,
  latestIntentAt: null,
  requestId: 'r',
  schemaVersion: '1',
};

const history = { capability: 'budget:paper', entries: [], requestId: 'r', schemaVersion: '1' };
const jobs = {
  jobs: [{ capability: 'budget:paper', lastOutcome: null, lastRunAt: null, lastRunId: null }],
  requestId: 'r',
  schemaVersion: '1',
};

function answering(status = 200): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (request: Request) => {
      if (status !== 200) return new Response(JSON.stringify({ errorCode: 'MN-X' }), { status });
      const url = typeof request === 'string' ? request : request.url;
      const body = url.includes('/intents') ? history : url.includes('/jobs') ? jobs : detail;
      return new Response(JSON.stringify(body), {
        headers: { 'content-type': 'application/json' },
        status: 200,
      });
    }),
  );
}

async function render(parameters: Record<string, string> = {}): Promise<string> {
  return renderToStaticMarkup(await ControlPage({ searchParams: Promise.resolve(parameters) }));
}

beforeEach(() => {
  cookieStore.entries.clear();
  vi.stubEnv('NODE_ENV', 'production');
  vi.stubEnv('PLATFORM_API_ORIGIN', 'https://api.example.test');
  vi.stubEnv('ARTIFACT_VERSION', 'release-1.2.3');
  vi.stubEnv('MONEY_NOODLE_COMMIT', 'a'.repeat(40));
  vi.stubEnv('MONEY_NOODLE_SERVICE', 'web');
  vi.stubEnv('MONEY_NOODLE_ENVIRONMENT', 'production');
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('the signed-in page', () => {
  it('shows the sign-in form to a reader with no session, and asks the API nothing', async () => {
    const reached = vi.fn();
    vi.stubGlobal('fetch', reached);

    const markup = await render();

    expect(markup).toContain('Sign in');
    expect(markup).toContain('id="idToken"');
    expect(reached).not.toHaveBeenCalled();
  });

  it('says a sign-in was refused when the callback redirected with that', async () => {
    vi.stubGlobal('fetch', vi.fn());
    expect(await render({ signIn: 'refused' })).toContain('was not accepted');
  });

  it('renders the budget, its controls, the intent history and the jobs', async () => {
    cookieStore.set(WEB_COOKIE, ID);
    answering();

    const markup = await render();

    expect(markup).toContain('Account controls');
    expect(markup).toContain('Simulated budget');
    expect(markup).toContain('Record pause');
    expect(markup).toContain('No control has ever been recorded');
    expect(markup).toContain('Never run');
    expect(markup).toContain('Sign out');
  });

  it('shows the live budget’s standing notice when that budget is selected', async () => {
    cookieStore.set(WEB_COOKIE, ID);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (request: Request) => {
        const url = typeof request === 'string' ? request : request.url;
        if (url.includes('/intents')) {
          return Response.json({ ...history, capability: 'budget:live' });
        }
        if (url.includes('/jobs')) return Response.json(jobs);
        return Response.json({
          ...detail,
          budget: { ...detail.budget, hasExecutionAuthority: false, kind: 'live' },
          capability: 'budget:live',
        });
      }),
    );

    const markup = await render({ budget: 'live' });

    expect(markup).toContain('no execution authority');
    expect(markup).toContain('no way to arm it');
  });

  it('offers sign-in again when the API no longer accepts the session this browser holds', async () => {
    // This is what revocation looks like from here: the cookie outlived the row.
    cookieStore.set(WEB_COOKIE, ID);
    answering(401);

    const markup = await render();

    expect(markup).toContain('id="idToken"');
    expect(markup).not.toContain('Record pause');
  });

  it('degrades one section at a time rather than losing the page', async () => {
    cookieStore.set(WEB_COOKIE, ID);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (request: Request) => {
        const url = typeof request === 'string' ? request : request.url;
        if (url.includes('/intents') || url.includes('/jobs')) {
          return new Response(JSON.stringify({ errorCode: 'MN-X' }), { status: 503 });
        }
        return Response.json(detail);
      }),
    );

    const markup = await render();

    expect(markup).toContain('Simulated budget');
    expect(markup).toContain('not available right now');
    // Nothing is filled in for the sections that could not be read.
    expect(markup).not.toContain('Never run');
  });

  it('reports a recorded control and a failed one from the redirect', async () => {
    cookieStore.set(WEB_COOKIE, ID);
    answering();

    expect(await render({ recorded: 'pause:intent-1' })).toContain('intent-1');
    expect(await render({ recorded: 'failed' })).toContain('Nothing was recorded');
    // A malformed value says nothing rather than rendering half of one.
    const quiet = await render({ recorded: 'nonsense' });
    expect(quiet).not.toContain('Nothing was recorded');
    expect(quiet).not.toContain('role="status"');
  });

  it('says when a sign-out could not be confirmed', async () => {
    cookieStore.set(WEB_COOKIE, ID);
    answering();

    expect(await render({ signOut: 'unconfirmed' })).toContain('could not confirm');
  });
});
