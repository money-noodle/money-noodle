#!/usr/bin/env node
/**
 * Prospective hourly threshold availability and model review.
 *
 * Measure: one 60-second asset observation, clustered by exact hourly close; deciding corrections are exact
 * ticker/rules identity and provider outcome. Missing assets/contracts stay unavailable. This script is read-only,
 * never qualifies an entry, and cannot enable paper/live capability. Main caveat: Kraken is a model reference while
 * Kalshi resolves on CF Benchmarks, so probability scoring does not establish target-integrity equivalence.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const directory = path.resolve(process.cwd(), process.env.MONEY_NOODLE_HOURLY_OBSERVATION_PATH?.trim() || 'data');
const journal = path.join(directory, 'hourly-threshold-observations.journal.jsonl');
const observations = new Map(), outcomes = new Map();
let raw = '';
try { raw = await readFile(journal, 'utf8'); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
for (const line of raw.split('\n')) {
  if (!line) continue;
  const event = JSON.parse(line);
  if (event.op === 'observation') observations.set(event.value.id, event.value);
  if (event.op === 'outcome') {
    const prior = outcomes.get(event.value.ticker);
    if (prior && (prior.result !== event.value.result || prior.rulesFingerprint !== event.value.rulesFingerprint)) {
      throw new Error(`Contradictory outcome for ${event.value.ticker}`);
    }
    outcomes.set(event.value.ticker, event.value);
  }
}
const rows = [...observations.values()];
const windows = new Set(rows.map((row) => row.observationWindowClosesAt).filter(Boolean));
const candidates = rows.flatMap((row) => row.candidates ?? []);
const exactContracts = new Map();
for (const candidate of candidates) {
  const prior = exactContracts.get(candidate.ticker);
  if (prior && prior.rulesFingerprint !== candidate.rulesFingerprint) throw new Error(`Rules changed for ${candidate.ticker}`);
  exactContracts.set(candidate.ticker, candidate);
}
const closed = [...exactContracts.values()].filter((candidate) => Date.parse(candidate.closesAt) <= Date.now());
const scored = candidates.filter((candidate) => {
  const outcome = outcomes.get(candidate.ticker);
  return outcome && outcome.result !== 'INVALID' && Number.isFinite(candidate.modelProbabilityYes);
});
const brier = scored.length ? scored.reduce((sum, candidate) => {
  const target = outcomes.get(candidate.ticker).result === 'YES' ? 1 : 0;
  return sum + (candidate.modelProbabilityYes - target) ** 2;
}, 0) / scored.length : null;
const byAsset = Object.values(rows.reduce((groups, row) => {
  const group = groups[row.symbol] ??= { symbol: row.symbol, observations: 0, available: 0, windows: new Set() };
  group.observations += 1;
  if (row.marketDataAvailable) group.available += 1;
  if (row.observationWindowClosesAt) group.windows.add(row.observationWindowClosesAt);
  return groups;
}, {})).map((group) => ({
  symbol: group.symbol, observations: group.observations, available: group.available,
  availability: group.observations ? group.available / group.observations : null, windows: group.windows.size,
})).sort((left, right) => left.symbol.localeCompare(right.symbol));
console.log(JSON.stringify({
  generatedAt: new Date().toISOString(), version: 'hourly-threshold-observation-v1',
  cohort: {
    observations: rows.length, independentCloseWindows: windows.size,
    startedAt: rows.map((row) => row.observedAt).sort()[0] ?? null,
    latestAt: rows.map((row) => row.observedAt).sort().at(-1) ?? null,
  },
  availability: { complete: rows.filter((row) => row.marketDataAvailable).length, byAsset },
  identity: { exactContracts: exactContracts.size, closedContracts: closed.length },
  outcomes: {
    resolved: outcomes.size,
    eligibleClosedResolved: closed.filter((candidate) => outcomes.has(candidate.ticker)).length,
    eligibleClosedCoverage: closed.length
      ? closed.filter((candidate) => outcomes.has(candidate.ticker)).length / closed.length : null,
    invalid: [...outcomes.values()].filter((outcome) => outcome.result === 'INVALID').length,
  },
  model: { scoredObservations: scored.length, brier },
  milestones: {
    smoke10Ready: windows.size >= 10,
    firstReview60Ready: windows.size >= 60,
  },
  authority: 'observation only; no qualification, paper, live, budget, settlement-write, or promotion authority',
}, null, 2));
