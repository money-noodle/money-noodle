// The append-only sanitised evidence record.
//
// This is the provider-disabled journal adapter: it implements the indexed
// schema and transition protocol from
// `docs/operations/production-control-plane.md#indexed-journal-schema-and-nonrecursive-witness`
// over a pluggable in-memory store. It creates no ref, contacts no host and is
// not the `operation-journal-v1` branch — that branch does not exist and is not
// created by this code. What it does is make the rules executable and testable
// now: immutability, strictly increasing sequence, sole-parent fast-forward,
// atomic snapshot updates, owner exclusion and sanitisation.
//
// Commit identifiers here are content digests over `{parent, eventId, sequence}`
// rather than Git object IDs. The real writer substitutes the actual commit it
// produced; the *shape* of the check — sole parent, exact readback, no
// reparenting — is what this adapter fixes.
//
// Two properties are load-bearing and are what the policy suite pins:
//
//   * Append is idempotent under a repeated request ID. A retried admission
//     returns the event already recorded instead of spending a slot twice.
//   * A stale owner cannot append. `executorOwner` is immutable from admission,
//     so a rerun or a new run can record facts only under its own request, never
//     adopt an existing one.

import { canonicalDigest, canonicalize } from './canonical-json.mjs';
import { ERROR_CLASSES, EVENT_TYPES, OUTCOMES, PHASES } from './catalog-v2.mjs';
import { refuse } from './refusals.mjs';
import { assertPublishable } from './sanitize.mjs';

export const SCHEMA_VERSION = 1;

const EVENT_FIELDS = [
  'causationId',
  'consentDigest',
  'epoch',
  'errorClass',
  'eventId',
  'eventType',
  'executorOwner',
  'grantKey',
  'intendedCounts',
  'lastAcknowledgment',
  'observations',
  'occurredAt',
  'outcome',
  'parentCommit',
  'permissionSlot',
  'phase',
  'previousEventId',
  'realizedCounts',
  'recordedAt',
  'requestId',
  'schemaVersion',
  'sequence',
  'uncertainty',
  'witnessAck',
];

const ok = (fields) => ({ allowed: true, ...fields });

const commitFor = (parentCommit, eventId, sequence) =>
  canonicalDigest({ eventId, parentCommit, sequence });

/**
 * The identity-bearing projection of an event.
 *
 * Two appends are the same append when these agree. Position in the chain
 * (`sequence`, `previousEventId`, `parentCommit`) is excluded because it
 * necessarily differs on a retry.
 */
const IDENTITY_FIELDS = EVENT_FIELDS.filter(
  (field) => !['parentCommit', 'previousEventId', 'recordedAt', 'sequence'].includes(field),
);

const identityOf = (event) =>
  canonicalize(Object.fromEntries(IDENTITY_FIELDS.map((field) => [field, event[field] ?? null])));

/**
 * An append-only journal over an in-memory index.
 *
 * Snapshots (`control`, `requests`, `targets`) are derived indexes that are
 * replaced atomically with each append; `events` is never replaced.
 */
export class Journal {
  #epoch;
  #events = new Map();
  #requests = new Map();
  #targets = new Map();
  #control;
  #head;

  constructor({ epoch = 1, genesisEventId = 'genesis-1', occurredAt } = {}) {
    if (!Number.isInteger(epoch) || epoch < 1) throw new Error('epoch must be a positive integer');
    this.#epoch = epoch;
    const recordedAt = occurredAt ?? '1970-01-01T00:00:00Z';
    const genesis = this.#buildEvent({
      eventId: genesisEventId,
      eventType: 'genesis',
      sequence: 1,
      previousEventId: null,
      parentCommit: null,
      requestId: null,
      grantKey: null,
      consentDigest: null,
      executorOwner: null,
      permissionSlot: null,
      phase: 'requested',
      causationId: null,
      outcome: 'pending',
      occurredAt: recordedAt,
    });
    this.#head = commitFor(null, genesisEventId, 1);
    this.#events.set(genesisEventId, genesis);
    this.#control = Object.freeze({
      schemaVersion: SCHEMA_VERSION,
      epoch,
      sequence: 1,
      latestEventId: genesisEventId,
      activeRequestId: null,
      pendingIntent: null,
      witness: null,
      lastAcknowledgment: null,
    });
  }

  get head() {
    return this.#head;
  }

  get epoch() {
    return this.#epoch;
  }

  /** The current `control/current.json` projection. */
  get control() {
    return this.#control;
  }

  /** Immutable events, oldest first. */
  get events() {
    return [...this.#events.values()];
  }

  event(eventId) {
    return this.#events.get(eventId) ?? null;
  }

  request(grantKey) {
    return this.#requests.get(grantKey) ?? null;
  }

  target(logicalIncarnation) {
    return this.#targets.get(logicalIncarnation) ?? null;
  }

  /**
   * The commit an event was recorded in, derived from the event's own fields.
   *
   * Deliberately derived rather than stored: an event that carried its own
   * containing commit would be a hash cycle, so the containing commit is only
   * ever computable from outside the event.
   */
  commitOf(eventId) {
    const event = this.#events.get(eventId);
    if (!event) return null;
    return commitFor(event.parentCommit, event.eventId, event.sequence);
  }

  #buildEvent(fields) {
    const event = {
      schemaVersion: SCHEMA_VERSION,
      epoch: this.#epoch,
      errorClass: 'none',
      intendedCounts: null,
      realizedCounts: null,
      observations: [],
      uncertainty: null,
      witnessAck: null,
      lastAcknowledgment: this.#control?.lastAcknowledgment ?? null,
      recordedAt: fields.occurredAt,
      ...fields,
    };
    const unexpected = Object.keys(event).filter((key) => !EVENT_FIELDS.includes(key));
    if (unexpected.length > 0)
      throw new Error(`unknown event fields: ${unexpected.sort().join(',')}`);
    const absent = EVENT_FIELDS.filter((key) => !(key in event));
    if (absent.length > 0) throw new Error(`missing event fields: ${absent.sort().join(',')}`);
    if (!EVENT_TYPES.includes(event.eventType))
      throw new Error(`unknown event type ${event.eventType}`);
    if (!PHASES.includes(event.phase)) throw new Error(`unknown phase ${event.phase}`);
    if (!OUTCOMES.includes(event.outcome)) throw new Error(`unknown outcome ${event.outcome}`);
    if (!ERROR_CLASSES.includes(event.errorClass)) throw new Error(`unknown error class`);
    return Object.freeze(assertPublishable(event, 'journal event'));
  }

  /**
   * Appends `event` onto the current head.
   *
   * Refuses rather than throws for every policy condition, so a caller handles
   * a stale owner and a broken parent link the same way it handles any other
   * refusal.
   */
  #append(fields, { expectedParent } = {}) {
    const parentCommit = this.#head;
    if (expectedParent !== undefined && expectedParent !== parentCommit) {
      // Concurrent siblings cannot both fast-forward; the loser rereads and
      // re-evaluates rather than reparenting its admission.
      return refuse(
        'catalog.journal-transition',
        'journal-parent-stale',
        'the journal head moved; reread and re-evaluate rather than reparenting',
      );
    }

    const sequence = this.#control.sequence + 1;
    const existing = this.#events.get(fields.eventId);
    if (existing) {
      // A retried append observes the effect it already had. Only the
      // identity-bearing fields are compared: sequence, previous event and
      // parent commit necessarily differ on a retry and are not what makes two
      // appends the same append.
      if (identityOf(existing) === identityOf({ ...existing, ...fields })) {
        return ok({
          event: existing,
          commit: this.#head,
          sequence: existing.sequence,
          idempotent: true,
        });
      }
      return refuse(
        'catalog.journal-transition',
        'journal-event-immutable',
        'an event is immutable and is never replaced',
        fields.eventId,
      );
    }

    let event;
    try {
      event = this.#buildEvent({
        ...fields,
        sequence,
        previousEventId: this.#control.latestEventId,
        parentCommit,
      });
    } catch (error) {
      if (error?.refusal)
        return { allowed: false, mayExchangeMutationToken: false, refusal: error.refusal };
      throw error;
    }

    const commit = commitFor(parentCommit, event.eventId, sequence);
    this.#events.set(event.eventId, event);
    this.#head = commit;
    return ok({ event, commit, sequence, idempotent: false });
  }

  #setControl(changes) {
    this.#control = Object.freeze({ ...this.#control, ...changes });
  }

  /**
   * Admits one request: appends its intent and spends its slot atomically.
   *
   * Idempotent under a repeated request ID. A second admission of the same
   * request with identical grant-bound content returns the recorded event with
   * `idempotent: true` and spends nothing further.
   */
  appendIntent({
    requestId,
    grantKey,
    consentDigest,
    permissionSlot,
    executorOwner,
    targetVector = [],
    intendedCounts = null,
    occurredAt,
    eventId,
    expectedParent,
  }) {
    const identity = {
      consentDigest,
      grantKey,
      intendedCounts,
      permissionSlot,
      requestId,
      targets: targetVector.map((target) => target.logicalIncarnation).sort(),
    };
    const resolvedEventId = eventId ?? `intent-${canonicalDigest(identity).slice(0, 16)}`;

    const existingRequest = this.#requests.get(grantKey);
    if (existingRequest) {
      const ownerRefusal = this.#refuseStaleOwner(existingRequest, executorOwner);
      if (ownerRefusal) return ownerRefusal;

      if (existingRequest.outstandingIntent) {
        const recorded = this.#events.get(existingRequest.outstandingIntent.eventId);
        if (canonicalize(recorded.executorOwner) !== canonicalize(executorOwner)) {
          return this.#staleOwnerRefusal();
        }
        if (
          recorded.requestId === requestId &&
          recorded.consentDigest === consentDigest &&
          recorded.permissionSlot === permissionSlot &&
          canonicalize(recorded.intendedCounts) === canonicalize(intendedCounts)
        ) {
          // The retried admission observes the effect it already had.
          return ok({
            event: recorded,
            commit: this.#head,
            sequence: recorded.sequence,
            idempotent: true,
          });
        }
        return refuse(
          'catalog.journal-transition',
          'journal-event-immutable',
          'a different intent cannot replace the outstanding one for this grant',
          permissionSlot,
        );
      }

      if (existingRequest.consumedSlots[permissionSlot]) {
        return refuse(
          'catalog.slot-spent',
          'slot-already-spent',
          'the slot is spent at admission and remains spent on failure or abandonment',
          permissionSlot,
        );
      }
    }

    if (this.#control.activeRequestId !== null && this.#control.activeRequestId !== requestId) {
      return refuse(
        'catalog.journal-transition',
        'global-request-active',
        'one global active M1 provider request is permitted',
      );
    }

    const appended = this.#append(
      {
        eventId: resolvedEventId,
        eventType: 'intent',
        requestId,
        grantKey,
        consentDigest,
        executorOwner,
        permissionSlot,
        phase: 'admitted',
        causationId: null,
        intendedCounts,
        outcome: 'pending',
        occurredAt,
      },
      { expectedParent },
    );
    if (!appended.allowed) return appended;

    const consumedSlots = {
      ...(existingRequest?.consumedSlots ?? {}),
      [permissionSlot]: { admissionEventId: appended.event.eventId, grantKey },
    };
    this.#requests.set(grantKey, {
      schemaVersion: SCHEMA_VERSION,
      grantKey,
      requestId,
      consentDigest,
      executorOwner,
      permissionSlot,
      consumedSlots,
      phase: 'admitted',
      latestEventId: appended.event.eventId,
      outstandingIntent: { eventId: appended.event.eventId, sequence: appended.sequence },
      uncertainty: null,
    });

    for (const target of targetVector) {
      this.#targets.set(target.logicalIncarnation, {
        schemaVersion: SCHEMA_VERSION,
        logicalIncarnation: target.logicalIncarnation,
        configurationVersion: target.configurationVersion,
        expectedSafeVersions: target.expectedSafeVersions,
        observedSafeVersions: null,
        ownerRequestId: requestId,
        blockedReason: null,
        latestEventId: appended.event.eventId,
        observedAt: null,
      });
    }

    this.#setControl({
      sequence: appended.sequence,
      latestEventId: appended.event.eventId,
      activeRequestId: requestId,
      pendingIntent: { eventId: appended.event.eventId, sequence: appended.sequence },
    });

    return appended;
  }

  #staleOwnerRefusal() {
    return refuse(
      'catalog.executor-owner',
      'executor-owner-stale',
      'executorOwner is immutable from admission; a rerun or new run cannot adopt it',
    );
  }

  #refuseStaleOwner(request, executorOwner) {
    if (canonicalize(request.executorOwner) !== canonicalize(executorOwner)) {
      return this.#staleOwnerRefusal();
    }
    return null;
  }

  /**
   * Appends the `witness-ack` at sequence n+1 with the intent commit as sole
   * parent, clearing the pending intent.
   *
   * The acknowledgment is never itself witnessed and never carries its own
   * containing commit, so no hash cycle and no recursive corroboration exists.
   */
  appendAcknowledgment({ grantKey, intentEventId, pointer, occurredAt, eventId }) {
    const request = this.#requests.get(grantKey);
    if (!request) {
      return refuse(
        'catalog.witness-corroboration',
        'witness-inconsistent',
        'no admitted request holds this grant',
      );
    }
    const intent = this.#events.get(intentEventId);
    if (!intent || intent.eventType !== 'intent') {
      return refuse(
        'catalog.witness-corroboration',
        'witness-inconsistent',
        'the acknowledgment must name an existing intent event',
      );
    }
    if (!request.outstandingIntent || request.outstandingIntent.eventId !== intentEventId) {
      return refuse(
        'catalog.witness-corroboration',
        'witness-inconsistent',
        'the acknowledgment does not correspond to the outstanding intent',
      );
    }
    if (!pointer || pointer.eventId !== intentEventId) {
      return refuse(
        'catalog.witness-corroboration',
        'witness-inconsistent',
        'the witness pointer must bind the exact intent event',
      );
    }
    if (this.#events.get(intentEventId)?.witnessAck) {
      return refuse(
        'catalog.witness-corroboration',
        'witness-recursive',
        'an acknowledgment is never itself witnessed',
      );
    }

    const acknowledgmentEventId = eventId ?? `ack-${intentEventId}`;
    const appended = this.#append({
      eventId: acknowledgmentEventId,
      eventType: 'witness-ack',
      requestId: request.requestId,
      grantKey,
      consentDigest: request.consentDigest,
      executorOwner: request.executorOwner,
      permissionSlot: intent.permissionSlot,
      phase: 'intent-corroborated',
      causationId: intentEventId,
      outcome: 'pending',
      occurredAt,
      witnessAck: pointer,
      lastAcknowledgment: { eventId: acknowledgmentEventId, sequence: this.#control.sequence + 1 },
    });
    if (!appended.allowed) return appended;

    this.#requests.set(grantKey, {
      ...request,
      phase: 'intent-corroborated',
      latestEventId: appended.event.eventId,
      outstandingIntent: null,
    });
    this.#setControl({
      sequence: appended.sequence,
      latestEventId: appended.event.eventId,
      pendingIntent: null,
      witness: pointer,
      lastAcknowledgment: { eventId: appended.event.eventId, sequence: appended.sequence },
    });
    return appended;
  }

  /**
   * Appends post-admission evidence: submission, observation, verification or
   * abandonment.
   *
   * Evidence never authorises a call and never clears a spent slot. It refuses
   * a stale owner for the same reason admission does: a new run may record
   * facts, never adopt the request.
   */
  appendEvidence({
    grantKey,
    eventType,
    phase,
    executorOwner,
    observations = [],
    realizedCounts = null,
    outcome = 'pending',
    errorClass = 'none',
    uncertainty = null,
    occurredAt,
    eventId,
    causationId = null,
    expectedParent,
  }) {
    if (!['submission', 'observation', 'verification', 'abandonment'].includes(eventType)) {
      return refuse(
        'catalog.journal-transition',
        'journal-sequence-invalid',
        'evidence is a submission, observation, verification or abandonment',
        eventType,
      );
    }
    const request = this.#requests.get(grantKey);
    if (!request) {
      return refuse(
        'catalog.journal-transition',
        'journal-not-corroborated',
        'no admitted request holds this grant',
      );
    }
    const ownerRefusal = this.#refuseStaleOwner(request, executorOwner);
    if (ownerRefusal) return ownerRefusal;

    const appended = this.#append(
      {
        eventId:
          eventId ??
          `${eventType}-${canonicalDigest({ eventType, grantKey, occurredAt }).slice(0, 16)}`,
        eventType,
        requestId: request.requestId,
        grantKey,
        consentDigest: request.consentDigest,
        executorOwner: request.executorOwner,
        permissionSlot: request.permissionSlot,
        phase,
        causationId,
        observations,
        realizedCounts,
        outcome,
        errorClass,
        uncertainty,
        occurredAt,
      },
      { expectedParent },
    );
    if (!appended.allowed) return appended;

    this.#requests.set(grantKey, {
      ...request,
      phase,
      latestEventId: appended.event.eventId,
    });
    // Evidence preserves the acknowledgment index and witness pointer: the
    // latest event may be later evidence while `lastAcknowledgment` still
    // indexes the acknowledgment, without recursion.
    this.#setControl({ sequence: appended.sequence, latestEventId: appended.event.eventId });
    return appended;
  }

  /**
   * The ledger projection the grant check consumes.
   *
   * Deliberately a projection rather than the journal itself: the grant check
   * reads facts, and cannot mutate evidence to make itself pass.
   */
  ledgerFor(grantKey) {
    const request = this.#requests.get(grantKey);
    const acknowledgment = this.#control.lastAcknowledgment
      ? this.#events.get(this.#control.lastAcknowledgment.eventId)
      : null;
    return {
      consumedSlots: request?.consumedSlots ?? {},
      activeRequestId: this.#control.activeRequestId,
      corroboration:
        acknowledgment && request && acknowledgment.grantKey === grantKey
          ? {
              requestId: request.requestId,
              intentEventId: acknowledgment.causationId,
              acknowledgmentEventId: acknowledgment.eventId,
              witnessConfirmed: Boolean(this.#control.witness),
            }
          : null,
      verifiedPredecessors: [],
    };
  }
}

export const openJournal = (options) => new Journal(options);
