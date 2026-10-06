// Who is signed in, and what a session is allowed to be.
//
// Two separate facts live here and are deliberately not collapsed into one. A
// *verified identity* is what an external identity provider asserts about a
// person at one moment: a subject, an audience, and whether a second factor was
// actually used. A *session* is this platform's own durable grant, which exists
// only in this platform's store and can be taken away without asking the
// provider anything.
//
// That separation is the point of ADR-0013 §4. The provider's token is accepted
// once, at sign-in; every request afterwards is authorised against a row this
// service owns, so revocation is an `UPDATE` here rather than a negotiation with
// Google. Nothing in this file imports a provider, a framework or a driver — the
// verifier and the store are ports, and their implementations are adapters.
//
// The platform is single-account by decision, not by accident. One account holds
// the paper and live budgets (ADR-0013 §4); there is no sign-up, no second
// account, and no tenant dimension to get wrong, so the session binds to the one
// configured account id and a session for any other account is refused.

/** How long a new session may live before it must be established again. */
export const SESSION_LIFETIME_MS = 12 * 60 * 60 * 1000;

/**
 * An identity assertion that has already been verified.
 *
 * Produced only by {@link IdentityTokenVerifier}. The raw token never reaches
 * the application or domain layers, and this type carries nothing that could be
 * replayed: no token, no refresh material, no provider claims beyond the three
 * facts the platform acts on.
 */
export interface VerifiedIdentity {
  /** The provider's stable subject identifier for the person. */
  readonly subject: string;
  /**
   * Whether the provider asserted that a *second factor* was used for this
   * sign-in, not merely that one is enrolled. MFA is on from the start
   * (ADR-0013 §4), so a `false` here is a refusal rather than a downgrade.
   */
  readonly secondFactorUsed: boolean;
  /** When the provider says the assertion stops being valid. */
  readonly expiresAt: Date;
}

/** Why a sign-in attempt was refused. One of these, never a provider message. */
export const SIGN_IN_REFUSALS = Object.freeze([
  'not-configured',
  'invalid-token',
  'second-factor-required',
  'unknown-account',
  'store-unavailable',
] as const);
export type SignInRefusal = (typeof SIGN_IN_REFUSALS)[number];

/** Why an established session was not accepted on a request. */
export const SESSION_REFUSALS = Object.freeze([
  'absent',
  'unknown',
  'revoked',
  'expired',
  'store-unavailable',
] as const);
export type SessionRefusal = (typeof SESSION_REFUSALS)[number];

/**
 * A server-side session row.
 *
 * `id` is opaque and is the only part that travels to a client. Nothing derived
 * from the provider's token is stored beside it: knowing a session id tells an
 * attacker nothing about the identity that created it, and stealing one is
 * undone by setting `revokedAt`.
 */
export interface Session {
  readonly id: string;
  readonly accountId: string;
  readonly createdAt: Date;
  readonly expiresAt: Date;
  readonly revokedAt: Date | null;
}

/** A session that this platform currently accepts. */
export interface ActiveSession {
  readonly id: string;
  readonly accountId: string;
  readonly expiresAt: Date;
}

/**
 * Whether a stored row is usable right now.
 *
 * Expiry and revocation are checked here rather than in a query, so the rule is
 * the same whichever store answers and is testable without one. Revocation is
 * checked first because it is the stronger statement: a revoked session is
 * refused as revoked even after it would also have expired, which is what an
 * audit reader needs to see.
 */
export function sessionState(session: Session, now: Date): 'active' | 'revoked' | 'expired' {
  if (session.revokedAt !== null) return 'revoked';
  if (session.expiresAt.getTime() <= now.getTime()) return 'expired';
  return 'active';
}

/**
 * Verifies a provider-issued identity token.
 *
 * The adapter behind this port is the only thing that knows the token format,
 * the issuer, the audience or where the signing keys come from. It answers with
 * a verified identity or with `null`, and never with the provider's own error
 * text: a verifier failure is this platform's `invalid-token` and nothing more
 * specific, because the difference between a wrong signature, a wrong audience
 * and an expired token is useful to an attacker and to nobody else.
 */
export interface IdentityTokenVerifier {
  verify(token: string): Promise<VerifiedIdentity | null>;
}

/**
 * Durable session storage.
 *
 * Three operations, which is the whole of what server-side revocable sessions
 * need. There is deliberately no "touch" or sliding-expiry operation: a session
 * that renewed itself on use would be a session that an unnoticed theft keeps
 * alive forever.
 */
export interface SessionStore {
  create(session: Session): Promise<void>;
  read(id: string): Promise<Session | null>;
  revoke(id: string, revokedAt: Date): Promise<void>;
}
