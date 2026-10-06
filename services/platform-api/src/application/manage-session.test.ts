import { describe, expect, it } from 'vitest';

import {
  createAuthenticateSession,
  createRevokeSession,
  createSignIn,
  type SessionDependencies,
} from './manage-session.js';
import type {
  IdentityTokenVerifier,
  Session,
  SessionStore,
  VerifiedIdentity,
} from '../domain/identity.js';

const ACCOUNT = 'account-under-test';
const NOW = new Date('2026-10-06T12:00:00.000Z');

/**
 * A store that remembers rows and can be told to fail.
 *
 * In-memory on purpose: every rule these tests are about — revocation, expiry,
 * single-account binding — lives in the use cases, so proving them needs no
 * database and no network, which is also what keeps them running in CI.
 */
function fakeStore(): SessionStore & { rows: Map<string, Session>; fail: boolean } {
  const rows = new Map<string, Session>();
  const store = {
    fail: false,
    rows,
    async create(session: Session) {
      if (store.fail) throw new Error('unavailable');
      rows.set(session.id, session);
    },
    async read(id: string) {
      if (store.fail) throw new Error('unavailable');
      return rows.get(id) ?? null;
    },
    async revoke(id: string, revokedAt: Date) {
      if (store.fail) throw new Error('unavailable');
      const existing = rows.get(id);
      if (existing !== undefined && existing.revokedAt === null) {
        rows.set(id, { ...existing, revokedAt });
      }
    },
  };
  return store;
}

function fakeVerifier(identity: VerifiedIdentity | null): IdentityTokenVerifier {
  return { verify: async () => identity };
}

const identity = (overrides: Partial<VerifiedIdentity> = {}): VerifiedIdentity => ({
  expiresAt: new Date(NOW.getTime() + 60 * 60 * 1000),
  secondFactorUsed: true,
  subject: 'provider-subject',
  ...overrides,
});

function dependencies(overrides: Partial<SessionDependencies> = {}): SessionDependencies {
  let counter = 0;
  return {
    accountId: ACCOUNT,
    clock: { now: () => NOW },
    newSessionId: () => `session-identifier-value-${(counter += 1)}`,
    sessions: fakeStore(),
    verifier: fakeVerifier(identity()),
    ...overrides,
  };
}

describe('sign-in', () => {
  it('establishes a session bound to the one configured account', async () => {
    const sessions = fakeStore();
    const signIn = createSignIn(dependencies({ sessions }));

    const outcome = await signIn('a-token');

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.session.accountId).toBe(ACCOUNT);
    expect(sessions.rows.size).toBe(1);
    expect([...sessions.rows.values()][0]?.revokedAt).toBeNull();
  });

  it('refuses a verified identity that did not use a second factor', async () => {
    // ADR-0013 §4: MFA on from the start. This is the assertion that keeps it
    // from being quietly downgraded to "enrolled" later.
    const sessions = fakeStore();
    const signIn = createSignIn(
      dependencies({ sessions, verifier: fakeVerifier(identity({ secondFactorUsed: false })) }),
    );

    const outcome = await signIn('a-token');

    expect(outcome).toEqual({ ok: false, refusal: 'second-factor-required' });
    expect(sessions.rows.size).toBe(0);
  });

  it('refuses a token the verifier rejected, and one it threw on, identically', async () => {
    const rejected = await createSignIn(dependencies({ verifier: fakeVerifier(null) }))('t');
    const threw = await createSignIn(
      dependencies({
        verifier: {
          verify: async () => {
            throw new Error('issuer mismatch at https://example.invalid');
          },
        },
      }),
    )('t');

    expect(rejected).toEqual({ ok: false, refusal: 'invalid-token' });
    // The thrown message named a host. None of it travels.
    expect(threw).toEqual({ ok: false, refusal: 'invalid-token' });
  });

  it('refuses an assertion that has already expired, and stores nothing', async () => {
    const sessions = fakeStore();
    const outcome = await createSignIn(
      dependencies({
        sessions,
        verifier: fakeVerifier(identity({ expiresAt: new Date(NOW.getTime() - 1) })),
      }),
    )('a-token');

    expect(outcome).toEqual({ ok: false, refusal: 'invalid-token' });
    expect(sessions.rows.size).toBe(0);
  });

  it('never outlives the provider assertion it was established from', async () => {
    const shortLived = new Date(NOW.getTime() + 5 * 60 * 1000);
    const outcome = await createSignIn(
      dependencies({ verifier: fakeVerifier(identity({ expiresAt: shortLived })) }),
    )('a-token');

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.session.expiresAt).toEqual(shortLived);
  });

  it('refuses when identity is not configured for this revision', async () => {
    for (const absent of [
      { verifier: null },
      { sessions: null },
      { accountId: undefined },
    ] satisfies Partial<SessionDependencies>[]) {
      const outcome = await createSignIn(dependencies(absent))('a-token');
      expect(outcome).toEqual({ ok: false, refusal: 'not-configured' });
    }
  });

  it('reports a store failure without carrying its message', async () => {
    const sessions = fakeStore();
    sessions.fail = true;
    const outcome = await createSignIn(dependencies({ sessions }))('a-token');

    expect(outcome).toEqual({ ok: false, refusal: 'store-unavailable' });
  });
});

describe('authenticating a request', () => {
  it('accepts a session the store holds', async () => {
    const sessions = fakeStore();
    const base = dependencies({ sessions });
    const established = await createSignIn(base)('a-token');
    expect(established.ok).toBe(true);
    if (!established.ok) return;

    const outcome = await createAuthenticateSession(base)(established.session.id);

    expect(outcome).toEqual({ ok: true, session: established.session });
  });

  it('refuses an absent session distinctly from an unknown one', async () => {
    const base = dependencies();
    expect(await createAuthenticateSession(base)(undefined)).toEqual({
      ok: false,
      refusal: 'absent',
    });
    expect(await createAuthenticateSession(base)('')).toEqual({ ok: false, refusal: 'absent' });
    expect(await createAuthenticateSession(base)('never-issued')).toEqual({
      ok: false,
      refusal: 'unknown',
    });
  });

  it('refuses a revoked session on the very next request', async () => {
    // This is what "revocable server-side" means, and it is the whole reason the
    // session is a row rather than a signed token: nothing is asked of the
    // identity provider, and nothing has to expire first.
    const sessions = fakeStore();
    const base = dependencies({ sessions });
    const established = await createSignIn(base)('a-token');
    expect(established.ok).toBe(true);
    if (!established.ok) return;

    await createRevokeSession(base)(established.session.id);
    const outcome = await createAuthenticateSession(base)(established.session.id);

    expect(outcome).toEqual({ ok: false, refusal: 'revoked' });
    expect(sessions.rows.get(established.session.id)?.revokedAt).toEqual(NOW);
  });

  it('refuses an expired session', async () => {
    const sessions = fakeStore();
    const later = new Date(NOW.getTime() + 24 * 60 * 60 * 1000);
    const base = dependencies({ sessions });
    const established = await createSignIn(base)('a-token');
    expect(established.ok).toBe(true);
    if (!established.ok) return;

    const outcome = await createAuthenticateSession({
      ...base,
      clock: { now: () => later },
    })(established.session.id);

    expect(outcome).toEqual({ ok: false, refusal: 'expired' });
  });

  it('refuses a row bound to any other account', async () => {
    // Single-account is checked on every request, not only at sign-in, so a
    // reconfigured account id invalidates outstanding sessions immediately.
    const sessions = fakeStore();
    await sessions.create({
      accountId: 'a-different-account',
      createdAt: NOW,
      expiresAt: new Date(NOW.getTime() + 60_000),
      id: 'foreign',
      revokedAt: null,
    });

    const outcome = await createAuthenticateSession(dependencies({ sessions }))('foreign');

    expect(outcome).toEqual({ ok: false, refusal: 'unknown' });
  });

  it('fails closed when the store cannot answer', async () => {
    const sessions = fakeStore();
    sessions.fail = true;
    expect(await createAuthenticateSession(dependencies({ sessions }))('anything')).toEqual({
      ok: false,
      refusal: 'store-unavailable',
    });
  });

  it('cannot authorise anybody while identity is unconfigured', async () => {
    expect(await createAuthenticateSession(dependencies({ sessions: null }))('x')).toEqual({
      ok: false,
      refusal: 'unknown',
    });
    expect(await createAuthenticateSession(dependencies({ accountId: undefined }))('x')).toEqual({
      ok: false,
      refusal: 'unknown',
    });
  });
});

describe('revocation', () => {
  it('is idempotent and keeps the first revocation time', async () => {
    const sessions = fakeStore();
    const base = dependencies({ sessions });
    const established = await createSignIn(base)('a-token');
    expect(established.ok).toBe(true);
    if (!established.ok) return;

    const later = new Date(NOW.getTime() + 1000);
    await createRevokeSession(base)(established.session.id);
    await createRevokeSession({ ...base, clock: { now: () => later } })(established.session.id);

    expect(sessions.rows.get(established.session.id)?.revokedAt).toEqual(NOW);
  });

  it('succeeds for an identifier that was never issued', async () => {
    expect(await createRevokeSession(dependencies())('never-issued')).toEqual({ ok: true });
  });

  it('reports failure without a message when the store cannot answer', async () => {
    const sessions = fakeStore();
    sessions.fail = true;
    expect(await createRevokeSession(dependencies({ sessions }))('x')).toEqual({ ok: false });
    expect(await createRevokeSession(dependencies({ sessions: null }))('x')).toEqual({
      ok: false,
    });
  });
});
