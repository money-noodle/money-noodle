import { describe, expect, it } from 'vitest';
import { executionSignalDisplay } from './execution-signal-display';
import type { ExecutionSignalReadiness } from './types';

const readiness = (patch: Partial<ExecutionSignalReadiness> = {}): ExecutionSignalReadiness => ({
  symbol: 'BTC', side: 'UP', closesAt: '2026-01-01T00:15:00Z', eligible: false,
  reason: 'Signal persistence 1/2 qualifying snapshots.', qualifyingSnapshots: 1,
  requiredSnapshots: 2, requiredSpanMs: 15_000, medianNetEdge: 0.18,
  ...patch,
});

describe('execution signal display', () => {
  it('uses active requirements rather than a hardcoded denominator', () => {
    expect(executionSignalDisplay(readiness()).label).toBe('confirming signal · 1 of 2');
    expect(executionSignalDisplay(readiness({ requiredSnapshots: 4 })).label).toBe('confirming signal · 1 of 4');
    expect(executionSignalDisplay(readiness({ qualifyingSnapshots: 0 })).label).toBe('new edge signal · awaiting confirmation');
  });

  it('describes fallback state instead of presenting the attempt ceiling as progress', () => {
    const liveAttempt: NonNullable<ExecutionSignalReadiness['liveAttempt']> = {
      status: 'unfilled', createdAt: '2026-01-01T00:01:00Z', quantity: 1,
      attemptNumber: 1, maximumAttempts: 2, executedStyle: 'maker', noFillReason: 'rested_no_fill',
      fallbackState: 'collecting', fallbackQualifyingSnapshots: 1, fallbackRequiredSnapshots: 2,
      reason: 'Managed maker received no fill.',
    };
    const collecting = executionSignalDisplay(readiness({ liveAttempt }));
    expect(collecting.label).toBe('maker missed · confirming fallback · 1 of 2');
    expect(collecting.label).not.toContain('1/2');
    expect(executionSignalDisplay(readiness({ liveAttempt: { ...liveAttempt, fallbackState: 'ready' } })).label)
      .toBe('taker fallback eligible · awaiting execution');
  });

  it('makes terminal no-fill outcomes explicit', () => {
    const attempt = (patch: Partial<NonNullable<ExecutionSignalReadiness['liveAttempt']>>) => readiness({
      liveAttempt: {
        status: 'unfilled', createdAt: '2026-01-01T00:01:00Z', quantity: 1,
        fallbackState: 'ended', ...patch,
      },
    });
    expect(executionSignalDisplay(attempt({ attemptNumber: 1, noFillReason: 'pre_submit_quote_moved' })).label)
      .toBe('quote moved · sequence ended');
    expect(executionSignalDisplay(attempt({ attemptNumber: 1, noFillReason: 'ioc_no_fill' })).label)
      .toBe('taker IOC no fill · sequence ended');
    expect(executionSignalDisplay(attempt({ attemptNumber: 2, noFillReason: 'ioc_no_fill' })).label)
      .toBe('fallback no fill · sequence ended');
  });
});
