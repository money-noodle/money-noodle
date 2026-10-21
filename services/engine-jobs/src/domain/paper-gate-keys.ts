// Deterministic, versioned derivation of the only two identifiers migration 0006 demands
// and nothing in this repository mints: `engine.paper_gate_generation.generation_key` and
// `engine.paper_gate_phase_event.event_key`. Both columns are 1-120 character trimmed
// text; until now every caller was a test choosing a literal.
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
// two different component lists can collide: concatenation ambiguity (`'ab'`+`'c'` versus
// `'a'`+`'bc'`), a component containing the delimiter (`:`), a newline, a quote or a
// backslash, and a component that looks like its own length prefix all frame differently.
// The domain literal carries the version and separates the two key spaces, so a generation
// framing can never equal an event framing even if the components lined up.
//
// **No normalisation.** Nothing here trims, case-folds or applies Unicode normalisation:
// `'x '` is refused rather than trimmed, and NFC and NFD spellings of the same text are
// different components, because they are different values in the columns these keys
// identify and in the comparisons the writer makes on them.
//
// **What is in the generation identity, and why it is exactly five fields.** The key is
// derived from the namespace 0006 pairs it with — `unique (generation_key, funding_id,
// epoch, budget_id, generation_config_intent_id, sample_policy)` — and from nothing else:
//
//   * A later `evaluate` run must be able to RE-DERIVE the generation key from the scope
//     it is authorised for and nothing more. The writer looks the generation row up by
//     `scope.generation_key` and binds that scope to the control record it just read:
//     `decision.configIntentId !== scope.generation_config_intent_id` ... `'scope-not-
//     authorised'` (`postgres-paper-gate-writer.ts:718-727`). Nothing in that path carries
//     the initialising run id, so a key depending on `run_id` would be underivable by the
//     very runs that must address it.
//   * A second generation in one namespace is already impossible, so one key per namespace
//     loses no legal history: the writer counts the namespace and refuses
//     `'namespace-occupied'`/`generation-exists` when `exactNamespace > 0`
//     (`postgres-paper-gate-writer.ts:783-802`).
//   * `bundle_id`, `profile_claim` and the regime columns are decoded from that configure
//     intent, and `actor` is `budget_id` minus `':paper'` by the column's own CHECK, so
//     none of them is an independent identity component.
//   * `reset_origin` and `reset_barrier_intent_id` are DERIVED by the writer from history,
//     not chosen by a caller — `const derivedKind = budgetNamespace === 0 ? 'initialize' :
//     'reset'` (`:808`) — and a post-reset generation cannot reuse the prior generation's
//     configure intent inside the same funding/epoch/budget/policy namespace, because that
//     is exactly the occupancy the line above refuses. They are therefore consequences of
//     the lineage, not components of the identity, and framing them would make one
//     namespace derive two different keys.
//
// **What is in the event identity, and why `run_id` is in it.** The event key is global
// (0006 makes `event_key` the table's primary key) while `unique (generation_key,
// revision_after)` is a separate constraint, so the key must be globally unique and stable
// for one intent. The writer recognises a replay by looking the event up by `event_key` and
// then comparing it field by field, and that comparison includes
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
// makes distinct from every other value and which `kind` already distinguishes.

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

/** A placeholder in a validated slot, so the 1-120 trimmed bound lives in exactly ONE
 * place in the repository: the validator the row decoder and the writer already share. */
const PROBE = 'paper-gate-key-derivation-probe';
const boundedIdentity = (value: unknown): value is string =>
  paperGateRowScopeIsValid({
    budget_id: PROBE,
    epoch: 1,
    funding_id: PROBE,
    generation_config_intent_id: PROBE,
    generation_key: value,
    sample_policy: PAPER_REGIME_SAMPLE_BUY_POLICY,
  });

/** The generation namespace WITHOUT its key: exactly the five columns 0006 pairs with
 * `generation_key`, in `PaperGateRowScope` minus the key being derived. */
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

const exactShape = (
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> | undefined => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  return Object.keys(record).length === keys.length &&
    keys.every((key) => Object.hasOwn(record, key))
    ? record
    : undefined;
};

function generationIdentity(identity: unknown): PaperGateGenerationIdentity | undefined {
  const record = exactShape(identity, GENERATION_FIELDS);
  if (record === undefined) return undefined;
  // One validator, not a second copy of its bounds: the five fields are checked by the
  // very function the writer validates a scope with, with the probe standing in for the
  // key this module is about to derive.
  return paperGateRowScopeIsValid({ ...record, generation_key: PROBE })
    ? (record as unknown as PaperGateGenerationIdentity)
    : undefined;
}

/** The exact bytes hashed, so a reviewer can reproduce a key with `printf`/`sha256sum`
 * without running this code. `undefined`, never a throw, on any input this module will not
 * frame. */
export function paperGateGenerationKeyFraming(identity: unknown): string | undefined {
  const fields = generationIdentity(identity);
  if (fields === undefined) return undefined;
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

export function paperGateGenerationKey(identity: unknown): string | undefined {
  const framed = paperGateGenerationKeyFraming(identity);
  return framed === undefined ? undefined : PAPER_GATE_GENERATION_KEY_PREFIX + sha256Hex(framed);
}

/** The derived key together with the namespace it was derived from, in the shape the
 * writer actually takes. Refuses unless the result satisfies the writer's own scope
 * validator, so a derivation can never hand out a scope no caller could use. */
export function paperGateRowScopeFromGenerationIdentity(
  identity: unknown,
): PaperGateRowScope | undefined {
  const fields = generationIdentity(identity);
  const generation_key = paperGateGenerationKey(identity);
  if (fields === undefined || generation_key === undefined) return undefined;
  const scope = { ...fields, generation_key };
  return paperGateRowScopeIsValid(scope) ? scope : undefined;
}

/** One phase event's identity: its generation, which of 0006's two event shapes it is, the
 * revision it advances from when it is an advance, and the run that intends it. */
export type PaperGatePhaseEventIdentity =
  | { generationKey: string; kind: 'genesis'; runId: string }
  | { generationKey: string; kind: 'evaluated'; revisionBefore: bigint; runId: string };

export function paperGatePhaseEventKeyFraming(identity: unknown): string | undefined {
  if (!identity || typeof identity !== 'object' || Array.isArray(identity)) return undefined;
  const kind = (identity as Record<string, unknown>).kind;
  if (kind !== 'genesis' && kind !== 'evaluated') return undefined;
  const record = exactShape(identity, kind === 'evaluated' ? EVALUATED_FIELDS : GENESIS_FIELDS);
  if (record === undefined) return undefined;
  const generationKey = record.generationKey;
  const runId = record.runId;
  if (!boundedIdentity(generationKey) || !boundedIdentity(runId)) return undefined;
  let revision = '';
  if (kind === 'evaluated') {
    const before = record.revisionBefore;
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
