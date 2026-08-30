import { describe, expect, it } from 'vitest';

import { createGetPlatformStatus } from './get-platform-status.js';

describe('createGetPlatformStatus', () => {
  it('returns one current authoritative observation from its ports', () => {
    const asOf = new Date('2026-08-29T20:00:00.000Z');
    const getPlatformStatus = createGetPlatformStatus({
      clock: { now: () => asOf },
      service: { name: 'platform-api', version: 'abc1234' },
      stateReader: { read: () => 'degraded' },
    });

    expect(getPlatformStatus()).toEqual({
      asOf,
      service: { name: 'platform-api', version: 'abc1234' },
      state: 'degraded',
    });
  });
});
