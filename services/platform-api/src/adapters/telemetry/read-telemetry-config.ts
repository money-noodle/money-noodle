/**
 * Reads the telemetry configuration the infrastructure renders.
 *
 * Everything here comes from the evaluated Cloud Run environment (#69's
 * contract plus the `OTEL_*` names the module owns). Nothing is guessed: an
 * absent endpoint disables export rather than defaulting to one, and an
 * unparseable value is treated as absent rather than as a partial
 * configuration.
 */

import { TELEMETRY_LIMITS } from './telemetry-limits.js';

export interface TelemetryConfig {
  readonly endpoint: string | undefined;
  readonly serviceName: string;
  readonly serviceVersion: string;
  readonly environment: string;
  readonly sourceCommit: string | undefined;
  readonly imageDigest: string | undefined;
  readonly runtimeRevision: string | undefined;
  readonly quotaProject: string | undefined;
  readonly samplingRatio: number;
}

/** Parses `OTEL_RESOURCE_ATTRIBUTES`, which is a comma-separated `k=v` list. */
export function parseResourceAttributes(raw: string | undefined): Record<string, string> {
  if (typeof raw !== 'string' || raw.length === 0) return {};
  const attributes: Record<string, string> = {};
  for (const pair of raw.split(',')) {
    const index = pair.indexOf('=');
    if (index <= 0) continue;
    const key = pair.slice(0, index).trim();
    const value = pair.slice(index + 1).trim();
    if (key.length > 0 && value.length > 0) attributes[key] = value;
  }
  return attributes;
}

function samplingRatio(raw: string | undefined): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 1) {
    return TELEMETRY_LIMITS.defaultSamplingRatio;
  }
  return parsed;
}

export function readTelemetryConfig(
  env: Readonly<Record<string, string | undefined>>,
  fallback: { readonly serviceName: string; readonly serviceVersion: string },
): TelemetryConfig {
  const resource = parseResourceAttributes(env.OTEL_RESOURCE_ATTRIBUTES);
  const endpoint = env.OTEL_EXPORTER_OTLP_ENDPOINT;

  return {
    endpoint: typeof endpoint === 'string' && endpoint.length > 0 ? endpoint : undefined,
    environment:
      resource['deployment.environment.name'] ?? env.MONEY_NOODLE_ENVIRONMENT ?? 'unknown',
    // Cloud Run supplies the serving revision; it is a different fact from both
    // the source commit and the image digest, and is carried separately.
    imageDigest: resource['money_noodle.image_digest'],
    quotaProject: env.GOOGLE_CLOUD_QUOTA_PROJECT,
    runtimeRevision: env.K_REVISION,
    samplingRatio: samplingRatio(env.OTEL_TRACES_SAMPLER_ARG),
    serviceName: env.OTEL_SERVICE_NAME ?? fallback.serviceName,
    serviceVersion: resource['service.version'] ?? fallback.serviceVersion,
    sourceCommit: resource['money_noodle.source_commit'] ?? env.MONEY_NOODLE_COMMIT,
  };
}
