import 'server-only';

/**
 * One telemetry registration per Node runtime.
 *
 * `src/instrumentation.ts` calls this from Next.js's `register` hook. It is
 * idempotent because the hook can run more than once in development, and
 * because a second registration would install a second exporter against the
 * same endpoint.
 *
 * Nothing here runs during a build or a type generation pass: the hook only
 * fires at runtime, the module is `server-only`, and export is disabled outright
 * when no endpoint is configured. No credential is required to start.
 */

import { createTelemetry, type CreateTelemetryOptions, type Telemetry } from './create-telemetry';
import { readTelemetryConfig } from './read-telemetry-config';
import { readArtifactVersion } from '../config/read-artifact-version';

let instance: Telemetry | undefined;
let pending: Promise<Telemetry> | undefined;

export type TelemetryOverrides = Pick<
  CreateTelemetryOptions,
  'exporters' | 'tokenSource' | 'degradationSink' | 'allowLoopbackEndpointForTests' | 'endpoint'
>;

export async function registerTelemetry(
  env: Readonly<Record<string, string | undefined>> = process.env,
  overrides: TelemetryOverrides = {},
): Promise<Telemetry> {
  if (instance !== undefined) return instance;
  // Concurrent `register` calls share one initialization rather than racing to
  // install two providers.
  if (pending !== undefined) return pending;

  pending = (async () => {
    const config = readTelemetryConfig(env, {
      serviceName: 'web',
      serviceVersion: readArtifactVersion(env.ARTIFACT_VERSION, env.NODE_ENV),
    });
    const telemetry = await createTelemetry({
      ...(config.endpoint === undefined ? {} : { endpoint: config.endpoint }),
      identity: {
        environment: config.environment,
        imageDigest: config.imageDigest,
        runtimeRevision: config.runtimeRevision,
        serviceName: config.serviceName,
        serviceVersion: config.serviceVersion,
        sourceCommit: config.sourceCommit,
      },
      ...(config.quotaProject === undefined ? {} : { quotaProject: config.quotaProject }),
      samplingRatio: config.samplingRatio,
      ...overrides,
    });
    instance = telemetry;
    pending = undefined;
    return telemetry;
  })();

  return pending;
}

/** The registered telemetry, or undefined before `registerTelemetry` has run. */
export function currentTelemetry(): Telemetry | undefined {
  return instance;
}

/** Drops the registration. Tests use this; production never calls it. */
export async function resetTelemetryForTests(): Promise<void> {
  const existing = instance;
  instance = undefined;
  pending = undefined;
  await existing?.shutdown();
}
