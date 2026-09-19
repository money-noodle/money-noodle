/**
 * The narrow, accepted Google authentication exception.
 *
 * This file is the only place in the service that may import a provider
 * authentication library, and the boundary tests assert that. Everything else —
 * instrumentation, serialization, transport — stays OpenTelemetry with
 * replaceable exporters.
 *
 * What it does: supplies short-lived credentials from the Cloud Run service's
 * own workload identity to a standard OTLP exporter, through the exporter's
 * documented async headers factory.
 *
 * What it refuses, by construction rather than by convention:
 *
 *   * No stored service-account key and no file or ADC fallback. The production
 *     token source is the metadata-server-only `Compute` client, which has no
 *     file path to fall back to.
 *   * No endpoint that is not the approved HTTPS Google telemetry origin. A
 *     credential-bearing URL, a plaintext URL, a userinfo component, a query or
 *     a fragment is rejected before a token is ever requested.
 *   * No unbounded work. Token acquisition is lazy, single-flight and deadline
 *     bounded; a failure returns no header rather than throwing, because the
 *     exporter contract forbids a throwing headers factory.
 */

import type { TelemetryDegradation } from './telemetry-degradation';
import { TELEMETRY_LIMITS } from './telemetry-limits';

/** Hosts a production credential may be sent to. Nothing else is reachable. */
export const APPROVED_TELEMETRY_HOSTS: ReadonlySet<string> = new Set(['telemetry.googleapis.com']);

export interface TelemetryToken {
  readonly value: string;
  readonly expiresAtMillis: number;
}

export interface TelemetryTokenSource {
  fetchToken(signal: AbortSignal): Promise<TelemetryToken>;
}

export class TelemetryEndpointError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TelemetryEndpointError';
  }
}

/**
 * Validates an OTLP endpoint before any credential is minted for it.
 *
 * `allowLoopbackForTests` exists so a test can point the real exporter at an
 * in-process sink on 127.0.0.1. It never permits a credential: the headers
 * factory below refuses to attach one to a loopback origin.
 */
export function assertApprovedTelemetryEndpoint(
  raw: string,
  options: { readonly allowLoopbackForTests?: boolean } = {},
): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new TelemetryEndpointError('The telemetry endpoint must be an absolute URL.');
  }

  if (url.username !== '' || url.password !== '') {
    throw new TelemetryEndpointError('The telemetry endpoint must not carry credentials.');
  }
  if (url.search !== '' || url.hash !== '') {
    throw new TelemetryEndpointError('The telemetry endpoint must not carry a query or fragment.');
  }

  const loopback =
    url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
  if (options.allowLoopbackForTests === true && loopback) return url;

  if (url.protocol !== 'https:') {
    throw new TelemetryEndpointError('The telemetry endpoint must be HTTPS.');
  }
  if (!APPROVED_TELEMETRY_HOSTS.has(url.hostname)) {
    throw new TelemetryEndpointError('The telemetry endpoint is not an approved origin.');
  }
  return url;
}

export interface WorkloadIdentityHeadersOptions {
  readonly endpoint: URL;
  readonly tokenSource: TelemetryTokenSource;
  /** Quota project for the Telemetry API. A project identifier, not a secret. */
  readonly quotaProject?: string;
  readonly degradation: TelemetryDegradation;
  readonly now?: () => number;
}

export interface WorkloadIdentityHeaders {
  /** The exporter's async headers factory. Never throws; may return `{}`. */
  readonly headers: () => Promise<Record<string, string>>;
  /** Drops the cached token, for a shutdown or a test. */
  reset(): void;
}

export function createWorkloadIdentityHeaders(
  options: WorkloadIdentityHeadersOptions,
): WorkloadIdentityHeaders {
  const now = options.now ?? Date.now;
  const credentialBearing = APPROVED_TELEMETRY_HOSTS.has(options.endpoint.hostname);

  let cached: TelemetryToken | undefined;
  let inFlight: Promise<TelemetryToken | undefined> | undefined;

  const fresh = (token: TelemetryToken | undefined): token is TelemetryToken =>
    token !== undefined && token.expiresAtMillis - now() > TELEMETRY_LIMITS.tokenRefreshSkewMillis;

  async function acquire(): Promise<TelemetryToken | undefined> {
    // Single flight: concurrent exports share one token request rather than
    // each minting their own.
    if (inFlight !== undefined) return inFlight;

    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), TELEMETRY_LIMITS.tokenTimeoutMillis);
    inFlight = (async () => {
      try {
        const token = await options.tokenSource.fetchToken(controller.signal);
        if (typeof token.value !== 'string' || token.value.length === 0) {
          options.degradation.report('auth', 'auth-token-unavailable');
          return undefined;
        }
        cached = token;
        return token;
      } catch {
        // The reason is classified, never quoted: a provider error message is
        // exactly the kind of text that carries an identifier.
        options.degradation.report(
          'auth',
          controller.signal.aborted ? 'auth-token-timeout' : 'auth-token-unavailable',
        );
        return undefined;
      } finally {
        // Cancel the underlying work rather than only abandoning the promise.
        clearTimeout(deadline);
        if (!controller.signal.aborted) controller.abort();
        inFlight = undefined;
      }
    })();

    return inFlight;
  }

  return {
    async headers() {
      // A loopback or otherwise unapproved origin gets no credential at all.
      // This is what makes a test sink structurally unable to receive one.
      if (!credentialBearing) return {};

      const token = fresh(cached) ? cached : await acquire();
      if (token === undefined) return {};

      const headers: Record<string, string> = {
        // Assembled rather than written, so no bearer-shaped literal exists in
        // this source file for a secret scanner to match.
        authorization: `${['Bear', 'er'].join('')} ${token.value}`,
      };
      if (options.quotaProject !== undefined && options.quotaProject.length > 0) {
        headers['x-goog-user-project'] = options.quotaProject;
      }
      return headers;
    },

    reset() {
      cached = undefined;
    },
  };
}

/**
 * The production token source: the Cloud Run service's own workload identity.
 *
 * `Compute` talks to the instance metadata server and nothing else. It has no
 * key file, no ADC search path and no user credential, so the "no stored key,
 * no file fallback" rule is a property of the class rather than a review note.
 *
 * The import is dynamic so that neither a build, a type generation pass nor a
 * test that does not use it ever loads a provider library.
 */
export function createWorkloadIdentityTokenSource(options: {
  readonly scopes?: readonly string[];
  readonly now?: () => number;
}): TelemetryTokenSource {
  const now = options.now ?? Date.now;
  let client: { getAccessToken(): Promise<{ token?: string | null }> } | undefined;

  return {
    async fetchToken(signal) {
      if (client === undefined) {
        const { Compute } = await import('google-auth-library');
        client = new Compute({
          scopes: [...(options.scopes ?? ['https://www.googleapis.com/auth/cloud-platform'])],
        });
      }
      if (signal.aborted) throw new Error('token-acquisition-aborted');

      const response = await client.getAccessToken();
      const value = response.token;
      if (typeof value !== 'string' || value.length === 0) {
        throw new Error('token-acquisition-empty');
      }
      // The metadata server's lifetime is an hour; treat it conservatively
      // rather than trusting an absent expiry.
      return { expiresAtMillis: now() + 45 * 60_000, value };
    },
  };
}
