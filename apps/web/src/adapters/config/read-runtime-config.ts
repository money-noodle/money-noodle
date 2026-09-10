import 'server-only';

import { readPlatformApiOrigin } from '../platform-api/read-platform-api-origin';
import { readArtifactVersion } from './read-artifact-version';

export function readRuntimeConfig(env: Readonly<Record<string, string | undefined>>) {
  const mode = env.NODE_ENV;
  const version = readArtifactVersion(env.ARTIFACT_VERSION, mode);
  const local = mode === 'development' || mode === 'test';
  if (
    !local &&
    (env.MONEY_NOODLE_VERSION !== undefined || env.MONEY_NOODLE_API_BASE_URL !== undefined)
  ) {
    throw new Error('Obsolete runtime configuration is not accepted.');
  }
  const name = env.MONEY_NOODLE_SERVICE ?? (local ? 'web' : undefined);
  if (name !== 'web') throw new Error('MONEY_NOODLE_SERVICE is invalid.');
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
    service: { name, version },
    environment,
    sourceCommit,
    platformApiOrigin: readPlatformApiOrigin(env.PLATFORM_API_ORIGIN, mode),
  };
}
