const LOCAL_API_ORIGIN = 'http://127.0.0.1:3001';

export function readPlatformApiOrigin(
  value: string | undefined,
  nodeEnvironment: string | undefined,
): string {
  const local = nodeEnvironment === 'development' || nodeEnvironment === 'test';
  if (!local && nodeEnvironment !== 'production') throw new Error('NODE_ENV is invalid.');
  if (value === undefined) {
    if (!local) throw new Error('PLATFORM_API_ORIGIN is required in production.');
    return LOCAL_API_ORIGIN;
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('PLATFORM_API_ORIGIN must be an absolute HTTP(S) origin.');
  }

  // URL canonicalization also normalizes abbreviated/integer IPv4 and IPv6 forms.
  const hostname = url.hostname.toLowerCase().replace(/\.$/u, '');
  const loopback =
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    /^127\./u.test(hostname) ||
    hostname === '[::1]' ||
    /^\[::ffff:7f[0-9a-f]{2}:/u.test(hostname);
  if (
    (url.protocol !== 'https:' && !(local && loopback && url.protocol === 'http:')) ||
    (!local && loopback) ||
    url.username !== '' ||
    url.password !== '' ||
    url.pathname !== '/' ||
    url.search !== '' ||
    url.hash !== '' ||
    value !== value.trim() ||
    /[@?#\\\s]/u.test(value) ||
    !/^https?:\/\/[^/]+\/?$/u.test(value)
  ) {
    throw new Error('PLATFORM_API_ORIGIN must be a credential-free HTTPS origin.');
  }
  return url.origin;
}
