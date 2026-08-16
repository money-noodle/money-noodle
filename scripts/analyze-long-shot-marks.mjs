/**
 * Sweeps long-shot entry and exit marks against break-even, from recorded contract paths.
 *
 *   npm run analyze:long-shot-marks
 *
 * `ratio` is the observed touch rate divided by the break-even rate the configuration needs. Above 1.00
 * would be viable. Fees and sizing are reproduced from the production model rather than approximated, so
 * a change to either shows up here.
 *
 * Touch rates are **floors**: a path sampled every fifteen seconds cannot see a spike between samples, and
 * winners were observed reaching 90¢ in only 68.4% of cases where the true figure must be 100%. The
 * one-second entry polling added 2026-08-16 is what removes that bias; re-run this against paths recorded
 * afterwards before drawing a conclusion from it.
 */
import { readFile } from 'node:fs/promises';
import { createReadStream, existsSync } from 'node:fs';
import readline from 'node:readline';
import path from 'node:path';

const DATA = path.resolve(process.cwd(), 'data');
const TICKET_CENTS = 20;
/** Entry gate: seconds remaining at or above which a candidate qualifies. */
const WINDOW_SECONDS = 600;
/** A fall of more than this between samples counts as still falling rather than stalled. */
const STALL_TOLERANCE_CENTS = 0.05;

async function loadPaths() {
  const records = [];
  const active = JSON.parse(await readFile(path.join(DATA, 'contract-paths.json'), 'utf8'));
  for (const record of active.active ?? []) records.push(record);
  const journal = path.join(DATA, 'contract-paths.journal.jsonl');
  if (existsSync(journal)) {
    const stream = readline.createInterface({ input: createReadStream(journal) });
    for await (const line of stream) {
      if (!line.trim()) continue;
      try {
        const [, symbol, closesAt, points] = JSON.parse(line);
        records.push({ symbol, closesAt, points: points.map(([o, u, d]) => ({ o, u, d })) });
      } catch { /* a damaged line is skipped rather than failing the whole read */ }
    }
  }
  return records;
}

const ask = (point, side) => (side === 'UP' ? point.u : point.d);
// bid(side) = 100 - ask(other side) on Kalshi's shared book.
const bid = (point, side) => (side === 'UP' ? 100 - point.d : 100 - point.u);

/** `max(1, ceil(7 * quantity * p * (1 - p)))`, the production fee, whole cents. */
const feeCents = (priceCents, quantity) =>
  Math.max(1, Math.ceil(7 * quantity * (priceCents / 100) * (1 - priceCents / 100)));

/** Largest 0.01-increment purchase fitting an all-in cap; mirrors `estimatePaperFill`. */
function fill(stakeLimitCents, askCents) {
  const maximumUnits = Math.floor((stakeLimitCents / askCents + 1e-9) / 0.01);
  for (let units = maximumUnits; units > 0; units -= 1) {
    const quantity = Number((units * 0.01).toFixed(2));
    const stake = Math.ceil(quantity * askCents - 1e-9) + feeCents(askCents, quantity);
    if (stake <= stakeLimitCents) return { quantity, stake };
  }
  return null;
}

/**
 * First qualifying touch per contract and side, with the peak bid reachable **after** the decision point.
 *
 * `requireStall` drops candidates still falling at the next sample. Measured over 457 first touches, that
 * cohort reached 90¢ 0.9% of the time against 2.6% for stalled ones — a continuing fall is a trend, and
 * this strategy needs a reversal.
 */
function cohort(records, entryMarkCents, requireStall) {
  const out = [];
  for (const record of records) {
    for (const side of ['UP', 'DOWN']) {
      const points = [...record.points].sort((a, b) => a.o - b.o);
      const index = points.findIndex((point) => {
        const value = ask(point, side);
        return value > 0 && value <= entryMarkCents && 900 - point.o >= WINDOW_SECONDS;
      });
      if (index < 0 || index + 1 >= points.length) continue;
      const first = ask(points[index], side);
      const next = ask(points[index + 1], side);
      if (!(next > 0)) continue;
      if (requireStall && next < first - STALL_TOLERANCE_CENTS) continue;
      let peak = 0;
      for (const point of points.slice(index + 2)) peak = Math.max(peak, bid(point, side));
      out.push({ entryAskCents: Math.min(first, next), peakBidCents: peak });
    }
  }
  return out;
}

const records = await loadPaths();
console.log(`windows: ${records.length}\n`);
console.log('ratio = observed touch rate / break-even. Above 1.00 would be viable.\n');
console.log('entry  exit      n   touch%    b/e%   ratio');

for (const entryMarkCents of [5, 10, 15, 20, 25]) {
  const candidates = cohort(records, entryMarkCents, true);
  if (candidates.length < 10) {
    console.log(`${String(entryMarkCents).padStart(4)}c   (only ${candidates.length} candidates)`);
    continue;
  }
  for (const exitMarkCents of [30, 50, 70, 90]) {
    if (exitMarkCents <= entryMarkCents) continue;
    let touched = 0, breakEvenSum = 0, used = 0;
    for (const candidate of candidates) {
      const sized = fill(TICKET_CENTS, Math.max(1, Math.round(candidate.entryAskCents)));
      if (!sized) continue;
      used += 1;
      const proceeds = sized.quantity * exitMarkCents - feeCents(exitMarkCents, sized.quantity);
      breakEvenSum += sized.stake / proceeds;
      if (candidate.peakBidCents >= exitMarkCents) touched += 1;
    }
    if (!used) continue;
    const touch = touched / used, breakEven = breakEvenSum / used;
    console.log(`${String(entryMarkCents).padStart(4)}c ${String(exitMarkCents).padStart(4)}c ${String(used).padStart(6)}  ${(100 * touch).toFixed(1).padStart(6)}  ${(100 * breakEven).toFixed(1).padStart(6)}  ${(touch / breakEven).toFixed(2).padStart(6)}`);
  }
}
