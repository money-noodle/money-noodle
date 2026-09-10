import { readFileSync } from 'node:fs';

import { createGetPlatformStatus } from '../../application/get-platform-status.js';
import { createPlatformApiContract } from '../contract/platform-api-contract.js';
import { createHttpServer } from '../http/create-http-server.js';
import { readRuntimeConfig } from './read-runtime-config.js';

// Validate all configuration before reading the contract or constructing a server.
export function createConfiguredServer(env: Readonly<Record<string, string | undefined>>) {
  const config = readRuntimeConfig(env);
  const contract = createPlatformApiContract(readFileSync(config.contractPath, 'utf8'));
  const getPlatformStatus = createGetPlatformStatus({
    clock: { now: () => new Date() },
    service: config.service,
    stateReader: { read: () => 'available' },
  });
  const server = createHttpServer({ contract, getPlatformStatus, service: config.service });
  return { config, server };
}
