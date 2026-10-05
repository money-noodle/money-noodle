// The budget row and its executions, mapped to the published view.
//
// Every figure here is synthetic: a bankroll of one dollar, a single contract, a
// fee of one and a half cents. The shapes are what matter.

import { describe, expect, it } from 'vitest';

import type { PaperBudgetRow, PaperExecutionRow } from './paper-projection.js';
import { readPaperBudget } from './read-paper-budget.js';
import { RecordShapeError } from './read-record.js';

export const syntheticBudgetRow: PaperBudgetRow = Object.freeze({
  availableCents: 85n,
  bankrollResets: 1,
  depleted: false,
  equityCents: 100n,
  openOrders: 1,
  proposedStakeCents: 85n,
  realizedPnlCents: '-3.5',
  reservedCents: 15n,
  running: true,
  settledOrders: 2,
  sourceUpdatedAt: new Date('2026-10-05T06:10:00.000Z'),
  startingCents: 100n,
});

export const syntheticOpenExecution: PaperExecutionRow = Object.freeze({
  askPrice: '0.6150',
  closesAt: new Date('2026-10-05T07:00:00.000Z'),
  createdAt: new Date('2026-10-05T06:00:00.000Z'),
  executionKey: '2026-10-05T06:00:00.000Z:EXAMPLE:UP:kalshi',
  feeCents: '1.5',
  liquidityRole: null,
  noFillReason: null,
  outcome: null,
  pnlCents: null,
  quantity: '1',
  side: 'UP',
  sourceUpdatedAt: new Date('2026-10-05T06:10:00.000Z'),
  stakeCents: '15',
  status: 'open',
  symbol: 'EXAMPLE',
  venue: 'kalshi',
});

export const syntheticSettledExecution: PaperExecutionRow = Object.freeze({
  ...syntheticOpenExecution,
  executionKey: '2026-10-05T05:00:00.000Z:EXAMPLE:DOWN:polymarket',
  liquidityRole: 'maker',
  noFillReason: 'rested_no_fill',
  outcome: 'DOWN',
  pnlCents: '-15',
  side: 'DOWN',
  status: 'lost',
  venue: 'polymarket',
});

describe('readPaperBudget', () => {
  it('publishes the budget with its own source time and exact amounts', () => {
    const budget = readPaperBudget(syntheticBudgetRow, []);

    expect(budget).toEqual({
      availableCents: 85,
      bankrollResets: 1,
      depleted: false,
      durable: true,
      equityCents: 100,
      openOrders: 1,
      proposedStakeCents: 85,
      realizedPnlCents: -3.5,
      recentExecutions: [],
      reservedCents: 15,
      running: true,
      settledOrders: 2,
      // v1 hid this. Disclosed here, and still never judged: no threshold is
      // applied and no record is withheld for being old.
      sourceUpdatedAt: '2026-10-05T06:10:00.000Z',
      startingCents: 100,
    });
  });

  it('omits a nullable execution field rather than publishing null for it', () => {
    const [execution] = readPaperBudget(syntheticBudgetRow, [
      syntheticOpenExecution,
    ]).recentExecutions;

    expect(execution).toEqual({
      askPrice: 0.615,
      closesAt: '2026-10-05T07:00:00.000Z',
      createdAt: '2026-10-05T06:00:00.000Z',
      executionKey: '2026-10-05T06:00:00.000Z:EXAMPLE:UP:kalshi',
      feeCents: 1.5,
      quantity: 1,
      side: 'UP',
      stakeCents: 15,
      status: 'open',
      symbol: 'EXAMPLE',
      venue: 'kalshi',
    });
    // Absent, not null: the source distinguishes "not known yet" from "known to be
    // nothing", and so does this.
    expect(Object.keys(execution ?? {})).not.toContain('pnlCents');
    expect(JSON.stringify(execution)).not.toContain('null');
  });

  it('publishes every conditional field once the source has one', () => {
    const [execution] = readPaperBudget(syntheticBudgetRow, [
      syntheticSettledExecution,
    ]).recentExecutions;

    expect(execution).toMatchObject({
      liquidityRole: 'maker',
      noFillReason: 'rested_no_fill',
      outcome: 'DOWN',
      pnlCents: -15,
    });
  });

  it('keeps the order the source read them in, newest first', () => {
    const budget = readPaperBudget(syntheticBudgetRow, [
      syntheticOpenExecution,
      syntheticSettledExecution,
    ]);

    expect(budget.recentExecutions.map((row) => row.status)).toEqual(['open', 'lost']);
  });

  it('refuses an amount it cannot carry exactly, naming the field and not the value', () => {
    const row: PaperBudgetRow = { ...syntheticBudgetRow, availableCents: 9_007_199_254_740_993n };

    try {
      readPaperBudget(row, []);
      expect.unreachable('expected a refusal');
    } catch (error) {
      expect(error).toBeInstanceOf(RecordShapeError);
      expect((error as RecordShapeError).path).toBe('availableCents');
      expect((error as Error).message).not.toContain('9007199254740993');
    }
  });

  it('names the execution index when one row carries an unreadable amount', () => {
    const rows = [syntheticOpenExecution, { ...syntheticOpenExecution, stakeCents: 'fifteen' }];

    try {
      readPaperBudget(syntheticBudgetRow, rows);
      expect.unreachable('expected a refusal');
    } catch (error) {
      expect((error as RecordShapeError).path).toBe('recentExecutions[1].stakeCents');
    }
  });
});
