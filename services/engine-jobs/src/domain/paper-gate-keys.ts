// Deterministic, versioned derivation of the only two identifiers migration 0006 demands
// and nothing in this repository mints: `engine.paper_gate_generation.generation_key`
// (`0006-paper-cycle-overlay.sql:378`) and `engine.paper_gate_phase_event.event_key`
// (`:514`). Both columns are 1-120 character trimmed text; until now every caller was a
// test choosing a literal.
//
// **UNWIRED.** This module is pure — no clock, no randomness, no environment, no store,
// no network — and nothing in `src/application`, `src/cycle`, `src/adapters` or
// `src/restore` imports it. It mints nothing in production, enables nothing, and is not
// an activation of any paper path. It is a derivation rule offered for review, with its
// tests and its contract.
//
// **Framing.** Each key is `sha256` over a self-delimiting byte string: one
// length-prefixed line per component, `<utf8-byte-length>:<component>\n`, beginning with
// a version-bearing domain literal. The byte length (not the UTF-16 `.length`) is what
// prefixes each line, so the framing is parseable back into exactly its components and no
// two different component lists can frame alike: concatenation ambiguity (`'ab'`+`'c'`
// versus `'a'`+`'bc'`), a component containing the delimiter (`:`), a newline, a quote or
// a backslash, and a component that looks like its own length prefix all frame
// differently. The domain literal carries the version and separates the two key spaces, so
// a generation framing can never equal an event framing even if the components lined up.
// That injectivity is STRUCTURAL — distinct component lists produce distinct byte strings.
// Distinct byte strings producing distinct keys is the separate, probabilistic property of
// SHA-256, and nothing here strengthens it.
//
// **One own-data snapshot.** Every entry point takes the caller's value, proves it is a
// plain own-data object, copies the allowed fields out of their property descriptors ONCE,
// and then validates, frames and returns using only that snapshot — the caller's object is
// never read again, so no field can change between validation and framing. Non-plain
// objects (any foreign prototype: class instances, arrays, functions, `Map`, `Date`),
// accessor properties, and symbol or non-enumerable extra own keys are refused. A throwing
// accessor is never invoked, because only descriptors are read and a descriptor without a
// `value` is a refusal. A throwing reflection trap (a hostile `Proxy`) is caught in the
// one narrow place that examines the object and refused. Every input this module will not
// frame is answered with `undefined`, and it repairs nothing: no value is trimmed, coerced
// or defaulted. The two ways a hostile input could previously raise — an invoked accessor
// and a reflection trap — are the two the paragraph above closes; this is that precise
// statement rather than a blanket "never a throw on any input".
//
// **Accepted domain, which is a strict subset of the column's.** A framed text component
// must satisfy the shared row-scope validator — 1 to 120 UTF-16 code UNITS, equal to its
// own JavaScript `trim()` — and, additionally, be well-formed UTF-16 (no lone surrogate).
// The column allows 1 to 120 CHARACTERS and `btrim(…, E' \t\n\r\f\013')`, so the two
// differ in both directions of spelling and 0006 says so itself (`:406`, "SQL character
// bounds differ from JS UTF16/Unicode trim; decoder must check both"): 61 astral code
// points are 122 UTF-16 units and are refused here although PostgreSQL `length()` counts
// 61, and `'fund\u3000'` or `'\ufefffund'` are refused by JavaScript `trim()` although
// `btrim` keeps those characters. That length and trim comparison is about
// Postgres-representable text, and it is NOT a proof of column admission: what this
// module enforces is the documented identity shape, the JavaScript length and trim
// bounds, and well-formed UTF-16, as derivation PRECONDITIONS. The shared validator does
// not exclude U+0000 (`'\0'.trim() === '\0'`), which PostgreSQL `text` cannot store, and
// this module adds no NUL precondition of its own. The well-formed requirement is a derivation
// PRECONDITION, not a column rule: both `TextEncoder` and the hash encode a lone surrogate
// as the replacement character, so without it `'\ud800'`, `'\udc00'` and `'�'` would
// frame identically and the injectivity claimed above would be false.
//
// **No normalisation.** Nothing here trims, case-folds or applies Unicode normalisation:
// `'x '` is refused rather than trimmed, and NFC and NFD spellings of the same text are
// different components, because they are different values in the columns these keys
// identify and in the comparisons the writer makes on them.
//
// **What is in the generation identity, and why it is exactly five fields.** The identity
// is the exact namespace the WRITER treats as exclusive: `(funding_id, epoch, budget_id,
// generation_config_intent_id, sample_policy)`. A genesis or reset write counts that
// namespace and refuses `'namespace-occupied'`/`generation-exists` when it is already
// occupied (`postgres-paper-gate-writer.ts:783-803`), and it derives the lineage kind from
// the same history rather than from the request — `const derivedKind = budgetNamespace === 0
// ? 'initialize' : 'reset'` (`:808`). Those five columns therefore identify a generation.
// 0006's `unique (generation_key, funding_id, epoch, budget_id,
// generation_config_intent_id, sample_policy)` (`:399`) is NOT that authority: it includes
// the key, it is implied by the primary key on the key alone (`:378`), and it exists to be
// the composite foreign-key target for `engine.paper_gate_phase_event` (`:551-552`). The
// remaining reasons:
//
//   * A later `evaluate` run must be able to RE-DERIVE the generation key from the scope
//     it is authorised for and nothing more. The writer looks the generation row up by
//     `scope.generation_key` and binds that scope to the control record it just read:
//     `decision.configIntentId !== scope.generation_config_intent_id` ... `'scope-not-
//     authorised'` (`postgres-paper-gate-writer.ts:718-727`). Nothing in that path carries
//     the initialising run id, so a key depending on `run_id` would be underivable by the
//     very runs that must address it.
//   * Deriving the key from that namespace means 0006's primary key WOULD enforce the same
//     exclusivity structurally for any writer that derives its key; today no caller does,
//     so the occupancy count above remains the only enforcement in effect.
//   * `bundle_id`, `profile_claim` and the regime columns are decoded from that configure
//     intent, and `actor` is `budget_id` minus `':paper'` by the column's own CHECK, so
//     none of them is an independent identity component.
//   * `reset_origin` and `reset_barrier_intent_id` are DERIVED by the writer from history,
//     not chosen by a caller (`derivedKind`, above) — and a post-reset generation cannot
//     reuse the prior generation's configure intent inside the same
//     funding/epoch/budget/policy namespace, because that is exactly the occupancy the
//     count above refuses. They are therefore consequences of the lineage, not components
//     of the identity, and framing them would make one namespace derive two different keys.
//
// **What is in the event identity, and why `run_id` is in it.** The event key is global
// (0006 makes `event_key` the table's primary key, `:514`) while `unique (generation_key,
// revision_after)` is a separate constraint (`:548`), so the key must be globally unique
// and stable for one intent. The writer recognises a replay by looking the event up by
// `event_key` and then comparing it field by field, and that comparison includes
// `['run_id', persisted.runId === request.runId]` (`paper-gate-write.ts:622`). So:
//
//   * With `run_id` framed, a retry BY THE SAME RUN re-derives the same key and replays
//     idempotently, and a different run deriving the same logical event gets a different
//     key, misses the replay lookup, and is answered by the compare-and-set on the head:
//     `'head-at-' + headRevision.toString()` / `stale-revision` (`:753`). The duplicate is
//     refused by the revision line and `unique (generation_key, revision_after)`, which is
//     where that invariant actually lives.
//   * Without it, two runs would present the SAME key for different rows and the second
//     would be answered `replay-mismatch` on field `run_id` — a refusal that describes the
//     key as wrong rather than the revision as taken.
//
// `revision_before` is framed as its canonical decimal text via `BigInt.prototype.toString`
// and never through `Number`; genesis frames the empty component, which the length prefix
// makes distinct from every other value and which `kind` already distinguishes. The
// `revisionBefore` KEY must be present for exactly `kind: 'evaluated'` and absent for
// exactly `kind: 'genesis'`, judged on the key's presence rather than its value: a present
// `revisionBefore: undefined` is present, and it is refused because `undefined` is not a
// `bigint`.

import { PAPER_REGIME_SAMPLE_BUY_POLICY } from './paper-regime.js';
import { paperGateRowScopeIsValid, type PaperGateRowScope } from './paper-gate-row-codec.js';
import { sha256Hex } from './sha256.js';

export const PAPER_GATE_GENERATION_KEY_DOMAIN = 'money-noodle.paper-gate.generation-key.v1';
export const PAPER_GATE_PHASE_EVENT_KEY_DOMAIN = 'money-noodle.paper-gate.phase-event-key.v1';
export const PAPER_GATE_GENERATION_KEY_PREFIX = 'pgg1-';
export const PAPER_GATE_PHASE_EVENT_KEY_PREFIX = 'pge1-';
/** Both keys: a five character version prefix and a lowercase sha256, 69 characters, well
 * inside 0006's 1-120 bound, trimmed by construction and drawn from `[a-z0-9-]`. */
export const PAPER_GATE_KEY_PATTERN = /^(?:pgg1|pge1)-[0-9a-f]{64}$/;
/** An evaluated event advances `revision_after = revision_before + 1`, and 0006 caps
 * `revision_after` at 9007199254740991, so the highest framable `revision_before` is one
 * below that. */
export const PAPER_GATE_MAX_FRAMED_REVISION = 9007199254740990n;

const encoder = new TextEncoder();
/** `<utf8 byte length>:<component>\n`. Byte length, so an astral component is framed by
 * what it weighs rather than by its UTF-16 unit count. */
const component = (value: string): string => `${encoder.encode(value).length}:${value}\n`;
const framing = (domain: string, values: readonly string[]): string =>
  component(domain) + values.map(component).join('');

/** Well-formed UTF-16: every high surrogate is followed by a low one and every low
 * surrogate is preceded by a high one. Written out rather than called through
 * `String.prototype.isWellFormed` — which this target DOES declare: both tsconfigs set
 * `lib: ["ES2024"]` (`tsconfig.base.json:9`, `services/engine-jobs/tsconfig.json:4`) and
 * the pinned typescript 6.0.3 declares `isWellFormed(): boolean` in
 * `lib.es2024.string.d.ts:21`. It is written out so that this derivation precondition is
 * explicit in the module that depends on it and independent of the runtime and library
 * surface, and so that no library, target, tsconfig or dependency change is needed for
 * it — not because the library lacks the method. U+FFFD and every proper
 * astral pair are well-formed — only a LONE surrogate is not, and a lone surrogate is
 * exactly what both `TextEncoder` and the hash would silently turn into U+FFFD. */
const wellFormedUtf16 = (value: string): boolean => {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit < 0xd800 || unit > 0xdfff) continue;
    // A low surrogate reached on its own: nothing paired it with a high surrogate.
    if (unit > 0xdbff) return false;
    index += 1;
    const low = index < value.length ? value.charCodeAt(index) : 0;
    if (low < 0xdc00 || low > 0xdfff) return false;
  }
  return true;
};

/** A placeholder in a validated slot, so the 1-120 trimmed bound lives in exactly ONE
 * place in the repository: the validator the row decoder and the writer already share. */
const PROBE = 'paper-gate-key-derivation-probe';
const boundedIdentity = (value: unknown): boolean =>
  paperGateRowScopeIsValid({
    budget_id: PROBE,
    epoch: 1,
    funding_id: PROBE,
    generation_config_intent_id: PROBE,
    generation_key: value,
    sample_policy: PAPER_REGIME_SAMPLE_BUY_POLICY,
  });
/** The shared validator's rule, plus this module's own well-formed precondition. */
const framedText = (value: unknown): value is string =>
  boundedIdentity(value) && wellFormedUtf16(value as string);

/**
 * One immutable own-data snapshot of `value`, or `undefined`.
 *
 * The object is examined before any field value is taken: a foreign prototype, an own-key
 * set that is not exactly `keys` (`Reflect.ownKeys`, so a symbol key or a non-enumerable
 * extra counts), a missing descriptor, or a descriptor that carries no `value` (an
 * accessor) each refuse. Only the examination is wrapped in a try/catch — a hostile
 * `Proxy` trap fails closed — and framing and hashing are deliberately outside it.
 */
const snapshot = (value: unknown, keys: readonly string[]): Record<string, unknown> | undefined => {
  const descriptors: (PropertyDescriptor | undefined)[] = [];
  try {
    if (value === null || typeof value !== 'object') return undefined;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return undefined;
    const own = Reflect.ownKeys(value);
    if (own.length !== keys.length) return undefined;
    for (const key of keys) if (!own.includes(key)) return undefined;
    for (const key of keys) descriptors.push(Object.getOwnPropertyDescriptor(value, key));
  } catch {
    return undefined;
  }
  const taken: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const [index, key] of keys.entries()) {
    const descriptor = descriptors[index];
    // No `value` means an accessor, which is never invoked, or a vanished property.
    if (descriptor === undefined || !('value' in descriptor)) return undefined;
    taken[key] = descriptor.value;
  }
  return taken;
};

/** The generation namespace WITHOUT its key: exactly the five columns the writer's
 * occupancy count treats as exclusive, in `PaperGateRowScope` minus the key being
 * derived. */
export interface PaperGateGenerationIdentity {
  funding_id: string;
  epoch: number;
  budget_id: string;
  generation_config_intent_id: string;
  sample_policy: typeof PAPER_REGIME_SAMPLE_BUY_POLICY;
}

const GENERATION_FIELDS = [
  'funding_id',
  'epoch',
  'budget_id',
  'generation_config_intent_id',
  'sample_policy',
] as const;
const GENESIS_FIELDS = ['generationKey', 'kind', 'runId'] as const;
const EVALUATED_FIELDS = ['generationKey', 'kind', 'revisionBefore', 'runId'] as const;
/** The three identity fields that reach the framing as free text. `sample_policy` is one
 * code literal and `epoch` is a number, so neither can carry a lone surrogate. */
const GENERATION_TEXT = ['funding_id', 'budget_id', 'generation_config_intent_id'] as const;

/** Validates the snapshot and returns THE SNAPSHOT, which is what every caller below
 * frames from. */
function generationIdentity(identity: unknown): PaperGateGenerationIdentity | undefined {
  const taken = snapshot(identity, GENERATION_FIELDS);
  if (taken === undefined) return undefined;
  // One validator, not a second copy of its bounds: the five fields are checked by the
  // very function the writer validates a scope with, with the probe standing in for the
  // key this module is about to derive.
  if (!paperGateRowScopeIsValid({ ...taken, generation_key: PROBE })) return undefined;
  if (GENERATION_TEXT.some((field) => !wellFormedUtf16(taken[field] as string))) return undefined;
  return taken as unknown as PaperGateGenerationIdentity;
}

/** Pure over a snapshot: no caller object is reachable from here. */
function generationFraming(fields: PaperGateGenerationIdentity): string {
  return framing(PAPER_GATE_GENERATION_KEY_DOMAIN, [
    fields.funding_id,
    // Already bound to 0006's `integer` domain as a safe integer by the validator above,
    // so its decimal spelling is exact and no float path exists.
    String(fields.epoch),
    fields.budget_id,
    fields.generation_config_intent_id,
    fields.sample_policy,
  ]);
}

/** The exact bytes hashed, so a reviewer can reproduce a key with `printf`/`sha256sum`
 * without running this code. `undefined` on any input this module will not frame. */
export function paperGateGenerationKeyFraming(identity: unknown): string | undefined {
  const fields = generationIdentity(identity);
  return fields === undefined ? undefined : generationFraming(fields);
}

export function paperGateGenerationKey(identity: unknown): string | undefined {
  const fields = generationIdentity(identity);
  return fields === undefined
    ? undefined
    : PAPER_GATE_GENERATION_KEY_PREFIX + sha256Hex(generationFraming(fields));
}

/** The derived key together with the namespace it was derived from, in the shape the
 * writer actually takes. Both halves come from ONE snapshot, so the returned scope always
 * re-derives to its own key and carries no foreign, symbol or accessor property. Refuses
 * unless the result satisfies the writer's own scope validator, so a derivation can never
 * hand out a scope no caller could use. */
export function paperGateRowScopeFromGenerationIdentity(
  identity: unknown,
): PaperGateRowScope | undefined {
  const fields = generationIdentity(identity);
  if (fields === undefined) return undefined;
  const generation_key = PAPER_GATE_GENERATION_KEY_PREFIX + sha256Hex(generationFraming(fields));
  const scope = { ...fields, generation_key };
  return paperGateRowScopeIsValid(scope) ? scope : undefined;
}

/** One phase event's identity: its generation, which of 0006's two event shapes it is, the
 * revision it advances from when it is an advance, and the run that intends it. */
export type PaperGatePhaseEventIdentity =
  | { generationKey: string; kind: 'genesis'; runId: string }
  | { generationKey: string; kind: 'evaluated'; revisionBefore: bigint; runId: string };

export function paperGatePhaseEventKeyFraming(identity: unknown): string | undefined {
  // Both shapes go through the same snapshot helper; whichever own-key set matches, every
  // value below comes from that one snapshot, and `kind` is read from it rather than from
  // the caller's object. The matched key set and `kind` must then agree. At the REFLECTION
  // level the caller's object may therefore be examined twice — the evaluated-shaped
  // attempt, then the genesis-shaped one — but no value is ever taken through `[[Get]]`,
  // every framed value comes from ONE self-consistent snapshot, and a reflection trap that
  // throws during an attempt refuses that attempt.
  const taken = snapshot(identity, EVALUATED_FIELDS) ?? snapshot(identity, GENESIS_FIELDS);
  if (taken === undefined) return undefined;
  const kind = taken.kind;
  if (kind !== 'genesis' && kind !== 'evaluated') return undefined;
  if (Object.hasOwn(taken, 'revisionBefore') !== (kind === 'evaluated')) return undefined;
  const generationKey = taken.generationKey;
  const runId = taken.runId;
  if (!framedText(generationKey) || !framedText(runId)) return undefined;
  let revision = '';
  if (kind === 'evaluated') {
    const before = taken.revisionBefore;
    if (typeof before !== 'bigint' || before < 0n || before > PAPER_GATE_MAX_FRAMED_REVISION)
      return undefined;
    revision = before.toString();
  }
  return framing(PAPER_GATE_PHASE_EVENT_KEY_DOMAIN, [generationKey, kind, revision, runId]);
}

export function paperGatePhaseEventKey(identity: unknown): string | undefined {
  const framed = paperGatePhaseEventKeyFraming(identity);
  return framed === undefined ? undefined : PAPER_GATE_PHASE_EVENT_KEY_PREFIX + sha256Hex(framed);
}
