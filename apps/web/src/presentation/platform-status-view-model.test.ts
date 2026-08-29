import { describe, expect, it } from 'vitest';

import { presentPlatformStatus } from './platform-status-view-model';

const source = {
  asOf: '2026-08-29T20:00:00.000Z',
  serviceVersion: 'git-abc1234',
};

describe('presentPlatformStatus', () => {
  it.each([
    ['available', 'Available', 'normal availability'],
    ['degraded', 'Degraded', 'reduced availability'],
    ['maintenance', 'Maintenance', 'planned maintenance'],
  ] as const)('presents %s explicitly in text', (state, label, explanation) => {
    expect(presentPlatformStatus({ ...source, state })).toMatchObject({
      explanation: expect.stringContaining(explanation),
      label,
      state,
    });
  });

  it('uses an explicit unknown view without an observation', () => {
    expect(presentPlatformStatus(undefined)).toEqual({
      explanation: 'A current platform observation could not be verified. Please try again later.',
      label: 'Status unknown',
      state: 'unknown',
    });
  });
});
