import { readFileSync } from 'node:fs';

import { createGetPlatformStatus } from '../../application/get-platform-status.js';
import { createPlatformApiContract } from '../contract/platform-api-contract.js';
import { createHttpServer } from '../http/create-http-server.js';
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
}

// Validate all configuration before reading the contract or constructing a
// server. Telemetry is initialized first so the server is constructed with it
// already available, never retrofitted onto a listening server.
export async function createConfiguredServer(
  env: Readonly<Record<string, string | undefined>>,
  overrides: ConfiguredServerOverrides = {},
): Promise<{
  config: ReturnType<typeof readRuntimeConfig>;
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

  const contract = createPlatformApiContract(readFileSync(config.contractPath, 'utf8'));
  const getPlatformStatus = createGetPlatformStatus({
    clock: { now: () => new Date() },
    service: config.service,
    stateReader: { read: () => 'available' },
  });
  const server = createHttpServer({
    contract,
    getPlatformStatus,
    service: config.service,
    telemetry,
  });
  return { config, server, telemetry };
}
