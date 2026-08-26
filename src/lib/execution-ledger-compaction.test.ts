import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import {
  compactExecutionLedgerAt, restoreExecutionLedgerMonolithAt, verifyExecutionLedgerAt,
} from './execution-ledger-compaction';
import { executionOrderEvidenceSealEligible } from './execution-order-evidence';
import { readExecutionLedgerFile, readHydratedExecutionOrders } from './execution-ledger-storage';
import { buildTradeTrackSummary } from './execution-report';
import { makerCohortEvidence } from './entry-execution-policy';
import type { PaperOrder } from './types';

const directories: string[] = [];
const closed = '2026-08-22T00:00:00.000Z';

function order(id: string, patch: Partial<PaperOrder> = {}): PaperOrder {
  return {
    id, executionMode: 'paper', strategyId: 'edge-binary-buy', symbol: 'BTC', venue: 'kalshi',
    contractId: `contract-${id}`, side: 'UP', status: 'won', createdAt: '2026-08-21T23:50:00.000Z',
    calculationAt: '2026-08-21T23:49:45.000Z', closesAt: closed,
    modelProbabilityUp: 0.7, confidence: 0.8,
    entryDecision: {
      version: 'entry-decision-v1', policyVersion: 'policy', executionPolicyVersion: 'execution',
      side: 'UP', selectedSideProbability: 0.7, actionableAsk: 0.4, actionableBid: 0.39,
      spread: 0.01, feeRate: 0.01, netEdge: 0.29, medianNetEdge: 0.28,
      confidence: 0.8, factors: [],
    },
    entryExecutionDecision: {
      policyVersion: 'execution', configuredMode: 'maker', executedStyle: 'maker', recommendedStyle: 'maker',
      reason: 'fixture', takerNetEdge: 0.28, medianNetEdge: 0.27, makerNetEdge: 0.29,
      makerExpectedCapturedEdge: 0.1, takerAdvantage: 0.18, makerCohort: '25-50c · 1-2c',
      makerSamples: 3, makerFillRate: 1 / 3,
    },
    entryExecutionObservations: [{ at: '2026-08-21T23:50:01.000Z', event: 'terminal_fill', filledCount: 1 }],
    positionObservations: [{
      at: '2026-08-21T23:55:00.000Z', selectedBid: 0.5, selectedAsk: 0.51, spread: 0.01,
      netLiquidationCents: 50, exitFeeCents: 1, exactCostCents: 41, unrealizedPnlCents: 9,
      unrealizedReturn: 9 / 41, ownedSideProbability: 0.7, confidence: 0.8, secondsRemaining: 300,
    }],
    askPrice: 0.4, bidPrice: 0.39, spread: 0.01, quantity: 1, requestedQuantity: 1,
    stakeCents: 41, feeCents: 1, actualPurchaseCents: 40, actualFeeCents: 1,
    actualStakeCents: 41, actualPnlCents: 59, potentialPayoutCents: 100,
    filledCount: 1, venueOrderId: `venue-${id}`, venueExchangeIndex: 2,
    exitVenueOrderId: `exit-${id}`, exitVenueExchangeIndex: 2, liquidityRole: 'maker', outcome: 'UP',
    payoutCents: 100, pnlCents: 59, settledAt: '2026-08-22T00:01:00.000Z',
    ...patch,
  } as PaperOrder;
}

async function fixture(orders: PaperOrder[]): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'execution-v9-'));
  directories.push(directory);
  await writeFile(path.join(directory, 'paper-orders.json'), JSON.stringify({
    version: 8,
    paperBudget: { startingCents: 10_000, availableCents: 10_059, realizedPnlCents: 59 },
    orders, signalPersistence: {}, portfolioDecisions: {}, switchPersistence: {}, liveCorrections: [],
  }));
  return directory;
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('execution ledger v9 evidence boundary', () => {
  it('fails closed on current windows, uncertainty, and unresolved sold counterfactuals', () => {
    const base = order('base');
    expect(executionOrderEvidenceSealEligible(base, [base], Date.parse('2026-08-22T01:00:00Z'))).toBe(true);
    expect(executionOrderEvidenceSealEligible({ ...base, status: 'open' }, [base], Date.parse('2026-08-22T01:00:00Z'))).toBe(false);
    expect(executionOrderEvidenceSealEligible({ ...base, closesAt: '2026-08-22T02:00:00Z' }, [base], Date.parse('2026-08-22T01:00:00Z'))).toBe(false);
    expect(executionOrderEvidenceSealEligible({ ...base, status: 'sold', outcome: undefined }, [base], Date.parse('2026-08-22T01:00:00Z'))).toBe(false);
  });

  it('publishes batches first, preserves duplicate logical IDs by row key, and restores every heavy field', async () => {
    const rows = [order('duplicate'), order('duplicate', { createdAt: '2026-08-21T23:51:00.000Z', reason: 'second legacy row' })];
    const directory = await fixture(rows);
    const result = await compactExecutionLedgerAt(directory, { write: true, now: new Date('2026-08-22T01:00:00Z') });
    expect(result).toMatchObject({ versionBefore: 8, versionAfter: 9, orders: 2, compactedOrders: 2, wrote: true });
    expect(result.ledgerBytesAfter).toBeLessThan(result.ledgerBytesBefore);

    const compact = await readExecutionLedgerFile(directory) as { version: number; orders: PaperOrder[] };
    expect(compact.version).toBe(9);
    expect(compact.orders.map((item) => item.id)).toEqual(['duplicate', 'duplicate']);
    expect(compact.orders.every((item) => item.entryDecision === undefined && item.archivedEvidence)).toBe(true);
    expect(new Set(compact.orders.map((item) => item.archivedEvidence!.rowKey)).size).toBe(2);
    expect(buildTradeTrackSummary(compact.orders, 'paper')).toEqual(buildTradeTrackSummary(rows, 'paper'));
    expect(makerCohortEvidence(compact.orders.map((item) => ({ ...item, executionMode: 'live' })), 0.4, 0.01))
      .toEqual(makerCohortEvidence(rows.map((item) => ({ ...item, executionMode: 'live' })), 0.4, 0.01));

    const hydrated = await readHydratedExecutionOrders(directory);
    const scriptReader = await import('../../scripts/lib/read-execution-ledger.mjs');
    const scriptHydrated = await scriptReader.readExecutionLedger(directory);
    expect(scriptHydrated.orders).toEqual(hydrated);
    expect(hydrated.map((item) => item.positionObservations)).toEqual(rows.map((item) => item.positionObservations));
    expect(hydrated.map((item) => item.entryDecision)).toEqual(rows.map((item) => item.entryDecision));
    expect(await verifyExecutionLedgerAt(directory)).toMatchObject({ version: 9, orders: 2, compactOrders: 2 });
  });

  it('fails on a corrupted batch and a traversal reference', async () => {
    const directory = await fixture([order('one')]);
    await compactExecutionLedgerAt(directory, { write: true, now: new Date('2026-08-22T01:00:00Z') });
    const ledgerFile = path.join(directory, 'paper-orders.json');
    const ledger = JSON.parse(await readFile(ledgerFile, 'utf8')) as { orders: PaperOrder[] };
    const reference = ledger.orders[0].archivedEvidence!;
    const batch = path.join(directory, 'execution-order-evidence', reference.file);
    const original = await readFile(batch);
    await writeFile(batch, Buffer.concat([original, Buffer.from(' ')]));
    await expect(readExecutionLedgerFile(directory)).rejects.toThrow('checksum mismatch');

    await writeFile(batch, original);
    reference.file = '../paper-orders.json';
    await writeFile(ledgerFile, JSON.stringify(ledger));
    await expect(readExecutionLedgerFile(directory)).rejects.toThrow('filename/hash disagree');
  });

  it('rolls back by hydrating the current generation rather than copying the frozen v8 input', async () => {
    const directory = await fixture([order('before')]);
    await compactExecutionLedgerAt(directory, { write: true, now: new Date('2026-08-22T01:00:00Z') });
    const current = JSON.parse(await readFile(path.join(directory, 'paper-orders.json'), 'utf8')) as { orders: PaperOrder[] };
    current.orders.push(order('after', { status: 'unfilled', outcome: undefined, payoutCents: undefined, pnlCents: undefined }));
    await writeFile(path.join(directory, 'paper-orders.json'), JSON.stringify(current));

    await restoreExecutionLedgerMonolithAt(directory);
    const restored = JSON.parse(await readFile(path.join(directory, 'paper-orders.json'), 'utf8')) as { version: number; orders: PaperOrder[] };
    expect(restored.version).toBe(8);
    expect(restored.orders.map((item) => item.id)).toEqual(['before', 'after']);
    expect(restored.orders[0].entryDecision).toBeDefined();
    expect(restored.orders.every((item) => item.archivedEvidence === undefined)).toBe(true);
  });
});
