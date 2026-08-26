/**
 * RETIRED HISTORICAL INSTRUMENT — no package command invokes this file. Its v1 wire schema discarded
 * `takerSide`, so its rows are a permissive upper bound and must not be resumed or treated as decision-grade.
 *
 * Bounded maker-fill experiment: records order-book depth and executed trade prints for the live
 * `crypto-15m` contracts, so a resting order can be scored on whether volume actually traded through its
 * price rather than on whether the quote merely touched it.
 *
 *   npm run experiment:maker-depth -- --minutes 2880 --requests 12000
 *
 * WHY IT IS A SCRIPT AND NOT A COLLECTOR LANE
 *   It is deliberately not wired into `processCycle`. A standalone process cannot delay, gate, size,
 *   price, or trade, because it is not on that path at all — the strongest boundary available for an
 *   instrument whose only purpose is to answer one question and stop. Both endpoints it reads are public
 *   and unauthenticated. It writes one append-only observation file and touches nothing else.
 *
 * WHAT IT RECORDS, AND WHY THAT SHAPE
 *   Depth snapshots alone cannot answer the question: a price level shrinking between samples may mean
 *   someone traded through it or may mean someone cancelled, and those are opposite signals for a resting
 *   order. Trade prints disambiguate, and they are **cumulative between samples** — so traded volume at a
 *   price is exact whatever the cadence, and only the depth snapshot is coarse. That is what makes a slow,
 *   cheap experiment viable.
 *
 * BOUNDS
 *   Stops on whichever binds first: wall-clock duration, a hard request cap, or repeated rate limiting.
 *   Kalshi publishes no budget and sends no `Retry-After`, so it starts conservative and backs off rather
 *   than probing for a ceiling.
 *
 * See docs/long-shot-policy-design.md §17.
 */
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fetchKalshiOrderBookNow } from '../src/lib/kalshi-depth';
import { fetchKalshiTradePrintsSince } from '../src/lib/kalshi-market-data';
import { selectedSideDepth } from '../src/lib/order-book-depth';
import { encodeSample, type MakerDepthSample } from '../src/lib/maker-depth-experiment';
import type { PositionSide } from '../src/lib/types';

function refuseRetiredRun(): void {
  throw new Error('Retired: maker-depth-experiment-v1 discarded takerSide and must not collect new rows.');
}
refuseRetiredRun();

const DATA = path.resolve(process.cwd(), 'data');
const OUTPUT = path.join(DATA, 'maker-depth-experiment.jsonl');
const ACTIVE_PATHS = path.join(DATA, 'contract-paths.json');
const SAMPLE_INTERVAL_MS = 60_000;
/** Consecutive failed passes after which the run stops rather than hammering a venue that is refusing. */
const MAX_CONSECUTIVE_FAILURES = 5;

const argument = (name: string, fallback: number): number => {
  const index = process.argv.indexOf(`--${name}`);
  const value = index >= 0 ? Number(process.argv[index + 1]) : Number.NaN;
  return Number.isFinite(value) && value > 0 ? value : fallback;
};

const minutes = argument('minutes', 2880);
const requestCap = argument('requests', 12_000);

/** Live contracts, from the set the collector already keeps current. Market selection is not duplicated. */
async function liveContracts(): Promise<Array<{ contractId: string; symbol: string; closesAt: string }>> {
  if (!existsSync(ACTIVE_PATHS)) return [];
  try {
    const parsed = JSON.parse(await readFile(ACTIVE_PATHS, 'utf8')) as {
      active?: Array<{ contractId: string; symbol: string; closesAt: string }>;
    };
    const now = Date.now();
    return (parsed.active ?? []).filter((record) => Date.parse(record.closesAt) > now);
  } catch {
    return [];
  }
}

let requests = 0;
let consecutiveFailures = 0;
const lastTradeCursor = new Map<string, number>();

async function samplePass(): Promise<number> {
  const contracts = await liveContracts();
  if (!contracts.length) return 0;
  const observedAt = new Date().toISOString();
  const rows: MakerDepthSample[] = [];

  for (const contract of contracts) {
    if (requests >= requestCap) break;
    try {
      requests += 2;
      const since = lastTradeCursor.get(contract.contractId) ?? Date.now() - SAMPLE_INTERVAL_MS;
      const [book, prints] = await Promise.all([
        fetchKalshiOrderBookNow(contract.contractId),
        fetchKalshiTradePrintsSince(contract.contractId, since),
      ]);
      lastTradeCursor.set(contract.contractId, Date.now());
      if (!book) continue;

      for (const side of ['UP', 'DOWN'] as PositionSide[]) {
        const bids = side === 'UP' ? book.yesBids : book.noBids;
        const opposite = side === 'UP' ? book.noBids : book.yesBids;
        // `parseKalshiOrderBook` sorts each ladder ASCENDING, so the best bid is the last level, not the
        // first. Reading `[0]` yields the worst price on the book and produced a plausible-looking 39c
        // spread on a market that quotes 1c.
        const bestBid = bids[bids.length - 1]?.price;
        const bestOpposite = opposite[opposite.length - 1]?.price;
        if (!(bestBid > 0) || !(bestOpposite > 0)) continue;
        const bidCents = Math.round(bestBid * 100);
        const askCents = Math.round((1 - bestOpposite) * 100);
        // A maker posts at the bid, joining the queue already displayed there.
        const depth = selectedSideDepth(book, side, bestBid, 1 - bestOpposite, bestBid);

        // Prints are attributed to this side's price scale: a taker buying the opposite outcome is what
        // consumes a resting bid on this one.
        const tradedVolumeByPrice: Record<number, number> = {};
        for (const print of prints) {
          const priceCents = Math.round((side === 'UP' ? print.yesPrice : print.noPrice) * 100);
          tradedVolumeByPrice[priceCents] = (tradedVolumeByPrice[priceCents] ?? 0) + print.count;
        }

        rows.push({
          contractId: contract.contractId, symbol: contract.symbol, closesAt: contract.closesAt,
          observedAt, side, bidCents, askCents,
          displayedAtPostCents: depth.displayedAtLimit,
          displayedAheadCents: depth.displayedAhead,
          tradedVolumeByPrice,
        });
      }
      consecutiveFailures = 0;
    } catch (error) {
      consecutiveFailures += 1;
      console.error(`sample failed for ${contract.contractId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (rows.length) {
    await mkdir(DATA, { recursive: true });
    await appendFile(OUTPUT, `${rows.map((row) => JSON.stringify(encodeSample(row))).join('\n')}\n`);
  }
  return rows.length;
}

const deadline = Date.now() + minutes * 60_000;
console.log(`maker-depth experiment: up to ${minutes} minutes or ${requestCap} requests, sampling every ${SAMPLE_INTERVAL_MS / 1000}s`);
console.log(`writing ${OUTPUT}\n`);

let totalRows = 0;
while (Date.now() < deadline && requests < requestCap && consecutiveFailures < MAX_CONSECUTIVE_FAILURES) {
  const started = Date.now();
  totalRows += await samplePass();
  const elapsedMinutes = ((Date.now() - (deadline - minutes * 60_000)) / 60_000).toFixed(1);
  process.stdout.write(`\r${elapsedMinutes}m · ${requests} requests · ${totalRows} rows`);
  const remaining = SAMPLE_INTERVAL_MS - (Date.now() - started);
  if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining));
}

const reason = consecutiveFailures >= MAX_CONSECUTIVE_FAILURES ? 'the venue kept refusing'
  : requests >= requestCap ? 'the request cap was reached' : 'the time limit was reached';
console.log(`\nstopped: ${reason}. ${totalRows} rows, ${requests} requests.`);
