import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { classifySelectedAskMovement, observeEntryDirection } from './entry-direction-observation';
import type { EntryExecutionObservation } from './types';

const observation = (event: EntryExecutionObservation['event'], selectedAsk: number, patch: Partial<EntryExecutionObservation> = {}): EntryExecutionObservation => ({
  at: '2026-08-19T23:00:00.000Z', event, selectedAsk, ...patch,
});

describe('entry direction observation', () => {
  it('classifies the selected-side move at and around one cent', () => {
    expect(classifySelectedAskMovement(0.50, 0.49)?.direction).toBe('adverse');
    expect(classifySelectedAskMovement(0.50, 0.490_000_000_02)?.direction).toBe('stable');
    expect(classifySelectedAskMovement(0.50, 0.509_999_999_995)?.direction).toBe('favorable');
    expect(classifySelectedAskMovement(0.50, 0.505)?.direction).toBe('stable');
  });

  it('precommits adverse refusal without affecting stable or favorable quotes', () => {
    const adverse = observeEntryDirection(undefined, 0.50, observation('create_quote', 0.48));
    const stable = observeEntryDirection(undefined, 0.50, observation('create_quote', 0.50));
    const favorable = observeEntryDirection(undefined, 0.50, observation('create_quote', 0.53));
    expect(adverse?.preSubmit).toMatchObject({ direction: 'adverse', candidateDecision: 'refuse' });
    expect(adverse?.preSubmit?.movementCents).toBeCloseTo(-2, 9);
    expect(stable?.preSubmit).toMatchObject({ direction: 'stable', candidateDecision: 'continue' });
    expect(favorable?.preSubmit).toMatchObject({ direction: 'favorable', candidateDecision: 'continue' });
  });

  it('records only the first unfilled management direction and never turns it into production state', () => {
    const submitted = observeEntryDirection(undefined, 0.50, observation('paper_submitted', 0.50))!;
    const first = observeEntryDirection(submitted, 0.50, observation('management_quote', 0.48, { filledCount: 0 }))!;
    const later = observeEntryDirection(first, 0.50, observation('management_quote', 0.60, { filledCount: 0 }));
    expect(first.firstUnfilledManagement).toMatchObject({ direction: 'adverse', candidateDecision: 'cancel' });
    expect(later).toBe(first);
  });

  it('does not classify management after a fill or malformed observations', () => {
    const submitted = observeEntryDirection(undefined, 0.50, observation('create_quote', 0.50))!;
    expect(observeEntryDirection(submitted, 0.50, observation('management_quote', 0.48, { filledCount: 0.01 }))).toBe(submitted);
    expect(classifySelectedAskMovement(Number.NaN, 0.5)).toBeNull();
  });

  it('has no read path from its candidate decisions into money-moving modules', () => {
    const forbidden = [
      'prediction-policy.ts', 'entry-execution-policy.ts', 'entry-sizing-policy.ts', 'managed-maker.ts',
      'live-orders.ts', 'venue-fill.ts', 'portfolio-policy.ts', 'live-risk-policy.ts', 'maker-retry-policy.ts',
    ];
    for (const file of forbidden) {
      const source = readFileSync(path.join(process.cwd(), 'lib', file), 'utf8');
      expect({ file, readsDirection: source.includes('entryDirectionObservation') }).toEqual({ file, readsDirection: false });
    }
  });
});
