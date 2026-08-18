/**
 * Bounded fine-resolution path experiment: samples every live `crypto-15m` contract every two seconds.
 *
 *   npm run experiment:fine-paths -- --minutes 1440 --seconds 2
 *
 * WHY IT EXISTS
 *   Every trajectory measurement in this repo has been made on fifteen-second contract paths, and
 *   fifteen-second sampling was measured to hide about 37% of all price movement, with 8.7% of intervals
 *   concealing a swing of 2c or more. The one-second recorder that already exists cannot fill the gap: its
 *   `denseWatch` trigger fires only once a side has fallen below the long-shot entry mark, so it starts
 *   three to five minutes into a cycle when the book is already 9c/91c. Across 57 dense windows, **zero**
 *   had the 20-80c range inside the dense region — which is the range an operator watching the app
 *   actually trades. This records that range at a resolution close to what a human sees.
 *
 * WHY IT IS A SEPARATE FILE AND A SEPARATE PROCESS
 *   It writes its own journal rather than `data/contract-paths.*`. At two seconds a window carries roughly
 *   seven times the samples, which at the 45-day contract-path retention would be a permanent ~180 MB
 *   liability and would change the compaction behaviour of a store the long-shot pipeline depends on. A
 *   bounded experiment with its own file can simply be deleted when the question is answered.
 *
 *   It is also not wired into `processCycle`, for the same reason as the maker-depth experiment: a process
 *   that is not on the execution path cannot delay, gate, size, price, or trade.
 *
 * THE RISK THIS CARRIES, STATED PLAINLY
 *   Seven contracts every two seconds is about 210 requests a minute, against the 14 a minute the
 *   maker-depth experiment uses. Kalshi's limit is per account, and the repo's limiter is per process —
 *   so a rate limit provoked here **would** be felt by the live trading desk. The run therefore stops
 *   itself on repeated failures rather than backing off and continuing, and the cadence is a parameter so
 *   it can be loosened without editing code.
 *
 * See docs/long-shot-policy-design.md §18.
 */
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fetchKalshiQuote, kalshiReadRateLimitState } from '../lib/kalshi-market-data';

const DATA = path.resolve(process.cwd(), 'data');
const OUTPUT = path.join(DATA, 'fine-paths-experiment.jsonl');
const ACTIVE_PATHS = path.join(DATA, 'contract-paths.json');
const CYCLE_SECONDS = 900;
/** Consecutive failed passes after which the run stops rather than pressing a venue that is refusing. */
const MAX_CONSECUTIVE_FAILURES = 4;
/** Rows buffered before a write, so a two-second cadence is not two filesystem calls a second. */
const FLUSH_ROWS = 200;

const argument = (name: string, fallback: number): number => {
  const index = process.argv.indexOf(`--${name}`);
  const value = index >= 0 ? Number(process.argv[index + 1]) : Number.NaN;
  return Number.isFinite(value) && value > 0 ? value : fallback;
};

const minutes = argument('minutes', 1440);
const intervalMs = argument('seconds', 2) * 1000;
const requestCap = argument('requests', 600_000);

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
let buffer: string[] = [];

async function flush(): Promise<void> {
  if (!buffer.length) return;
  await mkdir(DATA, { recursive: true });
  await appendFile(OUTPUT, `${buffer.join('\n')}\n`);
  buffer = [];
}

/**
 * One pass over the live contracts.
 *
 * Rows are `[contractId, closesAt, offsetSeconds, askUpCents, askDownCents]` — the same quantities the
 * fifteen-second recorder keeps, so the two are directly comparable and any analysis written against one
 * reads the other with a different loader and no other change.
 */
async function samplePass(contracts: Array<{ contractId: string; symbol: string; closesAt: string }>): Promise<void> {
  const now = Date.now();
  let failures = 0;
  await Promise.all(contracts.map(async (contract) => {
    if (requests >= requestCap) return;
    requests += 1;
    try {
      const quote = await fetchKalshiQuote(contract.contractId);
      if (!quote) { failures += 1; return; }
      const closeMs = Date.parse(contract.closesAt);
      const offsetSeconds = Math.round((now - (closeMs - CYCLE_SECONDS * 1000)) / 1000);
      if (offsetSeconds < 0 || offsetSeconds > CYCLE_SECONDS) return;
      // askUp is the YES ask; askDown is the complement of the YES bid, per the shared-book identity.
      const askUpCents = Number((quote.yesAsk * 100).toFixed(2));
      const askDownCents = Number(((1 - quote.yesBid) * 100).toFixed(2));
      if (!(askUpCents > 0) || !(askDownCents > 0)) return;
      buffer.push(JSON.stringify([contract.contractId, contract.closesAt, offsetSeconds, askUpCents, askDownCents]));
    } catch {
      failures += 1;
    }
  }));
  consecutiveFailures = failures >= Math.max(1, contracts.length - 1) ? consecutiveFailures + 1 : 0;
  if (buffer.length >= FLUSH_ROWS) await flush();
}

const deadline = Date.now() + minutes * 60_000;
console.log(`fine-path experiment: every ${intervalMs / 1000}s, up to ${minutes} minutes or ${requestCap} requests`);
console.log(`writing ${OUTPUT}`);
console.log('stops itself on repeated failures: a rate limit provoked here is felt by the live desk.\n');

let contracts = await liveContracts();
let refreshedAt = Date.now();
let rows = 0;

while (Date.now() < deadline && requests < requestCap && consecutiveFailures < MAX_CONSECUTIVE_FAILURES) {
  const started = Date.now();
  // Windows roll every fifteen minutes; refresh the live set well inside that.
  if (started - refreshedAt > 60_000) { contracts = await liveContracts(); refreshedAt = started; }
  if (contracts.length) {
    const before = buffer.length;
    await samplePass(contracts);
    rows += Math.max(0, buffer.length - before) || 0;
  }
  const limit = kalshiReadRateLimitState();
  if (limit.pausedUntilMs && limit.pausedUntilMs > Date.now()) {
    console.log(`\nrate limited; stopping rather than continuing — the live desk shares this budget.`);
    break;
  }
  process.stdout.write(`\r${((Date.now() - (deadline - minutes * 60_000)) / 60_000).toFixed(1)}m · ${requests} requests · ${contracts.length} contracts`);
  const remaining = intervalMs - (Date.now() - started);
  if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining));
}

await flush();
const reason = consecutiveFailures >= MAX_CONSECUTIVE_FAILURES ? 'the venue kept refusing'
  : requests >= requestCap ? 'the request cap was reached' : 'the time limit was reached';
console.log(`\nstopped: ${reason}. ${requests} requests.`);
