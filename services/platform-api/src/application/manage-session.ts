// Sign in, authorise a request, sign out.
//
// Three use cases, each one outcome type, no framework and no provider. The HTTP
// adapter turns an outcome into a status code and a cookie; this layer decides
// what is allowed and nothing about how it is carried.
//
// Two rules are enforced here rather than in an adapter, because they are the
// decision and not the plumbing:
//
//   * MFA is required at sign-in. ADR-0013 §4 says it is on from the start, so a
//     verified identity without a second factor is refused, not downgraded.
//   * A session binds to the one configured account. There is no sign-up and no
//     second account, so an identity that is not the configured account's is
//     refused rather than silently given a new one.
//
// Every refusal is one of a closed set. Nothing a verifier or a store said
// travels out of this layer, which is why a thrown store error becomes
// `store-unavailable` and loses its message here rather than at the edge.

import {
  SESSION_LIFETIME_MS,
  sessionState,
  type ActiveSession,
  type IdentityTokenVerifier,
  type Session,
  type SessionRefusal,
  type SessionStore,
  type SignInRefusal,
} from '../domain/identity.js';

export type SignInOutcome =
  | { readonly ok: true; readonly session: ActiveSession }
  | { readonly ok: false; readonly refusal: SignInRefusal };

export type AuthenticateOutcome =
  | { readonly ok: true; readonly session: ActiveSession }
  | { readonly ok: false; readonly refusal: SessionRefusal };

export interface SessionDependencies {
  /** The one account this platform has. Absent means identity is unconfigured. */
  readonly accountId: string | undefined;
  readonly clock: { now(): Date };
  /** Opaque, unguessable session ids. The adapter supplies real randomness. */
  readonly newSessionId: () => string;
  /** Absent until the maintainer has entered the identity configuration. */
  readonly sessions: SessionStore | null;
  readonly verifier: IdentityTokenVerifier | null;
}

export type SignIn = (token: string) => Promise<SignInOutcome>;
export type AuthenticateSession = (sessionId: string | undefined) => Promise<AuthenticateOutcome>;
export type RevokeSession = (sessionId: string) => Promise<{ readonly ok: boolean }>;

export function createSignIn(dependencies: SessionDependencies): SignIn {
  return async (token: string): Promise<SignInOutcome> => {
    const { accountId, clock, newSessionId, sessions, verifier } = dependencies;
    if (verifier === null || sessions === null || accountId === undefined) {
      return { ok: false, refusal: 'not-configured' };
    }

    let identity;
    try {
      identity = await verifier.verify(token);
    } catch {
      // A verifier that threw has not verified anything. It is the same answer as
      // a token that failed, and for the same reason it says no more than that.
      return { ok: false, refusal: 'invalid-token' };
    }
    if (identity === null) return { ok: false, refusal: 'invalid-token' };

    // ADR-0013 §4: MFA on from the start. The claim says a second factor was used
    // for *this* sign-in, not that one is enrolled, so this cannot be satisfied by
    // an account that merely has a factor configured.
    if (!identity.secondFactorUsed) return { ok: false, refusal: 'second-factor-required' };

    const now = clock.now();
    const session: Session = {
      accountId,
      createdAt: now,
      // The shorter of this platform's lifetime and what the provider itself is
      // willing to stand behind. A session outliving its assertion would be this
      // platform asserting something it was never told.
      expiresAt: new Date(
        Math.min(now.getTime() + SESSION_LIFETIME_MS, identity.expiresAt.getTime()),
      ),
      id: newSessionId(),
      revokedAt: null,
    };

    if (session.expiresAt.getTime() <= now.getTime()) {
      // The assertion was already spent. Nothing is stored for it.
      return { ok: false, refusal: 'invalid-token' };
    }

    try {
      await sessions.create(session);
    } catch {
      return { ok: false, refusal: 'store-unavailable' };
    }

    return {
      ok: true,
      session: { accountId: session.accountId, expiresAt: session.expiresAt, id: session.id },
    };
  };
}

export function createAuthenticateSession(dependencies: SessionDependencies): AuthenticateSession {
  return async (sessionId: string | undefined): Promise<AuthenticateOutcome> => {
    const { accountId, clock, sessions } = dependencies;
    if (sessionId === undefined || sessionId.length === 0) {
      return { ok: false, refusal: 'absent' };
    }
    if (sessions === null || accountId === undefined) {
      // Unconfigured identity cannot authorise anybody. Refusing as `unknown`
      // rather than `absent` keeps "you sent nothing" distinct from "what you
      // sent is not a session here".
      return { ok: false, refusal: 'unknown' };
    }

    let stored;
    try {
      stored = await sessions.read(sessionId);
    } catch {
      return { ok: false, refusal: 'store-unavailable' };
    }
    if (stored === null) return { ok: false, refusal: 'unknown' };

    // A row for another account is not this platform's session, whatever the
    // store returned. Single-account is checked on every request and not only at
    // sign-in, so a reconfigured account id invalidates sessions immediately.
    if (stored.accountId !== accountId) return { ok: false, refusal: 'unknown' };

    const state = sessionState(stored, clock.now());
    if (state === 'revoked') return { ok: false, refusal: 'revoked' };
    if (state === 'expired') return { ok: false, refusal: 'expired' };

    return {
      ok: true,
      session: { accountId: stored.accountId, expiresAt: stored.expiresAt, id: stored.id },
    };
  };
}

export function createRevokeSession(dependencies: SessionDependencies): RevokeSession {
  return async (sessionId: string): Promise<{ readonly ok: boolean }> => {
    const { clock, sessions } = dependencies;
    if (sessions === null) return { ok: false };
    try {
      // Revoking an unknown or already-revoked id is not an error. Sign-out is
      // idempotent, and telling a caller which ids exist would make this endpoint
      // an oracle.
      await sessions.revoke(sessionId, clock.now());
      return { ok: true };
    } catch {
      return { ok: false };
    }
  };
}
