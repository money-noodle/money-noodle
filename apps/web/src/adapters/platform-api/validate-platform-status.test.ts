import { describe, expect, it } from 'vitest';

import { isPlatformStatus } from './validate-platform-status';

const valid = {
  asOf: '2026-08-29T20:00:00.000Z',
  requestId: 'request-123',
  schemaVersion: '1',
  service: { name: 'platform-api', version: 'git-abc1234' },
  state: 'available',
};

describe('isPlatformStatus', () => {
  it('accepts the exact governed wire shape', () => {
    expect(isPlatformStatus(valid)).toBe(true);
  });

  it.each([
    null,
    [],
    { ...valid, extra: true },
    { ...valid, state: 7 },
    { ...valid, state: 'unknown' },
    { ...valid, asOf: 7 },
    { ...valid, asOf: '2026-99-99T20:00:00Z' },
    { ...valid, schemaVersion: '2' },
    { ...valid, requestId: 7 },
    { ...valid, requestId: 'unsafe request id' },
    { ...valid, service: null },
    { ...valid, service: { ...valid.service, extra: true } },
    { ...valid, service: { ...valid.service, name: 'database' } },
    { ...valid, service: { ...valid.service, version: 7 } },
    { ...valid, service: { ...valid.service, version: '../secret' } },
  ])('rejects malformed or incompatible value %#', (value) => {
    expect(isPlatformStatus(value)).toBe(false);
  });
});
