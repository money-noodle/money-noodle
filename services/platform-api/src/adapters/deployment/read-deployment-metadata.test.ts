import { describe, expect, it } from 'vitest';

import { readDeploymentMetadata } from './read-deployment-metadata.js';

describe('readDeploymentMetadata', () => {
  it('reads a release label rather than treating it as a SHA', () => {
    expect(readDeploymentMetadata('release-1.2.3+api', 'production')).toEqual({
      name: 'platform-api',
      version: 'release-1.2.3+api',
    });
    expect(readDeploymentMetadata('a'.repeat(64), 'production').version).toHaveLength(64);
  });
  it.each(['development', 'test'])('defaults only in explicit %s', (mode) => {
    expect(readDeploymentMetadata(undefined, mode).version).toBe('development');
    expect(readDeploymentMetadata('development', mode).version).toBe('development');
  });
  it.each([undefined, '', 'development', '../secret', 'has spaces', 'x'.repeat(65)])(
    'rejects invalid production versions',
    (value) =>
      expect(() => readDeploymentMetadata(value, 'production')).toThrow('ARTIFACT_VERSION'),
  );
  it.each([undefined, '', 'preview', 'Production'])('rejects invalid modes', (mode) => {
    expect(() => readDeploymentMetadata('v1', mode)).toThrow('NODE_ENV');
  });
  it('does not default an invalid supplied local value', () => {
    expect(() => readDeploymentMetadata('', 'test')).toThrow('ARTIFACT_VERSION');
  });
});
