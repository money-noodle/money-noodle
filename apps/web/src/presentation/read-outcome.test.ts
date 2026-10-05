// What each failure is called, and what it is allowed to say.
//
// The three read-model codes are the ones worth being strict about: the API distinguishes
// "never published" from "unreachable" from "unreadable", and collapsing them would hide
// the difference between a simulation that has not run and a database that is down.

import { describe, expect, it } from 'vitest';

import { describeReadFailure, readModelFailure, type ReadFailureKind } from './read-outcome';

describe('readModelFailure', () => {
  it('maps each published code to its own outcome', () => {
    expect(readModelFailure('MN-READ-MODEL-NOT-PUBLISHED')).toBe('read-model-not-published');
    expect(readModelFailure('MN-READ-MODEL-UNREACHABLE')).toBe('read-model-unreachable');
    expect(readModelFailure('MN-READ-MODEL-INVALID')).toBe('read-model-invalid');
  });

  it('reports any other refusal as a refusal rather than guessing', () => {
    expect(readModelFailure('MN-ROUTE-NOT-FOUND')).toBe('api-problem');
    expect(readModelFailure(undefined)).toBe('api-problem');
  });
});

describe('describeReadFailure', () => {
  const kinds: readonly ReadFailureKind[] = [
    'api-problem',
    'api-unusable',
    'read-model-invalid',
    'read-model-not-published',
    'read-model-unreachable',
    'transport',
  ];

  it('gives every outcome a distinct, calm explanation', () => {
    const explanations = kinds.map((kind) => describeReadFailure(kind).explanation);
    expect(new Set(explanations).size).toBe(kinds.length);
    for (const explanation of explanations) {
      expect(explanation).toMatch(/[.]$/u);
      // No status code, no host, no vocabulary a reader would have to be an operator for.
      expect(explanation).not.toMatch(/\b5\d\d\b|http|MN-|undefined|null/u);
    }
  });

  it('says explicitly that nothing was published rather than that a balance is zero', () => {
    expect(describeReadFailure('read-model-not-published').explanation).toContain(
      'not a zero balance',
    );
  });
});
