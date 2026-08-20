#!/usr/bin/env node
/**
 * Re-evaluates the edge policy's XRP exclusion without changing configuration or placing orders.
 *
 * Measure:
 *   1. Historical filled XRP orders, separately for live and paper, using exact realized return and a
 *      held-to-settlement counterfactual.
 *   2. Every asset's first-to-fire v21 signal reconstructed from forecast snapshots under the current
 *      2-over-15-second persistence rule, priced at the recorded ask and held to exact venue settlement.
 *   3. Prospective XRP appearances in the immutable portfolio-choice journal, including whether removing
 *      only the asset gate would actually have reached portfolio selection.
 *
 * Deciding correction:
 *   Returns are averaged inside the correlated settlement timestamp before standard errors. Signal replay
 *   scores every first-to-fire position, not a surviving fill cohort. Live and paper remain separate.
 *
 * Biases:
 *   The v21 forecast replay is ask-priced and ignores portfolio capacity, execution selection, exits, and
 *   the newly deployed episode policy. Forecast history stores every qualified snapshot but only bounded
 *   nonqualifying samples; a gap over 30 seconds is therefore treated as a reset, but an omitted failed
 *   snapshot inside that gap could still create false persistence. Historical XRP fills predate v21 and
 *   cannot establish current execution performance. The prospective choice journal starts late on
 *   2026-08-19 and is conditional on some production order causing a choice set to be recorded.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { readForecastHistory } from './lib/forecast-history.mjs';

const DATA = path.resolve(process.cwd(), 'data');
const V21 = 'buy-binary-edge-netminus5-nocap-quality50-owned55-price5to97-late30-persist2of15-v21';
const BUCKET_MS = 15_000;
const MAX_GAP_MS = 30_000;

function cluster(items) {
  if (!items.length) return { rows: 0, windows: 0, mean: null, standardError: null };
  const byWindow = new Map();
  for (const item of items) byWindow.set(item.window, [...(byWindow.get(item.window) ?? []), item.value]);
  const values = [...byWindow.values()].map((rows) => rows.reduce((sum, value) => sum + value, 0) / rows.length);
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const standardError = values.length > 1
    ? Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1) / values.length)
    : null;
  return { rows: items.length, windows: values.length, mean, standardError };
}

const askReturn = (row) => (row.outcome === row.entrySide ? 1 : 0) / (row.entryAsk + row.entryFeeRate) - 1;
const bucket = (timestamp) => Math.floor(timestamp / BUCKET_MS) * BUCKET_MS;

function firstToFireV21(rows) {
  const groups = new Map();
  for (const row of rows) {
    if (row.policyVersion !== V21 || row.status !== 'resolved' || !row.outcome || !row.symbol || !row.closesAt) continue;
    const key = `${row.symbol}|${row.closesAt}`;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  const decisions = [];
  for (const group of groups.values()) {
    const ordered = group.sort((a, b) => Date.parse(a.issuedAt) - Date.parse(b.issuedAt));
    let side;
    let observations = [];
    for (const row of ordered) {
      const at = Date.parse(row.issuedAt);
      if (!Number.isFinite(at)) continue;
      if (!row.qualified || !row.entrySide || !(row.entryAsk > 0) || !Number.isFinite(row.entryFeeRate)) {
        side = undefined;
        observations = [];
        continue;
      }
      if (side !== row.entrySide || (observations.length && at - observations.at(-1).at > MAX_GAP_MS)) observations = [];
      side = row.entrySide;
      observations.push({ at, row });
      observations = observations.slice(-4);
      const required = observations.slice(-2);
      if (required.length < 2 || bucket(required[1].at) - bucket(required[0].at) < BUCKET_MS) continue;
      const remaining = Number.isFinite(row.secondsRemaining)
        ? row.secondsRemaining : (Date.parse(row.closesAt) - at) / 1000;
      if (remaining <= 30 || remaining > 810) continue;
      decisions.push({
        symbol: row.symbol, side: row.entrySide, closesAt: row.closesAt, issuedAt: row.issuedAt,
        outcome: row.outcome, ask: row.entryAsk, feeRate: row.entryFeeRate,
        netEdge: row.predictedEdge ?? row.probabilityUp - row.entryAsk - row.entryFeeRate,
        value: askReturn(row), window: row.closesAt,
      });
      break;
    }
  }
  return decisions;
}

function historicalOrders(orders, mode) {
  return orders.filter((order) => order.executionMode === mode && order.symbol === 'XRP'
    && order.strategyId !== 'long-shot-round-trip' && !order.id.includes(':exit:')
    && ((order.filledCount ?? 0) > 0 || ['won', 'lost', 'sold'].includes(order.status)));
}

function historicalSummary(orders) {
  const held = [];
  const realized = [];
  let stakeCents = 0;
  let realizedPnlCents = 0;
  for (const order of orders) {
    const stake = order.actualStakeCents ?? order.stakeCents;
    if (!(stake > 0)) continue;
    if (order.outcome === 'UP' || order.outcome === 'DOWN') {
      const payout = order.side === order.outcome ? order.potentialPayoutCents : 0;
      held.push({ window: order.closesAt, value: (payout - stake) / stake });
    }
    const pnl = order.actualPnlCents ?? order.pnlCents;
    if (Number.isFinite(pnl)) {
      realized.push({ window: order.closesAt, value: pnl / stake });
      stakeCents += stake;
      realizedPnlCents += pnl;
    }
  }
  return {
    filledOrders: orders.length,
    held: cluster(held),
    realized: cluster(realized),
    stakeCents,
    realizedPnlCents,
    realizedRoi: stakeCents > 0 ? realizedPnlCents / stakeCents : null,
    firstAt: orders.map((order) => order.createdAt).sort()[0] ?? null,
    lastAt: orders.map((order) => order.createdAt).sort().at(-1) ?? null,
    policyVersions: [...new Set(orders.map((order) => order.entryDecision?.policyVersion ?? 'legacy'))].sort(),
  };
}

async function prospectiveChoiceSets() {
  const journalPath = path.join(DATA, 'portfolio-choice-sets.journal.jsonl');
  let text;
  try { text = await readFile(journalPath, 'utf8'); } catch { return { records: 0, xrpCandidateRows: 0, uniqueCandidates: 0, eligible: 0, portfolioSelected: 0, resolved: 0, askScore: cluster([]) }; }
  const lines = text.split('\n').filter(Boolean).map((line) => JSON.parse(line));
  const decisions = lines.filter((entry) => entry.op === 'decision').map((entry) => entry.value);
  const outcomes = new Map(lines.filter((entry) => entry.op === 'resolution')
    .map((entry) => [`${entry.recordId}|${entry.candidateId}`, entry.outcome]));
  const candidates = decisions.flatMap((record) => (record.candidates ?? [])
    .filter((candidate) => candidate.symbol === 'XRP')
    .map((candidate) => ({ record, candidate, outcome: outcomes.get(`${record.id}|${candidate.id}`) })));
  const unique = new Map();
  for (const item of candidates) if (!unique.has(item.candidate.id)) unique.set(item.candidate.id, item);
  const resolved = [...unique.values()].filter((item) => item.outcome === 'UP' || item.outcome === 'DOWN');
  const scoreable = resolved.filter((item) => item.candidate.eligibility?.eligible
    && item.candidate.retry?.allowed && item.candidate.regimeAdmitted && item.candidate.actionableAsk > 0);
  return {
    records: decisions.length,
    xrpCandidateRows: candidates.length,
    uniqueCandidates: unique.size,
    eligible: [...unique.values()].filter((item) => item.candidate.eligibility?.eligible).length,
    portfolioSelected: [...unique.values()].filter((item) => item.candidate.portfolioState === 'portfolio-selected').length,
    resolved: resolved.length,
    scoreableResolved: scoreable.length,
    askScore: cluster(scoreable.map(({ candidate, outcome }) => ({
      window: candidate.closesAt,
      value: (outcome === candidate.side ? 1 : 0) / (candidate.actionableAsk + candidate.feeRate) - 1,
    }))),
    candidates: [...unique.values()].map(({ candidate, outcome }) => ({
      id: candidate.id, outcome: outcome ?? null, eligible: candidate.eligibility?.eligible ?? false,
      assetAdmitted: candidate.assetAdmitted, portfolioState: candidate.portfolioState,
      portfolioReason: candidate.portfolioReason,
    })),
  };
}

const [forecasts, ledger, prospective] = await Promise.all([
  readForecastHistory(DATA),
  readFile(path.join(DATA, 'paper-orders.json'), 'utf8').then(JSON.parse),
  prospectiveChoiceSets(),
]);
const decisions = firstToFireV21(forecasts);
const byAsset = Object.fromEntries([...new Set(decisions.map((row) => row.symbol))].sort().map((symbol) => {
  const rows = decisions.filter((row) => row.symbol === symbol);
  return [symbol, {
    ...cluster(rows),
    wins: rows.filter((row) => row.outcome === row.side).length,
    days: new Set(rows.map((row) => row.closesAt.slice(0, 10))).size,
    meanNetEdge: rows.length ? rows.reduce((sum, row) => sum + row.netEdge, 0) / rows.length : null,
  }];
}));
const xrp = decisions.filter((row) => row.symbol === 'XRP');
const nonXrp = decisions.filter((row) => row.symbol !== 'XRP');
const nonXrpByWindow = new Map();
for (const row of nonXrp) nonXrpByWindow.set(row.window, [...(nonXrpByWindow.get(row.window) ?? []), row.value]);
const pairedXrpMinusNonXrp = xrp.flatMap((row) => {
  const peers = nonXrpByWindow.get(row.window);
  return peers?.length ? [{ window: row.window, value: row.value - peers.reduce((sum, value) => sum + value, 0) / peers.length }] : [];
});

console.log(JSON.stringify({
  generatedAt: new Date().toISOString(),
  inputs: { orders: ledger.orders.length, resolvedForecasts: forecasts.filter((row) => row.status === 'resolved').length },
  historicalFilledXrp: {
    live: historicalSummary(historicalOrders(ledger.orders, 'live')),
    paper: historicalSummary(historicalOrders(ledger.orders, 'paper')),
  },
  currentV21FirstToFireAskPriced: {
    method: '2 qualifying snapshots over 15s; first side to fire per asset/window; 90s warm-up; 30s cutoff',
    xrp: {
      ...cluster(xrp), wins: xrp.filter((row) => row.outcome === row.side).length,
      days: new Set(xrp.map((row) => row.closesAt.slice(0, 10))).size,
      firstAt: xrp.map((row) => row.issuedAt).sort()[0] ?? null,
      lastAt: xrp.map((row) => row.issuedAt).sort().at(-1) ?? null,
    },
    nonXrp: cluster(nonXrp),
    pairedXrpMinusNonXrp: cluster(pairedXrpMinusNonXrp),
    xrpSizingBands: {
      below30pp: cluster(xrp.filter((row) => row.netEdge < 0.30)),
      atLeast30pp: cluster(xrp.filter((row) => row.netEdge >= 0.30)),
    },
    byAsset,
  },
  prospectiveChoiceSets: prospective,
}, null, 2));
