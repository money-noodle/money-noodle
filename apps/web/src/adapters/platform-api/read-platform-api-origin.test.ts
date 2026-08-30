import { describe, expect, it } from 'vitest';

import { readPlatformApiOrigin } from './read-platform-api-origin';

describe('readPlatformApiOrigin', () => {
  it('uses the local API only outside production', () => {
    expect(readPlatformApiOrigin(undefined, 'development')).toBe('http://127.0.0.1:3001');
  });

  it('requires explicit production configuration', () => {
    expect(() => readPlatformApiOrigin(undefined, 'production')).toThrow(
      'PLATFORM_API_ORIGIN is required',
    );
  });

  it('accepts a credential-free HTTPS origin and explicit local loopback', () => {
    expect(readPlatformApiOrigin('https://api.example.test', 'production')).toBe(
      'https://api.example.test',
    );
    expect(readPlatformApiOrigin('http://127.0.0.1:3001', 'production')).toBe(
      'http://127.0.0.1:3001',
    );
  });

  it.each([
    'http://api.example.test',
    'https://user:secret@api.example.test',
    'https://api.example.test/v1',
    'https://api.example.test?secret=value',
    'not a URL',
  ])('rejects unsafe API origin %s', (value) => {
    expect(() => readPlatformApiOrigin(value, 'production')).toThrow('PLATFORM_API_ORIGIN');
  });
});
