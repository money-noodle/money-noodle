import { readDeploymentMetadata } from '../deployment/read-deployment-metadata.js';
import { readPort } from './read-port.js';

export function readRuntimeConfig(env: Readonly<Record<string, string | undefined>>) {
  const mode = env.NODE_ENV;
  const service = readDeploymentMetadata(env.ARTIFACT_VERSION, mode);
  const local = mode === 'development' || mode === 'test';
  if (
    !local &&
    (env.MONEY_NOODLE_VERSION !== undefined || env.MONEY_NOODLE_API_BASE_URL !== undefined)
  ) {
    throw new Error('Obsolete runtime configuration is not accepted.');
  }
  const name = env.MONEY_NOODLE_SERVICE ?? (local ? service.name : undefined);
  if (name !== service.name) throw new Error('MONEY_NOODLE_SERVICE is invalid.');
  const environment = env.MONEY_NOODLE_ENVIRONMENT ?? (local ? mode : undefined);
  if (environment !== mode) throw new Error('MONEY_NOODLE_ENVIRONMENT is invalid.');
  const sourceCommit = env.MONEY_NOODLE_COMMIT;
  if (
    (sourceCommit === undefined && !local) ||
    (sourceCommit !== undefined && !/^[0-9a-f]{40}$/u.test(sourceCommit))
  ) {
    throw new Error('MONEY_NOODLE_COMMIT is invalid.');
  }
  return {
    service,
    environment,
    sourceCommit,
    port: readPort(env.PORT),
    contractPath:
      env.PLATFORM_API_CONTRACT_PATH ?? 'services/platform-api/openapi/platform-api.v1.yaml',
  };
}
