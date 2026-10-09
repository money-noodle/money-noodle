// Whether the engine may run, decided from the persisted control table alone
// (ADR-0013 §3).
//
// The three staleness conditions are the record's, not this module's invention:
// an intent is current when it is (1) the latest row for its capability, ordered
// by `(epoch, recorded_at, id)`, (2) carries the engine store's current control
// epoch, and (3) was not recorded in the future by more than the allowed clock
// skew. Missing and stale are treated identically: the job runs paused.
//
// "Runs paused" is the whole point of putting this in a pure function. The job
// never asks "am I allowed?" of its own memory, a flag or a file; it asks the
// store, and a store that says nothing is a store that says no.
//
// Every refusal is one of a closed set of reason codes, because an outcome row
// records a fixed code rather than a sentence (ADR-0013 §3).

export const CONTROL_ACTIONS = [
  'configure',
  'pause',
  'resume',
  'reset',
  'provider-enable',
] as const;

export type ControlAction = (typeof CONTROL_ACTIONS)[number];

/** The actions that leave the engine running. Anything else leaves it paused. */
const RUNNING_ACTIONS: ReadonlySet<ControlAction> = new Set(['configure', 'resume']);

/**
 * How far in the future a `recorded_at` may be before the row is refused. A
 * recorder on a skewed clock is a recorder whose ordering cannot be trusted, and
 * ADR-0013 §3 makes that condition 3 of three rather than something to tolerate.
 */
export const MAX_INTENT_CLOCK_SKEW_MS = 5 * 60 * 1000;

export interface IntentRow {
  readonly id: string;
  readonly capability: string;
  readonly action: ControlAction;
  readonly epoch: number;
  readonly recordedAt: Date;
}

export type IntentRefusal =
  'intent-missing' | 'intent-stale-epoch' | 'intent-future' | 'intent-paused';

export type IntentDecision =
  | { readonly run: true; readonly intent: IntentRow }
  | {
      readonly run: false;
      readonly reason: IntentRefusal;
      /** The row that was evaluated, or absent when there was none to evaluate. */
      readonly intent: IntentRow | undefined;
    };

/** `(epoch, recorded_at, id)`, exactly the ordering ADR-0013 §3 names. */
export function compareIntents(left: IntentRow, right: IntentRow): number {
  if (left.epoch !== right.epoch) return left.epoch - right.epoch;
  const time = left.recordedAt.getTime() - right.recordedAt.getTime();
  if (time !== 0) return time;
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

/** The latest row for `capability`, or undefined when the capability has none. */
export function latestIntent(
  rows: readonly IntentRow[],
  capability: string,
): IntentRow | undefined {
  // Filtered here rather than trusted from the caller: a store that over-fetched
  // must not be able to hand this function another capability's standing intent.
  const own = rows.filter((row) => row.capability === capability);
  if (own.length === 0) return undefined;
  return own.reduce((latest, row) => (compareIntents(row, latest) > 0 ? row : latest));
}

export function evaluateIntent(
  rows: readonly IntentRow[],
  options: { readonly capability: string; readonly epoch: number; readonly now: Date },
): IntentDecision {
  const latest = latestIntent(rows, options.capability);
  if (latest === undefined) return { intent: undefined, reason: 'intent-missing', run: false };

  // Condition 2. A row recorded under an earlier epoch is intent somebody gave
  // before an event that invalidated it — a restore, a reseed, a migration — so a
  // resume from before a reseed cannot silently authorise the engine after it.
  if (latest.epoch !== options.epoch) {
    return { intent: latest, reason: 'intent-stale-epoch', run: false };
  }

  // Condition 3.
  if (latest.recordedAt.getTime() - options.now.getTime() > MAX_INTENT_CLOCK_SKEW_MS) {
    return { intent: latest, reason: 'intent-future', run: false };
  }

  // Condition 1 is structural: `latest` *is* the latest row, so a `pause` or a
  // `reset` that is latest means paused, and so does any other action that is not
  // one of the two running ones. Fail closed: a new action nobody has taught this
  // job about leaves the engine paused rather than running on a guess.
  if (!RUNNING_ACTIONS.has(latest.action)) {
    return { intent: latest, reason: 'intent-paused', run: false };
  }

  return { intent: latest, run: true };
}
