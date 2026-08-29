import { describe, expect, it } from 'vitest';

import { readDeploymentMetadata } from './read-deployment-metadata.js';

describe('readDeploymentMetadata', () => {
  it('uses an explicit attributable artifact version', () => {
    expect(readDeploymentMetadata('git-abc1234')).toEqual({
      name: 'platform-api',
      version: 'git-abc1234',
    });
  });

  it('uses a safe local-development value when no artifact exists', () => {
    expect(readDeploymentMetadata(undefined).version).toBe('development');
  });

  it.each(['', '../secret', 'has spaces', 'x'.repeat(65)])(
    'rejects unsafe artifact version %j',
    (value) => {
      expect(() => readDeploymentMetadata(value)).toThrow('ARTIFACT_VERSION');
    },
  );
});
