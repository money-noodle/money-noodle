import { describe, expect, it } from 'vitest';

import {
  ACCOUNT_STORE_URL_ENV,
  DEFAULT_ACCOUNT_SCHEMA,
  readAccountStoreConfig,
} from './read-account-store-config.js';

describe('reading account store configuration', () => {
  it('treats an absent or empty reference as unconfigured', () => {
    expect(readAccountStoreConfig({}).connectionString).toBeUndefined();
    expect(
      readAccountStoreConfig({ [ACCOUNT_STORE_URL_ENV]: '  ' }).connectionString,
    ).toBeUndefined();
  });

  it('carries a configured value through without inspecting it', () => {
    expect(
      readAccountStoreConfig({ [ACCOUNT_STORE_URL_ENV]: 'postgres://x' }).connectionString,
    ).toBe('postgres://x');
  });

  it('defaults to this service’s own schema and refuses one that could carry SQL', () => {
    expect(readAccountStoreConfig({}).schema).toBe(DEFAULT_ACCOUNT_SCHEMA);
    expect(readAccountStoreConfig({ PLATFORM_API_ACCOUNT_SCHEMA: 'platform_v2' }).schema).toBe(
      'platform_v2',
    );
    expect(() =>
      readAccountStoreConfig({ PLATFORM_API_ACCOUNT_SCHEMA: 'platform"; drop schema platform --' }),
    ).toThrow('PLATFORM_API_ACCOUNT_SCHEMA');
  });
});
