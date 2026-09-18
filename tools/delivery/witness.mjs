// The separately permissioned witness.
//
// The catalog gives the witness writer `contents:read` and `issues:write` and
// gives the journal writer `contents:write` with no issue mutation. That
// separation is encoded here structurally: a `Witness` holds no reference to a
// journal and exposes no way to append an event, so no amount of calling it
// wrongly can make it write Git evidence. The orchestration below is the only
// place the two meet, and it meets them in the fixed order the protocol
// requires.
//
// Three things this deliberately does not do:
//
//   * It does not witness the acknowledgment. The pointer never advances to the
//     acknowledgment commit, so there is no recursion and no hash cycle.
//   * It does not treat the issue-body pointer as a compare-and-set. Issue PATCH
//     is not CAS, so an unexpected pointer change blocks rather than overwrites.
//   * It does not recreate missing evidence. A previously confirmed witness that
//     disappears blocks; a recreated comment restores nothing.
//
// Clause: docs/operations/production-control-plane.md#indexed-journal-schema-and-nonrecursive-witness

import { canonicalDigest, canonicalize } from './canonical-json.mjs';
import { TRANSITION_BUDGET } from './catalog-v2.mjs';
import { refuse } from './refusals.mjs';
import { assertPublishable } from './sanitize.mjs';

const COMMENT_FIELDS = [
  'epoch',
  'eventId',
  'executorOwner',
  'grantKey',
  'journalCommit',
  'sequence',
];
const POINTER_FIELDS = ['commentId', 'epoch', 'eventId', 'journalCommit', 'sequence'];

const ok = (fields) => ({ allowed: true, ...fields });

/**
 * The designated issue witness: an append-only comment log plus one mutable
 * body pointer.
 *
 * The comment log is corroboration; the pointer is current-intent convenience.
 * Neither is canonical audit — that is the journal's Git history.
 */
export class Witness {
  #comments = new Map();
  #pointer = null;
  #nextCommentId;

  constructor({ firstCommentId = 1 } = {}) {
    this.#nextCommentId = firstCommentId;
  }

  get pointer() {
    return this.#pointer;
  }

  /** Reads one comment directly by ID. Never scans the comment history. */
  comment(commentId) {
    return this.#comments.get(commentId) ?? null;
  }

  /**
   * Appends the corroborating comment binding one exact durable intent commit.
   *
   * Duplicate matching comments add no authority: a second append of identical
   * content returns the existing comment.
   */
  appendComment(record) {
    const unexpected = Object.keys(record).filter((key) => !COMMENT_FIELDS.includes(key));
    const absent = COMMENT_FIELDS.filter((key) => !(key in record));
    if (unexpected.length > 0 || absent.length > 0) {
      return refuse(
        'catalog.witness-corroboration',
        'witness-inconsistent',
        'a witness comment is exactly {epoch, sequence, eventId, journalCommit, grantKey, executorOwner}',
      );
    }

    const body = canonicalize(assertPublishable(record, 'witness comment'));
    if (Buffer.byteLength(body, 'utf8') > TRANSITION_BUDGET.maxWitnessBytes) {
      return refuse(
        'catalog.witness-corroboration',
        'witness-inconsistent',
        'the witness comment exceeds its declared size budget',
      );
    }

    for (const [commentId, existing] of this.#comments) {
      if (canonicalize(existing.record) === body) {
        return ok({ commentId, record: existing.record, duplicate: true });
      }
    }

    const commentId = this.#nextCommentId;
    this.#nextCommentId += 1;
    this.#comments.set(commentId, {
      record: Object.freeze({ ...record }),
      digest: canonicalDigest(record),
    });
    return ok({ commentId, record, duplicate: false });
  }

  /**
   * Updates the mutable body pointer, refusing when it is not where the caller
   * last observed it.
   *
   * `expectedPrevious` is the pointer the caller read; a mismatch means somebody
   * else moved it, which blocks. This is a guard, not a compare-and-set: the
   * host provides no atomic issue update, and pretending otherwise is exactly
   * the mistake the clause warns about.
   */
  updatePointer(pointer, { expectedPrevious = null } = {}) {
    const unexpected = Object.keys(pointer).filter((key) => !POINTER_FIELDS.includes(key));
    const absent = POINTER_FIELDS.filter((key) => !(key in pointer));
    if (unexpected.length > 0 || absent.length > 0) {
      return refuse(
        'catalog.witness-corroboration',
        'witness-inconsistent',
        'a witness pointer is exactly {epoch, sequence, eventId, journalCommit, commentId}',
      );
    }
    if (canonicalize(this.#pointer) !== canonicalize(expectedPrevious)) {
      return refuse(
        'catalog.witness-corroboration',
        'witness-inconsistent',
        'the witness pointer moved unexpectedly; issue update is not compare-and-set',
      );
    }
    const comment = this.#comments.get(pointer.commentId);
    if (!comment) {
      return refuse(
        'catalog.witness-corroboration',
        'witness-missing',
        'the pointer names a comment that cannot be read by ID',
      );
    }
    if (
      comment.record.eventId !== pointer.eventId ||
      comment.record.journalCommit !== pointer.journalCommit ||
      comment.record.epoch !== pointer.epoch ||
      comment.record.sequence !== pointer.sequence
    ) {
      return refuse(
        'catalog.witness-corroboration',
        'witness-inconsistent',
        'the pointer and its comment disagree on the corroborated intent',
      );
    }

    this.#pointer = Object.freeze({ ...pointer });
    return ok({ pointer: this.#pointer });
  }

  /**
   * Removes a comment, modelling evidence that disappears.
   *
   * Present so the deleted-witness fault has a way to occur in a fixture. It is
   * not a repair path: nothing in this module can restore authority afterwards.
   */
  dropComment(commentId) {
    return this.#comments.delete(commentId);
  }
}

/**
 * Re-checks a previously confirmed witness against what is readable now.
 *
 * A confirmed witness that is missing or inconsistent blocks. It is never
 * recreated: recreating it and inferring execution authority is precisely the
 * failure this returns a refusal for.
 */
export function verifyConfirmedWitness(witness, confirmed) {
  if (!confirmed) {
    return refuse(
      'catalog.witness-corroboration',
      'witness-missing',
      'intent without a confirmed witness is pending or unknown, never authority',
    );
  }
  const comment = witness.comment(confirmed.commentId);
  if (!comment) {
    return refuse(
      'catalog.faults',
      'witness-inconsistent',
      'a previously confirmed witness is missing; a recreated comment cannot restore authority',
    );
  }
  if (
    comment.record.eventId !== confirmed.eventId ||
    comment.record.journalCommit !== confirmed.journalCommit ||
    comment.record.sequence !== confirmed.sequence ||
    comment.record.epoch !== confirmed.epoch
  ) {
    return refuse(
      'catalog.faults',
      'witness-inconsistent',
      'the confirmed witness comment no longer matches the corroborated intent',
    );
  }
  const pointer = witness.pointer;
  if (
    !pointer ||
    pointer.eventId !== confirmed.eventId ||
    pointer.journalCommit !== confirmed.journalCommit ||
    pointer.commentId !== confirmed.commentId
  ) {
    return refuse(
      'catalog.faults',
      'witness-inconsistent',
      'the current pointer no longer names the confirmed intent',
    );
  }
  return ok({ confirmed });
}

/**
 * Runs one full intent corroboration: witness comment, readback, pointer
 * update, then the journal's own acknowledgment.
 *
 * The acknowledgment is appended by the journal writer, after the witness
 * writer has finished, and is never fed back to the witness. That ordering is
 * the whole point of the separation, so it lives in one function rather than
 * being left to each call site.
 */
export function corroborateIntent(journal, witness, { grantKey, intent, occurredAt }) {
  const record = {
    epoch: intent.epoch,
    sequence: intent.sequence,
    eventId: intent.eventId,
    journalCommit: intent.journalCommit,
    grantKey,
    executorOwner: intent.executorOwner,
  };

  const appended = witness.appendComment(record);
  if (!appended.allowed) return appended;

  const readback = witness.comment(appended.commentId);
  if (!readback || canonicalize(readback.record) !== canonicalize(record)) {
    return refuse(
      'catalog.witness-corroboration',
      'witness-inconsistent',
      'the witness comment did not read back exactly as appended',
    );
  }

  const pointer = {
    epoch: intent.epoch,
    sequence: intent.sequence,
    eventId: intent.eventId,
    journalCommit: intent.journalCommit,
    commentId: appended.commentId,
  };
  const previous = witness.pointer;
  const moved = witness.updatePointer(pointer, { expectedPrevious: previous });
  if (!moved.allowed) return moved;

  const acknowledgment = journal.appendAcknowledgment({
    grantKey,
    intentEventId: intent.eventId,
    pointer,
    occurredAt,
  });
  if (!acknowledgment.allowed) return acknowledgment;

  return ok({
    commentId: appended.commentId,
    pointer,
    acknowledgment: acknowledgment.event,
    // The acknowledgment is not witnessed and the pointer stays on the intent.
    witnessedAcknowledgment: false,
  });
}
