import type { PositionSide } from './types';

/**
 * Durable record of why live did not trade, per settlement window.
 *
 * SPEC §12.8 step 2. Until this existed the ledger kept `lastLiveSkip`, a single slot holding only the
 * most recent reason, so §12.3's promise that `paper − live` "decomposes into fill drag, limit drag, and
 * stop drag" could not be honoured. Reconstructing the 2026-08-20 divergence review needed the trading
 * control audit and a manual join; the largest single cause — live spending 12 of 24 hours risk-stopped
 * on 2026-08-19 while paper kept trading — was invisible in the ledger itself.
 *
 * This does not close any divergence channel. It makes them countable, which is the prerequisite for
 * judging them. Per §12.3 the risk-stop channel in particular is *supposed* to stay open: making paper
 * obey live's stops would destroy the measurement of what the stop cost. What was missing was the label.
 *
 * **Episodes, not cycles.** The live cycle runs about every 15 seconds, so recording one row per skip per
 * cycle would write thousands of identical rows a day and bury the signal. A record is therefore an
 * *episode*: a maximal run of consecutive cycles giving the same classification and reason. A six-hour
 * risk stop is one record with a cycle count and the settlement windows it covered, not 1,440 rows.
 *
 * Pure and I/O free.
 */

export const LIVE_SKIP_JOURNAL_VERSION = 'live-skip-v1';

/**
 * Why live withheld. Every call site names its own class rather than a classifier pattern-matching on
 * prose, so a new gate cannot silently inherit someone else's label — and per AGENTS.md §5.7, a gate
 * that never fires shows up here as a class with zero records rather than as an assumed control.
 */
export type LiveSkipClass =
  /** A live risk stop or a system suspension withdrew execution authority. Operator intent was active. */
  | 'stop'
  /** The operator paused, or execution mode is paper. Intent, not operational state. */
  | 'operator'
  /** Live trading is off in the environment, or the provider registry does not permit live. */
  | 'environment'
  /** Reconciliation is not ready, so the desk may not act on a possibly-stale view of the venue. */
  | 'reconciliation'
  /** The hourly filled-order ceiling, or a switch that could not reserve two fill slots. */
  | 'rate_limit'
  /** Budget reservation failed or a stake cap left no room. */
  | 'budget'
  /** Provider, market, or strategy funding headroom was exhausted. */
  | 'funding'
  /** Position, same-window, or correlation exposure caps refused the candidate. */
  | 'exposure'
  /** Portfolio selection preferred to hold, or found no replacement clearing liquidation costs. */
  | 'portfolio'
  /** The signal qualified but had not yet earned execution: persistence, requalification, cooldown. */
  | 'persistence'
  /**
   * A reduce-only exit did not fill, or filled only partially, so the action depending on it was
   * withheld. SPEC §12.3 names fill drag as one of the three drags `paper - live` decomposes into, so it
   * is a class in its own right rather than folded into `portfolio`.
   */
  | 'fill'
  /** The adaptive regime gate, or an unclassified 15-second contract path. */
  | 'regime'
  /** The calculation snapshot aged out before it could be acted on. */
  | 'staleness'
  /** Nothing qualified. This is the desk working as intended, and is recorded so it can be netted out. */
  | 'none';

/** Classes that mean live *wanted* to trade something and was prevented. `none` is not one of them. */
export const WITHHELD_CLASSES: readonly LiveSkipClass[] = [
  'stop', 'operator', 'environment', 'reconciliation', 'rate_limit',
  'budget', 'funding', 'exposure', 'portfolio', 'persistence', 'fill', 'regime', 'staleness',
];

export interface LiveSkipRecord {
  /** Stable identity: classification, reason, and the cycle the episode opened on. */
  id: string;
  classification: LiveSkipClass;
  reason: string;
  firstAt: string;
  lastAt: string;
  /** Consecutive live cycles that reported this same skip. */
  cycles: number;
  /** Settlement windows open while the episode ran. This is the join key to the paper book. */
  windows: string[];
  /** Present when the skip was decided for one candidate rather than for the whole account. */
  symbol?: string;
  side?: PositionSide;
}

export interface LiveSkipEvent {
  at: string;
  classification: LiveSkipClass;
  reason: string;
  windows: string[];
  symbol?: string;
  side?: PositionSide;
}

/** Two observations belong to the same episode when nothing about the decision changed. */
function episodeKey(event: Pick<LiveSkipEvent, 'classification' | 'reason' | 'symbol' | 'side'>): string {
  return `${event.classification}|${event.symbol ?? ''}|${event.side ?? ''}|${event.reason}`;
}

/**
 * Folds an ordered event stream into episodes.
 *
 * An event extends the newest record when it carries the same key; otherwise it opens a new one. Windows
 * accumulate as a set because one episode routinely spans several settlement windows — that is the whole
 * point of recording them.
 */
export function replayLiveSkipEvents(events: LiveSkipEvent[], existing: LiveSkipRecord[] = []): LiveSkipRecord[] {
  const records = existing.map((record) => ({ ...record, windows: [...record.windows] }));
  for (const event of events) {
    if (!event?.at || !event.classification || typeof event.reason !== 'string') continue;
    const latest = records.at(-1);
    if (latest && episodeKey(latest) === episodeKey(event)) {
      latest.lastAt = event.at;
      latest.cycles += 1;
      for (const window of event.windows ?? []) if (!latest.windows.includes(window)) latest.windows.push(window);
      continue;
    }
    records.push({
      id: `${event.classification}:${event.at}`,
      classification: event.classification, reason: event.reason,
      firstAt: event.at, lastAt: event.at, cycles: 1,
      windows: [...new Set(event.windows ?? [])],
      symbol: event.symbol, side: event.side,
    });
  }
  return records;
}

export interface LiveSkipAttribution {
  classification: LiveSkipClass;
  episodes: number;
  cycles: number;
  /** Distinct settlement windows in which live reported this class at least once. */
  windows: number;
  firstAt?: string;
  lastAt?: string;
}

/** Per-class rollup. This is the surface §12.3 asks for: drag attributed rather than inferred. */
export function attributeLiveSkips(records: LiveSkipRecord[]): LiveSkipAttribution[] {
  const byClass = new Map<LiveSkipClass, { episodes: number; cycles: number; windows: Set<string>; firstAt: string; lastAt: string }>();
  for (const record of records) {
    const current = byClass.get(record.classification);
    if (!current) {
      byClass.set(record.classification, {
        episodes: 1, cycles: record.cycles, windows: new Set(record.windows),
        firstAt: record.firstAt, lastAt: record.lastAt,
      });
      continue;
    }
    current.episodes += 1;
    current.cycles += record.cycles;
    for (const window of record.windows) current.windows.add(window);
    if (record.firstAt < current.firstAt) current.firstAt = record.firstAt;
    if (record.lastAt > current.lastAt) current.lastAt = record.lastAt;
  }
  return [...byClass.entries()]
    .map(([classification, value]) => ({
      classification, episodes: value.episodes, cycles: value.cycles,
      windows: value.windows.size, firstAt: value.firstAt, lastAt: value.lastAt,
    }))
    .sort((left, right) => right.windows - left.windows || right.cycles - left.cycles);
}

/**
 * Settlement windows where live was withheld for a given class.
 *
 * Joining this against the paper book on `closesAt` is what turns "paper traded while live was stopped"
 * from a reconstruction into a first-class number.
 */
export function windowsWithheldBy(records: LiveSkipRecord[], classification: LiveSkipClass): string[] {
  const windows = new Set<string>();
  for (const record of records) if (record.classification === classification) for (const window of record.windows) windows.add(window);
  return [...windows].sort();
}
