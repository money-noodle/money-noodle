#!/usr/bin/env node
/**
 * Rolling paper-settlement health review for the public edge strategy.
 *
 * Measures: last/prior 24-hour paper intent, fill, terminal-accounting, exact P&L, whole-cent P&L,
 * settlement latency, exit-versus-hold, bankroll tie, and exact paper/live mirror-pair fidelity.
 *
 * Deciding corrections: rows are selected by UTC contract close; return uncertainty averages rows inside
 * one close before standard error; exact and whole-cent money remain separate; partial-exit children stay
 * in accounting; paper/live pairs require their prospective exact identity and are split by paper execution
 * generation. No-fill attempts spend zero and never become losses.
 *
 * Biggest biases: the paper maker is a public-print/displayed-queue simulation without private FIFO rank or
 * cancellations; 24 hours supplies few independent filled windows; settlement latency includes provider/source
 * availability and collector scheduling; the final ledger cannot reconstruct whether a now-settled row was open
 * at an earlier historical checkpoint; exits make status win rate different from profitability.
 *
 * Read-only: reloads the durable execution ledger, writes no data, and calls no provider/order endpoint.
 * Run: npm run analyze:paper-settlement -- [optional end ISO]
 */
import { readExecutionLedger } from './lib/read-execution-ledger.mjs';

const EDGE_STRATEGY = 'edge-binary-buy';
const SLOT_MS = 15 * 60 * 1_000;
const DAY_MS = 24 * 60 * 60 * 1_000;
const TERMINAL = new Set(['won', 'lost', 'sold', 'invalid']);
const NONTERMINAL = new Set(['pending_reservation', 'uncertain', 'open']);

const requestedEnd = process.argv[2] ? Date.parse(process.argv[2]) : Math.floor(Date.now() / SLOT_MS) * SLOT_MS;
if (!Number.isFinite(requestedEnd)) throw new Error(`Invalid end time ${process.argv[2]}.`);

const ledger = await readExecutionLedger();
const allOrders = ledger.orders ?? [];
const edgeRows = allOrders.filter((order) => order.executionMode === 'paper'
  && (order.strategyId ?? EDGE_STRATEGY) === EDGE_STRATEGY);
const edgeEntries = edgeRows.filter((order) => !order.id.includes(':exit:'));
const exactStake = (order) => order.actualStakeCents ?? order.stakeCents ?? 0;
const exactPnl = (order) => order.actualPnlCents ?? order.pnlCents ?? 0;
const filled = (order) => (order.filledCount ?? 0) > 1e-8;
const paperGeneration = (order) => order.entryDecision?.executionPolicyVersion
  ?? order.executionPolicyVersion ?? 'missing';
const route = (order) => order.paperEntryRoute ?? order.entryExecutionDecision?.executedStyle
  ?? order.liquidityRole ?? 'unknown';
const within = (order, period) => {
  const close = Date.parse(order.closesAt);
  return close > period.startMs && close <= period.endMs;
};

function inferredNoFillReason(order) {
  const prose = order.reason?.toLowerCase() ?? '';
  if (prose.startsWith('taker not submitted:')) return 'pre_submit_quote_moved';
  if (prose.includes('reconciliation found no accepted') && !order.venueOrderId) return 'reconciled_absent';
  if (order.noFillReason) return order.noFillReason;
  if (prose.includes('post-only') && (prose.includes('cross') || prose.includes('acknowledgement race'))) {
    return 'post_only_race';
  }
  if (order.venueOrderId && route(order) === 'taker') return 'ioc_no_fill';
  if (order.venueOrderId) return 'rested_no_fill';
  return 'missing';
}

function clusteredReturn(rows) {
  const byClose = new Map();
  for (const order of rows) {
    const stake = exactStake(order);
    if (!(stake > 0)) continue;
    byClose.set(order.closesAt, [...(byClose.get(order.closesAt) ?? []), exactPnl(order) / stake]);
  }
  const values = [...byClose.values()].map((items) => items.reduce((sum, value) => sum + value, 0) / items.length);
  const mean = values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
  const standardError = mean !== null && values.length > 1
    ? Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0)
      / (values.length - 1) / values.length)
    : null;
  return { windows: values.length, mean, standardError };
}

function money(rows) {
  const exactStakeCents = rows.reduce((sum, order) => sum + exactStake(order), 0);
  const exactPnlCents = rows.reduce((sum, order) => sum + exactPnl(order), 0);
  return {
    rows: rows.length,
    windows: new Set(rows.map((order) => order.closesAt)).size,
    exactStakeCents,
    exactPnlCents,
    wholePnlCents: rows.reduce((sum, order) => sum + (order.pnlCents ?? 0), 0),
    aggregateRoi: exactStakeCents > 0 ? exactPnlCents / exactStakeCents : null,
    clusteredReturn: clusteredReturn(rows),
  };
}

function groupedMoney(rows, key) {
  const groups = new Map();
  for (const order of rows) {
    const value = key(order);
    groups.set(value, [...(groups.get(value) ?? []), order]);
  }
  return Object.fromEntries([...groups.entries()].sort(([left], [right]) => left.localeCompare(right))
    .map(([keyValue, items]) => [keyValue, money(items)]));
}

function distribution(values) {
  const sorted = values.filter(Number.isFinite).sort((left, right) => left - right);
  const at = (fraction) => sorted.length ? sorted[Math.floor((sorted.length - 1) * fraction)] : null;
  return { observations: sorted.length, median: at(0.5), p90: at(0.9), p95: at(0.95), p99: at(0.99), maximum: at(1) };
}

function pollingEvidence(attempts) {
  const makers = attempts.filter((order) => route(order) === 'maker');
  const evidence = makers.flatMap((order) => order.entryExecutionObservations ?? [])
    .filter((observation) => observation.event === 'paper_trade_evidence');
  const readsPerAttempt = makers.map((order) => (order.entryExecutionObservations ?? [])
    .filter((observation) => observation.event === 'paper_trade_evidence').length);
  const unfilled = makers.filter((order) => order.status === 'unfilled');
  return {
    makerAttempts: makers.length,
    tradeReadEvidenceRows: evidence.length,
    unfilledWithAllSixTradeReads: unfilled.filter((order) => (order.entryExecutionObservations ?? [])
      .filter((observation) => observation.event === 'paper_trade_evidence').length === 6).length,
    unfilledMakerAttempts: unfilled.length,
    readsPerAttempt: distribution(readsPerAttempt),
    publicReadLatencyMs: distribution(evidence.map((observation) => Date.parse(observation.at)
      - Date.parse(observation.readStartedAt))),
    consumingPrintObservationLagMs: distribution(evidence.map((observation) => Date.parse(observation.at)
      - Date.parse(observation.lastConsumingTradeAt))),
    managerDurationMs: distribution(makers.map((order) => {
      const submittedAt = (order.entryExecutionObservations ?? [])
        .find((observation) => observation.event === 'paper_submitted')?.at;
      return Date.parse(order.makerCompletedAt) - Date.parse(submittedAt);
    })),
  };
}

const mirrorGroups = new Map();
for (const order of allOrders.filter((item) => !item.id.includes(':exit:')
  && (item.strategyId ?? EDGE_STRATEGY) === EDGE_STRATEGY && item.executionMirrorPair?.id)) {
  mirrorGroups.set(order.executionMirrorPair.id, [...(mirrorGroups.get(order.executionMirrorPair.id) ?? []), order]);
}

function mirrorFidelity(period) {
  const pairs = [];
  let unpairedOrNonUniquePairIds = 0;
  for (const rows of mirrorGroups.values()) {
    const paper = rows.filter((order) => order.executionMode === 'paper');
    const live = rows.filter((order) => order.executionMode === 'live');
    if (paper.length !== 1 || live.length !== 1) {
      if (paper.some((order) => within(order, period))) unpairedOrNonUniquePairIds += 1;
      continue;
    }
    if (!within(paper[0], period)) continue;
    if (NONTERMINAL.has(paper[0].status) || NONTERMINAL.has(live[0].status)) continue;
    pairs.push({ paper: paper[0], live: live[0] });
  }

  const summarize = (items) => {
    const cells = {
      both: { pairs: 0, paperStakeCents: 0, paperPnlCents: 0, liveStakeCents: 0, livePnlCents: 0 },
      paperOnly: { pairs: 0, paperStakeCents: 0, paperPnlCents: 0, liveStakeCents: 0, livePnlCents: 0 },
      liveOnly: { pairs: 0, paperStakeCents: 0, paperPnlCents: 0, liveStakeCents: 0, livePnlCents: 0 },
      neither: { pairs: 0, paperStakeCents: 0, paperPnlCents: 0, liveStakeCents: 0, livePnlCents: 0 },
    };
    for (const pair of items) {
      const paperFilled = filled(pair.paper), liveFilled = filled(pair.live);
      const key = paperFilled ? liveFilled ? 'both' : 'paperOnly' : liveFilled ? 'liveOnly' : 'neither';
      const cell = cells[key];
      cell.pairs += 1;
      if (paperFilled) {
        cell.paperStakeCents += exactStake(pair.paper);
        cell.paperPnlCents += exactPnl(pair.paper);
      }
      if (liveFilled) {
        cell.liveStakeCents += exactStake(pair.live);
        cell.livePnlCents += exactPnl(pair.live);
      }
    }
    const both = cells.both.pairs, paperOnly = cells.paperOnly.pairs;
    const liveOnly = cells.liveOnly.pairs, neither = cells.neither.pairs;
    return {
      pairs: items.length,
      windows: new Set(items.map((pair) => pair.paper.closesAt)).size,
      cells,
      agreement: items.length ? (both + neither) / items.length : null,
      paperCaptureOfLiveFills: both + liveOnly ? both / (both + liveOnly) : null,
      paperPositivePrecision: both + paperOnly ? both / (both + paperOnly) : null,
    };
  };

  const byGeneration = new Map();
  for (const pair of pairs) {
    const generation = paperGeneration(pair.paper);
    byGeneration.set(generation, [...(byGeneration.get(generation) ?? []), pair]);
  }
  const requestedQuantity = (order) => order.requestedQuantity ?? order.quantity;
  const acceptedSameRouteMaker = pairs.filter((pair) => Boolean(pair.live.venueOrderId)
    && route(pair.paper) === 'maker' && route(pair.live) === 'maker'
    && Math.abs(requestedQuantity(pair.paper) - requestedQuantity(pair.live)) <= 1e-8);
  const paperOnly = pairs.filter((pair) => filled(pair.paper) && !filled(pair.live));
  const liveNonAcceptanceReasons = {};
  for (const pair of paperOnly.filter((item) => !item.live.venueOrderId)) {
    const reason = inferredNoFillReason(pair.live);
    liveNonAcceptanceReasons[reason] = (liveNonAcceptanceReasons[reason] ?? 0) + 1;
  }
  return {
    unpairedOrNonUniquePairIds,
    overall: summarize(pairs),
    acceptedSameRouteMaker: summarize(acceptedSameRouteMaker),
    paperOnlyAttribution: {
      pairs: paperOnly.length,
      liveAccepted: paperOnly.filter((pair) => Boolean(pair.live.venueOrderId)).length,
      liveNotAccepted: paperOnly.filter((pair) => !pair.live.venueOrderId).length,
      liveNonAcceptanceReasons,
      routeOrQuantityMismatch: paperOnly.filter((pair) => route(pair.paper) !== route(pair.live)
        || Math.abs(requestedQuantity(pair.paper) - requestedQuantity(pair.live)) > 1e-8).length,
      paperPnlWhenLiveAcceptedCents: paperOnly.filter((pair) => Boolean(pair.live.venueOrderId))
        .reduce((sum, pair) => sum + exactPnl(pair.paper), 0),
      paperPnlWhenLiveNotAcceptedCents: paperOnly.filter((pair) => !pair.live.venueOrderId)
        .reduce((sum, pair) => sum + exactPnl(pair.paper), 0),
    },
    byPaperExecutionGeneration: Object.fromEntries([...byGeneration.entries()]
      .map(([generation, items]) => [generation, summarize(items)])),
  };
}

function periodReport(period) {
  const attempts = edgeEntries.filter((order) => within(order, period));
  // Partial reduce-only exits may create accounting children. Keep every terminal row in the money view.
  const accountingRows = edgeRows.filter((order) => within(order, period) && TERMINAL.has(order.status));
  const terminalEntries = attempts.filter((order) => TERMINAL.has(order.status));
  const fills = attempts.filter(filled);
  const noFills = attempts.filter((order) => order.status === 'unfilled');
  const noFillReasons = {};
  for (const order of noFills) {
    const reason = inferredNoFillReason(order);
    noFillReasons[reason] = (noFillReasons[reason] ?? 0) + 1;
  }

  const settlementLatencies = terminalEntries
    .filter((order) => order.status !== 'sold' && Number.isFinite(Date.parse(order.settledAt)))
    .map((order) => Date.parse(order.settledAt) - Date.parse(order.closesAt)).sort((left, right) => left - right);
  const percentile = (fraction) => settlementLatencies.length
    ? settlementLatencies[Math.floor((settlementLatencies.length - 1) * fraction)] : null;
  const exitRows = accountingRows.filter((order) => order.status === 'sold'
    && Number.isFinite(order.counterfactualHoldPnlCents));

  return {
    interval: { start: new Date(period.startMs).toISOString(), end: new Date(period.endMs).toISOString() },
    funnel: {
      attempts: attempts.length,
      attemptWindows: new Set(attempts.map((order) => order.closesAt)).size,
      fills: fills.length,
      fillRate: attempts.length ? fills.length / attempts.length : null,
      partialFills: fills.filter((order) => (order.filledCount ?? 0) + 1e-8
        < (order.requestedQuantity ?? order.quantity)).length,
      unfilled: noFills.length,
      noFillReasons,
      rejected: attempts.filter((order) => order.status === 'rejected').length,
      nonterminal: attempts.filter((order) => NONTERMINAL.has(order.status)).length,
    },
    accounting: money(accountingRows),
    entryOutcomes: {
      terminalEntries: terminalEntries.length,
      wins: terminalEntries.filter((order) => order.status === 'won').length,
      losses: terminalEntries.filter((order) => order.status === 'lost').length,
      sold: terminalEntries.filter((order) => order.status === 'sold').length,
      invalid: terminalEntries.filter((order) => order.status === 'invalid').length,
      profitable: terminalEntries.filter((order) => exactPnl(order) > 1e-9).length,
    },
    settlementLatencyMs: {
      observations: settlementLatencies.length,
      median: percentile(0.5), p95: percentile(0.95), maximum: percentile(1),
      negative: settlementLatencies.filter((value) => value < 0).length,
      over60Seconds: settlementLatencies.filter((value) => value > 60_000).length,
      over5Minutes: settlementLatencies.filter((value) => value > 5 * 60_000).length,
    },
    pollingEvidence: pollingEvidence(attempts),
    exitsVsHold: {
      rows: exitRows.length,
      actualMinusHoldCents: exitRows.reduce((sum, order) => sum + exactPnl(order)
        - order.counterfactualHoldPnlCents, 0),
    },
    byAsset: groupedMoney(accountingRows, (order) => order.symbol),
    byDirection: groupedMoney(accountingRows, (order) => order.side),
    byRoute: groupedMoney(accountingRows, route),
    byExecutionGeneration: groupedMoney(accountingRows, paperGeneration),
    byProviderVariant: groupedMoney(accountingRows,
      (order) => `${order.providerId ?? order.venue}:${order.providerVariantId ?? 'missing'}`),
    mirrorFidelity: mirrorFidelity(period),
  };
}

const periods = [
  { id: 'last24h', startMs: requestedEnd - DAY_MS, endMs: requestedEnd },
  { id: 'prior24h', startMs: requestedEnd - 2 * DAY_MS, endMs: requestedEnd - DAY_MS },
];
const open = edgeEntries.filter((order) => NONTERMINAL.has(order.status));
const overdue = open.filter((order) => Date.parse(order.closesAt) <= requestedEnd);
const openStakeCents = open.reduce((sum, order) => sum + (order.stakeCents ?? 0), 0);
const budget = ledger.paperBudget;

console.log(JSON.stringify({
  generatedAt: new Date().toISOString(),
  intervalEnd: new Date(requestedEnd).toISOString(),
  method: {
    population: 'paper edge-strategy orders keyed by UTC contract close',
    correction: 'returns averaged inside close before standard error',
    money: 'exact reporting and whole-cent budget views kept separate',
    fidelity: 'prospective exact paper/live pair identity, split by paper execution generation',
  },
  inputs: { ledgerRows: allOrders.length, paperEdgeRows: edgeRows.length, paperEdgeEntries: edgeEntries.length },
  periods: Object.fromEntries(periods.map((period) => [period.id, periodReport(period)])),
  operational: {
    currentlyOverdueWithCloseAtOrBeforeIntervalEnd: overdue.map((order) => ({
      id: order.id, symbol: order.symbol, status: order.status,
      closesAt: order.closesAt, createdAt: order.createdAt,
    })),
    openNow: open.map((order) => ({
      id: order.id, symbol: order.symbol, status: order.status,
      closesAt: order.closesAt, stakeCents: order.stakeCents,
    })),
    paperBudget: {
      startingCents: budget.startingCents,
      availableCents: budget.availableCents,
      realizedPnlCents: budget.realizedPnlCents,
      openStakeCents,
      availableResidualCents: budget.availableCents
        - (budget.startingCents + budget.realizedPnlCents - openStakeCents),
      resets: budget.resets ?? 0,
    },
  },
}, null, 2));
