import { readFileSync } from 'node:fs';

import { readDeploymentMetadata } from './adapters/deployment/read-deployment-metadata.js';
import { readPort } from './adapters/config/read-port.js';
import { createPlatformApiContract } from './adapters/contract/platform-api-contract.js';
import { createHttpServer } from './adapters/http/create-http-server.js';
import { createGetPlatformStatus } from './application/get-platform-status.js';

const contractPath =
  process.env.PLATFORM_API_CONTRACT_PATH ?? 'services/platform-api/openapi/platform-api.v1.yaml';
const contract = createPlatformApiContract(readFileSync(contractPath, 'utf8'));
const service = readDeploymentMetadata(process.env.ARTIFACT_VERSION);
const getPlatformStatus = createGetPlatformStatus({
  clock: { now: () => new Date() },
  service,
  stateReader: { read: () => 'available' },
});
const server = createHttpServer({ contract, getPlatformStatus, service });
const port = readPort(process.env.PORT);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void server.close().finally(() => process.exit(0));
  });
}

await server.listen({ host: '0.0.0.0', port });
