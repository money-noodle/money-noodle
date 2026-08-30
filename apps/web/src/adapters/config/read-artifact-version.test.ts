import { describe, expect, it } from 'vitest';

import { readArtifactVersion } from './read-artifact-version';

describe('readArtifactVersion', () => {
  it('reads an attributable version and supports local development', () => {
    expect(readArtifactVersion('git-abc1234')).toBe('git-abc1234');
    expect(readArtifactVersion(undefined)).toBe('development');
  });

  it.each(['', '../secret', 'has spaces', 'x'.repeat(65)])('rejects unsafe value %j', (value) => {
    expect(() => readArtifactVersion(value)).toThrow('ARTIFACT_VERSION');
  });
});
