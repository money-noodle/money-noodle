// Identity configuration, read once at startup.
//
// Same custody shape as the projection's connection string (ADR-0005, ADR-0012):
// every value arrives as an environment variable bound from a Secret Manager
// reference, this module holds only the variable *names*, and nothing here is
// logged, echoed or put into an error. The audience is the one value this file
// validates beyond presence, and it validates the shape rather than the value, so
// a mistyped variable fails at startup instead of failing every sign-in.
//
// Absent configuration is a legitimate state, not a misconfiguration: the
// container exists before the maintainer enters a version, and a revision running
// without it serves the public dashboard and answers the signed-in routes with
// "not configured" (ADR-0013 §4).

/**
 * The audience the provider's tokens must be addressed to.
 *
 * Bound from Secret Manager by `infra/stacks/api`. It is not secret in the way a
 * connection string is, but it is an environment identifier, and SECURITY.md
 * keeps those out of the repository, so it travels the same way everything else
 * does.
 */
export const IDENTITY_AUDIENCE_ENV = 'PLATFORM_API_IDENTITY_AUDIENCE';

/** The exact issuer the provider stamps into its tokens. */
export const IDENTITY_ISSUER_ENV = 'PLATFORM_API_IDENTITY_ISSUER';

/** The one account this platform has (ADR-0013 §4). */
export const IDENTITY_ACCOUNT_ENV = 'PLATFORM_API_IDENTITY_ACCOUNT_ID';

/**
 * Where the provider publishes its current signing certificates.
 *
 * Configurable with the provider's documented public endpoint as the default,
 * because a key-rotation endpoint moving should not need a code release, and
 * because a test must be able to point it somewhere that is not the internet.
 * Only `https` is accepted: a key fetched over plain HTTP is a key an attacker
 * can choose.
 */
export const IDENTITY_KEYS_URL_ENV = 'PLATFORM_API_IDENTITY_KEYS_URL';

export const DEFAULT_IDENTITY_KEYS_URL =
  'https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com';

export interface IdentityConfig {
  /** Present only when every required value was configured. */
  readonly accountId: string | undefined;
  readonly audience: string | undefined;
  readonly issuer: string | undefined;
  readonly keysUrl: string;
}

// A bounded printable token with no whitespace. Deliberately narrower than the
// provider allows: every real value fits, and anything that does not is far more
// likely to be a value pasted into the wrong variable.
const BOUNDED_VALUE = /^[A-Za-z0-9._:\-/]{1,200}$/u;

function bounded(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
): string | undefined {
  const value = env[name];
  if (value === undefined || value.trim().length === 0) return undefined;
  if (!BOUNDED_VALUE.test(value)) {
    // Names the variable, never its value.
    throw new Error(`${name} must be a bounded identifier with no whitespace.`);
  }
  return value;
}

export function readIdentityConfig(
  env: Readonly<Record<string, string | undefined>>,
): IdentityConfig {
  const configuredKeysUrl = env[IDENTITY_KEYS_URL_ENV];
  const keysUrl =
    configuredKeysUrl === undefined || configuredKeysUrl.trim().length === 0
      ? DEFAULT_IDENTITY_KEYS_URL
      : configuredKeysUrl;

  if (!keysUrl.startsWith('https://')) {
    throw new Error(`${IDENTITY_KEYS_URL_ENV} must be an https URL.`);
  }

  return Object.freeze({
    accountId: bounded(env, IDENTITY_ACCOUNT_ENV),
    audience: bounded(env, IDENTITY_AUDIENCE_ENV),
    issuer: bounded(env, IDENTITY_ISSUER_ENV),
    keysUrl,
  });
}

/** Whether this revision can verify a token at all. */
export function identityConfigured(config: IdentityConfig): boolean {
  return (
    config.accountId !== undefined && config.audience !== undefined && config.issuer !== undefined
  );
}
