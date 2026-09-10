import type { ServiceDescriptor } from '../../domain/platform-status.js';

const VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/u;

export function readDeploymentMetadata(
  value: string | undefined,
  nodeEnvironment: string | undefined,
): ServiceDescriptor {
  const local = nodeEnvironment === 'development' || nodeEnvironment === 'test';
  if (!local && nodeEnvironment !== 'production') throw new Error('NODE_ENV is invalid.');
  const version = value === undefined && local ? 'development' : value;
  if (
    version === undefined ||
    !VERSION_PATTERN.test(version) ||
    (!local && version === 'development')
  ) {
    throw new Error('ARTIFACT_VERSION is invalid.');
  }
  return { name: 'platform-api', version };
}
