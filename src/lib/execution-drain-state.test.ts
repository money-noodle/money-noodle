import { beforeEach, describe, expect, it } from 'vitest';
import {
  beginLiveTransaction, blockExecutionDrain, completeExecutionDrain, endLiveTransaction,
  getExecutionDrainStatus, resetExecutionDrainStateForTests, startExecutionDrain,
} from './execution-drain-state';

beforeEach(() => resetExecutionDrainStateForTests());

describe('execution drain state', () => {
  it('cannot become restart-safe until working transactions finish', () => {
    beginLiveTransaction('maker working');
    expect(getExecutionDrainStatus()).toMatchObject({ phase: 'active', workingTransactions: 1, restartSafe: false });
    startExecutionDrain('pause requested');
    expect(getExecutionDrainStatus()).toMatchObject({ phase: 'draining', workingTransactions: 1, restartSafe: false });
    endLiveTransaction();
    expect(getExecutionDrainStatus().workingTransactions).toBe(0);
    completeExecutionDrain('reconciled');
    expect(getExecutionDrainStatus()).toMatchObject({ phase: 'quiescent', workingTransactions: 0, restartSafe: true, reason: 'reconciled' });
  });

  it('marks a failed authoritative drain as not restart-safe', () => {
    startExecutionDrain('pause requested');
    blockExecutionDrain('cancellation uncertain');
    expect(getExecutionDrainStatus()).toMatchObject({ phase: 'blocked', restartSafe: false, reason: 'cancellation uncertain' });
  });
});
