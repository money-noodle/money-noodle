#!/usr/bin/env node
/**
 * Replays the v22 static entry-admission change against v21 without placing orders or writing data.
 *
 * Measure:
 *   For each policy independently, take the first qualifying calculation per
 *   `(symbol, closesAt, side)`, price its best enabled actionable venue at the recorded ask plus the
 *   shared taker admission fee, and hold to the exact recorded venue outcome. Compare every v22
 *   position with v21; a v21-only position earns zero under v22.
 *
 * Deciding correction:
 *   Correlated assets in one `closesAt` share a settlement shock, so returns are averaged inside that
 *   timestamp before the mean and standard error. Both policies run first-to-fire independently: if v22
 *   refuses an early calculation but qualifies later, the later calculation is its position.
 *
 * Biases:
 *   This is retrospective screening, not promotion evidence. It is ask-priced and omits persistence,
 *   maker selection, portfolio capacity, sizing, exits, and budget reuse. Forecast history retains every
 *   qualifying calculation but only bounded nonqualifying calculations, so a candidate's first observed
 *   qualification can be later than its true first qualification. The three exclusive gate-attribution
 *   rows and the same-trigger sensitivity are diagnostics, not independent confirmation.
 */
import path from 'node:path';
import { readForecastHistory } from './lib/forecast-history.mjs';

const DATA = path.resolve(process.cwd(), 'data');
const V21 = {
  id: 'buy-binary-edge-netminus5-nocap-quality50-owned55-price5to97-late30-persist2of15-v21',
  minimumNetEdge: -0.05, minimumPrice: 0.05, maximumPrice: 0.97,
};
const V22 = {
  id: 'buy-binary-edge-net5-nocap-quality50-owned55-price10to75-late30-persist2of15-v22',
  minimumNetEdge: 0.05, minimumPrice: 0.10, maximumPrice: 0.75,
};
const MINIMUM_PROBABILITY = 0.55;
const MINIMUM_CONFIDENCE = 0.50;
const MAXIMUM_NET_EDGE = 1;

function feeRate(venue, price) {
  return venue === 'kalshi' ? 0.07 * price * (1 - price) : 0.01 * price;
}

function optionFor(row, side, policy) {
  const probability = side === 'UP' ? row.probabilityUp : 1 - row.probabilityUp;
  if (!Number.isFinite(probability) || probability < MINIMUM_PROBABILITY
    || !Number.isFinite(row.confidence) || row.confidence < MINIMUM_CONFIDENCE) return null;
  return (row.actionableVenuePrices ?? [])
    .map((option, index) => {
      const fee = feeRate(option.venue, option.price);
      return { ...option, index, fee, netEdge: probability - option.price - fee };
    })
    .filter((option) => option.side === side && Number.isFinite(option.price)
      && option.price >= policy.minimumPrice && option.price <= policy.maximumPrice
      && option.netEdge >= policy.minimumNetEdge && option.netEdge < MAXIMUM_NET_EDGE)
    .sort((left, right) => right.netEdge - left.netEdge || left.price - right.price || left.index - right.index)[0] ?? null;
}

function firstToFire(rows, policy) {
  const decisions = new Map();
  for (const row of rows) {
    if (row.status !== 'resolved' || !row.outcome || !row.symbol || !row.closesAt
      || !Number.isFinite(Date.parse(row.issuedAt))) continue;
    for (const side of ['UP', 'DOWN']) {
      const option = optionFor(row, side, policy);
      if (!option) continue;
      const outcome = row.venueOutcomes?.[option.venue]?.outcome
        ?? (row.evaluationVenue === option.venue ? row.outcome : undefined);
      // Never grade one provider's price against another provider's result. Missing exact resolution is
      // an exclusion, not permission to substitute the row's historical evaluation venue.
      if (outcome !== 'UP' && outcome !== 'DOWN') continue;
      const key = `${row.symbol}|${row.closesAt}|${side}`;
      const decision = {
        key, symbol: row.symbol, closesAt: row.closesAt, side, issuedAt: row.issuedAt,
        outcome, venue: option.venue, price: option.price, fee: option.fee,
        netEdge: option.netEdge,
      };
      const existing = decisions.get(key);
      if (!existing || decision.issuedAt < existing.issuedAt) decisions.set(key, decision);
    }
  }
  return decisions;
}

const cost = (row) => row.price + row.fee;
const roi = (row) => (row.outcome === row.side ? 1 : 0) / cost(row) - 1;
const boundedEdge = (row) => (row.outcome === row.side ? 1 : 0) - cost(row);

function cluster(rows, value) {
  if (!rows.length) return { rows: 0, windows: 0, mean: null, standardError: null };
  const byWindow = new Map();
  for (const row of rows) byWindow.set(row.closesAt, [...(byWindow.get(row.closesAt) ?? []), value(row)]);
  const values = [...byWindow.values()].map((windowRows) => windowRows.reduce((sum, item) => sum + item, 0) / windowRows.length);
  const mean = values.reduce((sum, item) => sum + item, 0) / values.length;
  const standardError = values.length > 1
    ? Math.sqrt(values.reduce((sum, item) => sum + (item - mean) ** 2, 0) / (values.length - 1) / values.length)
    : null;
  return { rows: rows.length, windows: values.length, mean, standardError };
}

function summary(rows) {
  return {
    decisions: rows.length,
    wins: rows.filter((row) => row.outcome === row.side).length,
    meanAsk: rows.length ? rows.reduce((sum, row) => sum + row.price, 0) / rows.length : null,
    roi: cluster(rows, roi),
    boundedEdge: cluster(rows, boundedEdge),
  };
}

const forecasts = await readForecastHistory(DATA);
const resolved = forecasts.filter((row) => row.status === 'resolved' && row.outcome);
const v21 = firstToFire(resolved, V21);
const v22 = firstToFire(resolved, V22);
const added = [...v22.values()].filter((row) => !v21.has(row.key));
const dropped = [...v21.values()].filter((row) => !v22.has(row.key));
const retained = [...v22.values()];
const pairedPositions = [...v21.values()].map((production) => ({
  closesAt: production.closesAt,
  production,
  candidate: v22.get(production.key),
}));

// Price gets attribution first because it is the only way to make the three rows exclusive. The edge
// cohort is therefore "inside the v22 price band but below its edge floor", not every row below 5pp.
const droppedByGate = {
  below10c: dropped.filter((row) => row.price < V22.minimumPrice),
  above75c: dropped.filter((row) => row.price > V22.maximumPrice),
  edgeBelow5ppInsideBand: dropped.filter((row) => row.price >= V22.minimumPrice
    && row.price <= V22.maximumPrice && row.netEdge < V22.minimumNetEdge),
};

// Materially different formulation: apply v22 only to v21's original firing calculation and never let it
// qualify later. This is not production's repeated evaluation, but shows how much the result depends on
// allowing a restrictive policy to fire at a later snapshot.
const sameTriggerRetained = [...v21.values()].filter((row) => row.price >= V22.minimumPrice
  && row.price <= V22.maximumPrice && row.netEdge >= V22.minimumNetEdge);
const sameTriggerRetainedKeys = new Set(sameTriggerRetained.map((row) => row.key));
const sameTriggerDropped = [...v21.values()].filter((row) => !sameTriggerRetainedKeys.has(row.key));

console.log(JSON.stringify({
  generatedAt: new Date().toISOString(),
  inputs: {
    forecastRows: forecasts.length,
    resolvedForecastRows: resolved.length,
    firstIssuedAt: resolved.map((row) => row.issuedAt).filter(Boolean).sort()[0] ?? null,
    lastIssuedAt: resolved.map((row) => row.issuedAt).filter(Boolean).sort().at(-1) ?? null,
  },
  method: {
    unit: 'first qualifying calculation per symbol, exact contract close, and side; policy first-to-fire independently',
    correction: 'average positions within closesAt before standard error',
    execution: 'ask plus taker admission fee, held to exact venue settlement; no fill or exit model',
    policyComparisons: 1,
    diagnostics: 4,
  },
  policies: { v21: V21, v22: V22 },
  comparison: {
    v21Decisions: v21.size,
    v22Decisions: v22.size,
    addedDecisions: added.length,
    droppedDecisions: dropped.length,
    volumeChange: v21.size ? (v22.size - v21.size) / v21.size : null,
    v21: summary([...v21.values()]),
    v22: summary(retained),
    added: summary(added),
    dropped: summary(dropped),
    pairedOnEveryV21Position: {
      roi: {
        production: cluster(pairedPositions, (row) => roi(row.production)),
        candidate: cluster(pairedPositions, (row) => row.candidate ? roi(row.candidate) : 0),
        incremental: cluster(pairedPositions, (row) => (row.candidate ? roi(row.candidate) : 0) - roi(row.production)),
      },
      boundedEdge: {
        production: cluster(pairedPositions, (row) => boundedEdge(row.production)),
        candidate: cluster(pairedPositions, (row) => row.candidate ? boundedEdge(row.candidate) : 0),
        incremental: cluster(pairedPositions, (row) => (row.candidate ? boundedEdge(row.candidate) : 0) - boundedEdge(row.production)),
      },
    },
    droppedByGate: Object.fromEntries(Object.entries(droppedByGate).map(([key, rows]) => [key, summary(rows)])),
  },
  sameTriggerSensitivity: {
    retained: summary(sameTriggerRetained),
    dropped: summary(sameTriggerDropped),
  },
}, null, 2));
