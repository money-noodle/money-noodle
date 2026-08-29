const LOCAL_API_ORIGIN = 'http://127.0.0.1:3001';

export function readPlatformApiOrigin(
  value: string | undefined,
  nodeEnvironment: string | undefined,
): string {
  if (value === undefined) {
    if (nodeEnvironment === 'production') {
      throw new Error('PLATFORM_API_ORIGIN is required in production.');
    }
    return LOCAL_API_ORIGIN;
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('PLATFORM_API_ORIGIN must be an absolute HTTP(S) origin.');
  }

  const isLocalLoopback =
    url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  const isSecure = url.protocol === 'https:';

  if (
    (!isSecure && !isLocalLoopback) ||
    url.username !== '' ||
    url.password !== '' ||
    url.pathname !== '/' ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    throw new Error('PLATFORM_API_ORIGIN must be a credential-free HTTPS origin.');
  }

  return url.origin;
}
