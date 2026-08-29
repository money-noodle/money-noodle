import type { ServiceDescriptor } from '../../domain/platform-status.js';

const VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/u;

export function readDeploymentMetadata(value: string | undefined): ServiceDescriptor {
  const version = value ?? 'development';

  if (!VERSION_PATTERN.test(version)) {
    throw new Error(
      'ARTIFACT_VERSION must be 1 through 64 safe alphanumeric, dot, underscore, plus, or hyphen characters.',
    );
  }

  return { name: 'platform-api', version };
}
