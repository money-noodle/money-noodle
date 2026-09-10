import { describe, expect, it } from 'vitest';

import { readArtifactVersion } from './read-artifact-version';

describe('readArtifactVersion', () => {
  it('reads release labels independently of source SHA', () => {
    expect(readArtifactVersion('release-1.2.3+web', 'production')).toBe('release-1.2.3+web');
    expect(readArtifactVersion('a'.repeat(64), 'production')).toHaveLength(64);
  });

  it.each(['development', 'test'])('defaults only in explicit %s', (mode) => {
    expect(readArtifactVersion(undefined, mode)).toBe('development');
    expect(readArtifactVersion('development', mode)).toBe('development');
  });

  it.each([undefined, '', 'development', '../secret', 'has spaces', 'x'.repeat(65)])(
    'rejects invalid production versions',
    (value) => expect(() => readArtifactVersion(value, 'production')).toThrow('ARTIFACT_VERSION'),
  );
  it.each([undefined, '', 'preview', 'Production'])('rejects invalid modes', (mode) => {
    expect(() => readArtifactVersion('v1', mode)).toThrow('NODE_ENV');
  });
  it('does not default an invalid supplied local value', () => {
    expect(() => readArtifactVersion('', 'test')).toThrow('ARTIFACT_VERSION');
  });
});
