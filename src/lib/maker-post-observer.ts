import 'server-only';
import { fetchKalshiOrderBookNow } from './kalshi-depth';
import { fetchKalshiTradePrintsSince } from './kalshi-market-data';
import { selectedSideDepth } from './order-book-depth';
import { getContractPath } from './contract-path-store';
import { sideAskCents, sideBidCents } from './contract-path';
import { MAKER_MANAGEMENT_CHECKS, MAKER_MANAGEMENT_POLL_MS } from './managed-maker';
import {
  MAKER_POST_OBSERVATION_VERSION, makerPostLadder, printsForSide, simulateMakerPost, staticMakerPost,
} from './maker-post-observation';
import { recordMakerPostObservations, type MakerPostObservationRecord } from './persistence-candidate-store';
import type { BinaryOrderBook, PersistenceCandidateIntent } from './types';

/**
 * Observes whether each sentinel intent's resting entry would have filled.
 *
 * Design, limits, and the boundary this moves: docs/maker-post-observation-design.md. Two venue requests
 * per intent — one order book at post time, because depth is not historical, and one trade-print fetch
 * after the horizon, because prints are. The reprice ladder comes free from the 2-second contract path.
 *
 * **Observation only.** It places no order, reserves no budget, gates nothing, and returns nothing to
 * production policy. It hangs off `persistenceCandidateCycle`, which the execution path already fires
 * detached and never awaits, so nothing here can delay a trading cycle. Every failure path records less
 * evidence rather than retrying: an intent whose book, prints, or path is missing stays `unobserved`.
 */
const HORIZON_MS = MAKER_MANAGEMENT_CHECKS * MAKER_MANAGEMENT_POLL_MS;
/** Prints are cumulative, so completing late is harmless; this is only a floor on how early we may ask. */
const COMPLETION_MARGIN_MS = 2_000;
/** Hard per-cycle request cap. Over it, intents are left for the next cycle or recorded unobserved. */
const MAX_BOOK_REQUESTS_PER_CYCLE = 8;
const MAX_PRINT_REQUESTS_PER_CYCLE = 8;
/** A 2-second path sampler that skipped more than two buckets is a gap, not a stale-but-usable quote. */
const MAX_QUOTE_STALENESS_SECONDS = 4;
/** Bounds the in-memory pending set so a stalled venue cannot grow it without limit. */
const MAX_PENDING = 200;

interface PendingPost {
  intent: PersistenceCandidateIntent;
  postedAtMs: number;
  book: BinaryOrderBook;
}

const pending = new Map<string, PendingPost>();
/**
 * Intents whose book snapshot has been attempted, successfully or not.
 *
 * Without it a failed snapshot would be retried on every cycle inside the horizon, which is a retry loop
 * wearing a cap. One attempt per intent, and a failure records nothing — the design's stated direction.
 */
const attempted = new Set<string>();

/** Displayed size ahead of a post at `priceCents`, read from the snapshot taken at post time. */
function queueAheadAt(book: BinaryOrderBook, intent: PersistenceCandidateIntent, priceCents: number): number | undefined {
  const depth = selectedSideDepth(book, intent.side, intent.bidPrice, intent.askPrice, priceCents / 100);
  return depth.displayedAhead;
}

async function buildObservation(entry: PendingPost): Promise<MakerPostObservationRecord | null> {
  const { intent, postedAtMs, book } = entry;
  const path = await getContractPath(intent.contractId, intent.closesAt);
  if (!path?.points.length) return null;
  const cycleStartMs = Date.parse(path.cycleStartedAt);
  if (!Number.isFinite(cycleStartMs)) return null;
  const postOffsetSeconds = (postedAtMs - cycleStartMs) / 1000;

  const quoteAt = (offsetMs: number) => {
    const wanted = postOffsetSeconds + offsetMs / 1000;
    let latest: (typeof path.points)[number] | undefined;
    for (const point of path.points) {
      if (point.offsetSeconds > wanted + 1e-9) break;
      latest = point;
    }
    if (!latest || wanted - latest.offsetSeconds > MAX_QUOTE_STALENESS_SECONDS) return undefined;
    const bid = sideBidCents(latest, intent.side) / 100;
    const ask = sideAskCents(latest, intent.side) / 100;
    return bid > 0 && ask > bid && ask < 1 ? { bid, ask } : undefined;
  };

  const ladder = makerPostLadder({
    quoteAt,
    // The issuance ask is the cap: production never pays more than the price it qualified at.
    maximumPrice: intent.askPrice,
    queueAheadAt: (priceCents) => queueAheadAt(book, intent, priceCents),
  });
  if (!ladder?.length) return null;

  const prints = printsForSide(await fetchKalshiTradePrintsSince(intent.contractId, postedAtMs), intent.side, postedAtMs);
  const ladderResult = simulateMakerPost(ladder, prints, HORIZON_MS);
  const staticResult = simulateMakerPost(staticMakerPost(ladder), prints, HORIZON_MS);

  return {
    id: intent.id,
    makerObservationModel: MAKER_POST_OBSERVATION_VERSION,
    makerObservationSource: 'live-2s',
    makerPostCents: ladder[0].priceCents,
    makerQueueAheadCents: ladder[0].queueAheadCents,
    makerLadderFill: ladderResult.outcome,
    ...(ladderResult.fillCents === undefined ? {} : { makerLadderFillCents: ladderResult.fillCents }),
    ...(ladderResult.fillOffsetMs === undefined ? {} : { makerLadderFillAt: new Date(postedAtMs + ladderResult.fillOffsetMs).toISOString() }),
    makerStaticFill: staticResult.outcome,
    makerStaticFillCents: ladder[0].priceCents,
  };
}

/**
 * One pass: snapshot the book for intents created this cycle, and settle any whose horizon has elapsed.
 *
 * Callers must not await this on the execution path. It is exported for the detached caller and for
 * tests; it swallows every venue error by design, because an instrument that can throw into a trading
 * cycle is not observation-only.
 */
export async function observeMakerPosts(intents: PersistenceCandidateIntent[], nowMs = Date.now()): Promise<number> {
  let bookRequests = 0;
  for (const intent of intents) {
    if (bookRequests >= MAX_BOOK_REQUESTS_PER_CYCLE || pending.size >= MAX_PENDING) break;
    if (attempted.size >= MAX_PENDING * 4) attempted.clear();
    if (attempted.has(intent.id) || intent.makerObservationModel) continue;
    const postedAtMs = Date.parse(intent.createdAt);
    if (!Number.isFinite(postedAtMs) || nowMs - postedAtMs > HORIZON_MS) continue;
    attempted.add(intent.id);
    bookRequests += 1;
    try {
      const book = await fetchKalshiOrderBookNow(intent.contractId);
      if (book) pending.set(intent.id, { intent, postedAtMs, book });
    } catch { /* an unobserved intent is the correct outcome of a failed snapshot */ }
  }

  const due = [...pending.values()]
    .filter((entry) => nowMs - entry.postedAtMs >= HORIZON_MS + COMPLETION_MARGIN_MS)
    .slice(0, MAX_PRINT_REQUESTS_PER_CYCLE);
  const observations: MakerPostObservationRecord[] = [];
  for (const entry of due) {
    pending.delete(entry.intent.id);
    try {
      const observation = await buildObservation(entry);
      if (observation) observations.push(observation);
    } catch { /* left unobserved rather than retried */ }
  }
  return observations.length ? recordMakerPostObservations(observations) : 0;
}

/** Test seam: this state is process-local and a restart legitimately loses it. */
export function resetPendingMakerPosts(): void {
  pending.clear();
  attempted.clear();
}
