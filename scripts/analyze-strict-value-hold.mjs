#!/usr/bin/env node
/**
 * Measure: exact settled impact of replacing each non-switch `strict-value-v1` standalone sale with
 * hold-to-settlement, over lifetime, active-buy, current-execution, fixed-last-day, and paper cohorts.
 * Deciding correction: score every actual strict-value sale, cluster normalized hold-minus-exit return by
 * settlement window, and keep exact reporting P&L separate from whole-cent budget values.
 * Main biases: disabling exits changes capital/position availability and later selection, which this direct
 * position counterfactual does not replay; active and recent cohorts are sequentially inspected; lifetime and
 * current regimes disagree; paper and live share signals and are not independent replications.
 * This script reads durable execution evidence only. It writes no data and has no order or policy authority.
 */
import path from 'node:path';
import { readExecutionLedger } from './lib/read-execution-ledger.mjs';

const ACTIVE_BUY_POLICY = 'buy-binary-edge-net5-nocap-quality50-owned55-price10to75-late30-persist2of15-v22';
const CURRENT_EXECUTION_POLICY = 'maker-then-positive-edge-taker2-terminal-refusal-v9';
const CURRENT_EXECUTION_ACTIVATED_AT = '2026-08-27T15:49:42.856Z';
const through = process.env.ANALYSIS_THROUGH ?? new Date().toISOString();
const throughMs = Date.parse(through);
if (!Number.isFinite(throughMs)) throw new Error(`Invalid ANALYSIS_THROUGH ${through}.`);
const dataDirectory = path.resolve(process.env.MONEY_NOODLE_DATA_DIR ?? path.join(process.cwd(), 'data'));
const { orders } = await readExecutionLedger(dataDirectory);

const exactPnl = (order) => order.actualPnlCents ?? order.pnlCents ?? 0;
const exactStake = (order) => order.actualStakeCents ?? order.stakeCents;
const holdMinusExit = (order) => order.counterfactualHoldPnlCents - exactPnl(order);
const normalizedClose = (value) => new Date(Date.parse(value)).toISOString();

function clustered(rows) {
  const windows = new Map();
  for (const order of rows) {
    const key = normalizedClose(order.closesAt);
    windows.set(key, [...(windows.get(key) ?? []), holdMinusExit(order) / exactStake(order)]);
  }
  const values = [...windows.values()].map((items) => items.reduce((sum, value) => sum + value, 0) / items.length);
  const mean = values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
  const standardError = mean !== null && values.length > 1
    ? Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1) / values.length)
    : null;
  return { windows: values.length, mean, standardError };
}

function summarize(label, rows) {
  const holdWinners = rows.filter((order) => order.counterfactualHoldOutcome === order.side);
  const holdLosers = rows.filter((order) => order.counterfactualHoldOutcome && order.counterfactualHoldOutcome !== order.side);
  return {
    label,
    exits: rows.length,
    profitableAtExit: rows.filter((order) => exactPnl(order) > 0).length,
    windows: new Set(rows.map((order) => normalizedClose(order.closesAt))).size,
    exactStakeCents: rows.reduce((sum, order) => sum + exactStake(order), 0),
    exitPnlCents: rows.reduce((sum, order) => sum + exactPnl(order), 0),
    holdPnlCents: rows.reduce((sum, order) => sum + order.counterfactualHoldPnlCents, 0),
    holdMinusExitCents: rows.reduce((sum, order) => sum + holdMinusExit(order), 0),
    holdBetter: rows.filter((order) => holdMinusExit(order) > 1e-9).length,
    exitBetter: rows.filter((order) => holdMinusExit(order) < -1e-9).length,
    holdWinners: {
      positions: holdWinners.length,
      holdMinusExitCents: holdWinners.reduce((sum, order) => sum + holdMinusExit(order), 0),
    },
    holdLosers: {
      positions: holdLosers.length,
      holdMinusExitCents: holdLosers.reduce((sum, order) => sum + holdMinusExit(order), 0),
    },
    meanSecondsRemaining: rows.length
      ? rows.reduce((sum, order) => sum + (Date.parse(order.closesAt) - Date.parse(order.standaloneExitAttemptedAt ?? order.settledAt)) / 1_000, 0) / rows.length
      : null,
    clusteredHoldImprovement: clustered(rows),
  };
}

const strict = orders.filter((order) => !order.id.includes(':exit:')
  && order.status === 'sold'
  && order.standaloneExitPolicy === 'strict-value-v1'
  && order.counterfactualHoldPnlCents !== undefined
  && Date.parse(order.standaloneExitAttemptedAt ?? order.settledAt ?? order.createdAt) <= throughMs);
const comparable = strict.filter((order) => !order.switchedToOrderId);
const lastDayStart = throughMs - 24 * 60 * 60 * 1_000;
const live = comparable.filter((order) => order.executionMode === 'live');
const paper = comparable.filter((order) => order.executionMode === 'paper');
const currentLive = live.filter((order) => order.entryExecutionDecision?.policyVersion === CURRENT_EXECUTION_POLICY);

console.log(JSON.stringify({
  generatedAt: new Date().toISOString(),
  fixedThrough: new Date(throughMs).toISOString(),
  inputs: {
    dataDirectory,
    executionOrders: orders.length,
    strictValueRowsWithHoldOutcome: strict.length,
    switchMechanismRowsExcluded: strict.length - comparable.length,
  },
  identities: {
    activeBuyPolicy: ACTIVE_BUY_POLICY,
    currentExecutionPolicy: CURRENT_EXECUTION_POLICY,
    currentExecutionActivatedAt: CURRENT_EXECUTION_ACTIVATED_AT,
  },
  cohorts: [
    summarize('lifetime live', live),
    summarize('active buy live', live.filter((order) => order.entryDecision?.policyVersion === ACTIVE_BUY_POLICY)),
    summarize('current execution live', currentLive),
    summarize('fixed trailing 24h live', live.filter((order) => Date.parse(order.standaloneExitAttemptedAt ?? '') >= lastDayStart)),
    summarize('active buy paper', paper.filter((order) => order.entryDecision?.policyVersion === ACTIVE_BUY_POLICY)),
    summarize('current-period paper', paper.filter((order) => Date.parse(order.createdAt) >= Date.parse(CURRENT_EXECUTION_ACTIVATED_AT))),
  ],
  currentExecutionLiveDetails: currentLive.map((order) => ({
    id: order.id,
    symbol: order.symbol,
    side: order.side,
    closesAt: order.closesAt,
    exitAt: order.standaloneExitAttemptedAt,
    secondsRemaining: (Date.parse(order.closesAt) - Date.parse(order.standaloneExitAttemptedAt)) / 1_000,
    exactStakeCents: exactStake(order),
    exitPnlCents: exactPnl(order),
    holdPnlCents: order.counterfactualHoldPnlCents,
    holdMinusExitCents: holdMinusExit(order),
    holdOutcome: order.counterfactualHoldOutcome,
  })),
}, null, 2));
