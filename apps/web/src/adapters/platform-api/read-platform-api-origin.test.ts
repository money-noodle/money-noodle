import { describe, expect, it } from 'vitest';

import { readPlatformApiOrigin } from './read-platform-api-origin';

describe('readPlatformApiOrigin', () => {
  it.each(['development', 'test'])('allows explicit %s defaults and local HTTP', (mode) => {
    expect(readPlatformApiOrigin(undefined, mode)).toBe('http://127.0.0.1:3001');
    expect(readPlatformApiOrigin('http://localhost:3001', mode)).toBe('http://localhost:3001');
    expect(readPlatformApiOrigin('http://[::1]:3001', mode)).toBe('http://[::1]:3001');
  });
  it.each([undefined, '', 'preview'])('rejects unknown modes', (mode) => {
    expect(() => readPlatformApiOrigin(undefined, mode)).toThrow('NODE_ENV');
  });
  it('accepts credential-free remote HTTPS origins with an optional slash', () => {
    expect(readPlatformApiOrigin('https://api.example.test/', 'production')).toBe(
      'https://api.example.test',
    );
  });
  it.each([
    undefined,
    '',
    'http://api.example.test',
    'https://user:secret@api.example.test',
    'https://@api.example.test',
    'https://:@api.example.test',
    'https://api.example.test/v1',
    'https://api.example.test/a/..',
    'https://api.example.test?secret=value',
    'https://api.example.test?',
    'https://api.example.test#',
    'https://api.example.test/#fragment',
    'not a URL',
    'https://localhost',
    'https://LOCALHOST.',
    'https://app.localhost',
    'https://127.0.0.1',
    'https://127.23.4.5',
    'https://127.1',
    'https://2130706433',
    'https://[::1]',
    'https://[0:0:0:0:0:0:0:1]',
    'https://[::ffff:127.0.0.1]',
    'http://127.0.0.1:3001',
    ' https://api.example.test',
    'https://api.example.test\\',
  ])('rejects unsafe production origins without echoing their value', (value) => {
    expect(() => readPlatformApiOrigin(value, 'production')).toThrow('PLATFORM_API_ORIGIN');
  });
  it.each(['', 'http://api.example.test', 'https://user:secret@localhost'])(
    'rejects supplied invalid local values',
    (value) => {
      expect(() => readPlatformApiOrigin(value, 'development')).toThrow('PLATFORM_API_ORIGIN');
    },
  );
});
