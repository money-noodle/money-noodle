import { describe, expect, it } from 'vitest';

import {
  DEFAULT_IDENTITY_KEYS_URL,
  IDENTITY_ACCOUNT_ENV,
  IDENTITY_AUDIENCE_ENV,
  IDENTITY_ISSUER_ENV,
  IDENTITY_KEYS_URL_ENV,
  identityConfigured,
  readIdentityConfig,
} from './read-identity-config.js';

const complete = {
  [IDENTITY_ACCOUNT_ENV]: 'account-under-test',
  [IDENTITY_AUDIENCE_ENV]: 'audience-under-test',
  [IDENTITY_ISSUER_ENV]: 'https://issuer.test/audience-under-test',
};

describe('reading identity configuration', () => {
  it('treats an absent or empty value as unconfigured rather than as an error', () => {
    // The Secret Manager container exists before the maintainer enters a version,
    // and an unset reference can arrive as an empty string.
    for (const env of [{}, { [IDENTITY_AUDIENCE_ENV]: '', [IDENTITY_ISSUER_ENV]: '   ' }]) {
      const config = readIdentityConfig(env);
      expect(config.audience).toBeUndefined();
      expect(config.issuer).toBeUndefined();
      expect(identityConfigured(config)).toBe(false);
    }
  });

  it('is configured only when all three values are present', () => {
    expect(identityConfigured(readIdentityConfig(complete))).toBe(true);
    for (const key of Object.keys(complete)) {
      const partial = { ...complete, [key]: '' };
      expect(identityConfigured(readIdentityConfig(partial))).toBe(false);
    }
  });

  it('defaults the key endpoint and refuses one that is not https', () => {
    expect(readIdentityConfig({}).keysUrl).toBe(DEFAULT_IDENTITY_KEYS_URL);
    expect(readIdentityConfig({ [IDENTITY_KEYS_URL_ENV]: 'https://keys.test/c' }).keysUrl).toBe(
      'https://keys.test/c',
    );
    // A key fetched over plain HTTP is a key an attacker can choose.
    expect(() => readIdentityConfig({ [IDENTITY_KEYS_URL_ENV]: 'http://keys.test/c' })).toThrow(
      IDENTITY_KEYS_URL_ENV,
    );
  });

  it('names the variable and never the value when a value is out of shape', () => {
    const bad = { [IDENTITY_AUDIENCE_ENV]: 'has a space' };
    expect(() => readIdentityConfig(bad)).toThrow(IDENTITY_AUDIENCE_ENV);
    try {
      readIdentityConfig(bad);
    } catch (error) {
      expect((error as Error).message).not.toContain('has a space');
    }
  });
});
