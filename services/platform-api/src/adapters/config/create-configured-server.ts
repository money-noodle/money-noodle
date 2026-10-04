import { readFileSync } from 'node:fs';

import { createCheckProjectionReadiness } from '../../application/check-projection-readiness.js';
import { createGetPlatformStatus } from '../../application/get-platform-status.js';
import type { PaperProjectionPort } from '../../domain/paper-projection.js';
import { createPlatformApiContract } from '../contract/platform-api-contract.js';
import { createHttpServer } from '../http/create-http-server.js';
import { createPostgresProjectionClient } from '../projection/postgres-client.js';
import { createPostgresPaperProjection } from '../projection/postgres-paper-projection.js';
import { expectedTableList, readProjectionConfig } from '../projection/read-projection-config.js';
import {
  createTelemetry,
  type CreateTelemetryOptions,
  type Telemetry,
} from '../telemetry/create-telemetry.js';
import { readTelemetryConfig } from '../telemetry/read-telemetry-config.js';
import { readRuntimeConfig } from './read-runtime-config.js';

export interface ConfiguredServerOverrides {
  /**
   * Test seam for the telemetry composition: in-memory or loopback transports
   * and a synthetic token source. Production passes nothing and gets the real
   * OTLP exporters and the workload-identity token source.
   */
  readonly telemetry?: Pick<
    CreateTelemetryOptions,
    'exporters' | 'tokenSource' | 'degradationSink' | 'allowLoopbackEndpointForTests' | 'endpoint'
  >;
  /**
   * Test seam for the projection port, so readiness can be exercised against a
   * double. `null` is "configured as absent" and is distinct from omitting the
   * override, which lets the environment decide.
   */
  readonly projection?: PaperProjectionPort | null;
}

// Validate all configuration before reading the contract or constructing a
// server. Telemetry is initialized first so the server is constructed with it
// already available, never retrofitted onto a listening server.
export async function createConfiguredServer(
  env: Readonly<Record<string, string | undefined>>,
  overrides: ConfiguredServerOverrides = {},
): Promise<{
  config: ReturnType<typeof readRuntimeConfig>;
  projection: PaperProjectionPort | null;
  server: ReturnType<typeof createHttpServer>;
  telemetry: Telemetry;
}> {
  const config = readRuntimeConfig(env);
  const telemetryConfig = readTelemetryConfig(env, {
    serviceName: config.service.name,
    serviceVersion: config.service.version,
  });
  const telemetry = await createTelemetry({
    ...(telemetryConfig.endpoint === undefined ? {} : { endpoint: telemetryConfig.endpoint }),
    identity: {
      environment: telemetryConfig.environment,
      imageDigest: telemetryConfig.imageDigest,
      runtimeRevision: telemetryConfig.runtimeRevision,
      serviceName: telemetryConfig.serviceName,
      serviceVersion: telemetryConfig.serviceVersion,
      sourceCommit: telemetryConfig.sourceCommit,
    },
    ...(telemetryConfig.quotaProject === undefined
      ? {}
      : { quotaProject: telemetryConfig.quotaProject }),
    samplingRatio: telemetryConfig.samplingRatio,
    ...overrides.telemetry,
  });

  // The projection is configured by a Secret Manager reference the maintainer
  // fills out of band, so an absent connection string is a legitimate state, not
  // a misconfiguration (#209). The adapter connects lazily; constructing it
  // reaches no database.
  const projectionConfig = readProjectionConfig(env);
  const projection =
    overrides.projection !== undefined
      ? overrides.projection
      : projectionConfig.connectionString === undefined
        ? null
        : createPostgresPaperProjection({
            client: createPostgresProjectionClient(projectionConfig.connectionString),
            schema: projectionConfig.schema,
            tables: projectionConfig.tables,
          });

  const checkReadiness = createCheckProjectionReadiness({
    expectedTables: expectedTableList(projectionConfig.tables),
    projection,
    // This slice adds no read endpoint (#210 does), so a revision with no
    // projection configured still serves its entire declared contract and is
    // honestly ready. The day a read endpoint depends on the projection, this
    // becomes `false` and a missing projection is an unready revision.
    readyWithoutProjection: true,
  });

  const contract = createPlatformApiContract(readFileSync(config.contractPath, 'utf8'));
  const getPlatformStatus = createGetPlatformStatus({
    clock: { now: () => new Date() },
    service: config.service,
    stateReader: { read: () => 'available' },
  });
  const server = createHttpServer({
    checkReadiness,
    contract,
    getPlatformStatus,
    service: config.service,
    telemetry,
  });
  return { config, projection, server, telemetry };
}
