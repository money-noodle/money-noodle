const VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/u;

export function readArtifactVersion(value: string | undefined): string {
  const version = value ?? 'development';
  if (!VERSION_PATTERN.test(version)) throw new Error('ARTIFACT_VERSION is invalid.');
  return version;
}
