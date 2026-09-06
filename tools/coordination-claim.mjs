#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import {
  BOOTSTRAP_BRANCH,
  BOOTSTRAP_ISSUE,
  CLAIM_BRANCH_VERSION,
  CHECKPOINT_EVIDENCE_FIELDS,
  V1_PORTABLE_CLAIM_FIELDS,
  V2_PORTABLE_CLAIM_FIELDS,
  claimBranchForIssue,
  claimRefForIssue,
  parseReservedClaimBranch,
  parseReservedClaimRef,
  structuredRecord,
  validateCheckpointComment,
  validateClaimBranch,
  validateWorkItemBody,
} from './coordination-schema.mjs';

export {
  BOOTSTRAP_BRANCH,
  BOOTSTRAP_ISSUE,
  CLAIM_BRANCH_VERSION,
  claimBranchForIssue,
  claimRefForIssue,
  parseReservedClaimBranch,
  parseReservedClaimRef,
  validateClaimBranch,
} from './coordination-schema.mjs';
import { evaluateClaimCommentHistoryForBody, hasClaimSignal } from './coordination-lib.mjs';
import { assertFreshScopeGate } from './coordination-scope.mjs';
import { buildReport as buildCoordinationStatusReport } from './coordination-status.mjs';
import { prepareClaimEstablishmentWrite } from './coordination-write.mjs';

export const CANONICAL_REPOSITORY = 'money-noodle/money-noodle';
const FULL_COMMIT = /^[0-9a-f]{40}$/;
const STATE_LABELS = new Set([
  'work:proposed',
  'work:ready',
  'work:active',
  'work:blocked',
  'work:review',
  'work:done',
  'work:abandoned',
]);

export class CoordinationClaimError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'CoordinationClaimError';
    this.code = code;
    this.details = details;
  }
}

function positiveIssueNumber(value) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new CoordinationClaimError(
      'invalid-issue-number',
      'issue number must be a canonical positive safe integer',
    );
  }
  return value;
}

function fullCommit(value, field = 'expected base') {
  if (typeof value !== 'string' || !FULL_COMMIT.test(value)) {
    throw new CoordinationClaimError('invalid-commit', `${field} must be a full lowercase commit`);
  }
  return value;
}

function assertClaimHost(host) {
  for (const method of ['readRepository', 'readMainRef', 'readClaimRef', 'createClaimRef']) {
    if (typeof host?.[method] !== 'function') {
      throw new CoordinationClaimError('invalid-claim-host', `claimHost.${method} is required`);
    }
  }
}

function assertWriterHost(host) {
  for (const method of ['readIssue', 'updateBody', 'replaceStateLabel', 'addComment']) {
    if (typeof host?.[method] !== 'function') {
      throw new CoordinationClaimError('invalid-writer-host', `writerHost.${method} is required`);
    }
  }
}

function normalizeRef(record, expectedRef, expectedSha) {
  if (
    !record ||
    record.ref !== expectedRef ||
    record.object?.type !== 'commit' ||
    record.object?.sha !== expectedSha
  ) {
    throw new CoordinationClaimError(
      'invalid-ref-response',
      'claim ref must be the exact requested commit reference',
      { expectedRef, expectedSha, observed: record },
    );
  }
  return { ref: record.ref, sha: record.object.sha, objectType: record.object.type };
}

function issueStateLabels(labels) {
  return labels.filter((label) => STATE_LABELS.has(label));
}

const OPERATION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const AGENT_IDENTITY_FIELDS = V2_PORTABLE_CLAIM_FIELDS.filter(
  (field) => !['Claim-State', 'Check-In-By', 'Waiting-Since'].includes(field),
);

function inspectOperationEvidence(comment) {
  const body = typeof comment?.body === 'string' ? comment.body : '';
  const markerRecord = structuredRecord(body, ['Coordination-Write-ID']);
  const markerOccurrences = markerRecord.occurrences['Coordination-Write-ID'];
  const mentionsMarker = /(?:^|\n)Coordination-Write-ID\s*:/m.test(body);
  if (
    (mentionsMarker && markerOccurrences.length !== 1) ||
    (markerOccurrences.length === 1 &&
      !OPERATION_ID.test(markerRecord.fields['Coordination-Write-ID']))
  ) {
    return {
      valid: false,
      code: 'malformed-operation-evidence',
      message: `comment ${comment.id ?? 'unknown'} has malformed operation evidence`,
    };
  }
  return {
    valid: true,
    mentionsMarker,
    operationId: mentionsMarker ? markerRecord.fields['Coordination-Write-ID'] : null,
  };
}

function inspectClaimComment(comment, prepared, phase) {
  const body = typeof comment?.body === 'string' ? comment.body : '';
  const operation = inspectOperationEvidence(comment);
  if (!operation.valid) return operation;
  const { mentionsMarker } = operation;
  if (!mentionsMarker && !hasClaimSignal(body)) return { valid: true, kind: 'unrelated' };

  const v2Record = structuredRecord(body, [
    ...V2_PORTABLE_CLAIM_FIELDS,
    ...CHECKPOINT_EVIDENCE_FIELDS,
  ]);
  const v1Record = structuredRecord(body, V1_PORTABLE_CLAIM_FIELDS);
  const isV2 =
    v2Record.fields['Claim-Host'] !== undefined ||
    v2Record.fields['Checkpoint-Evidence-Version'] !== undefined;
  let fields;
  if (isV2) {
    const self = { version: '2', fields: v2Record.fields };
    const validation = validateCheckpointComment(body, self);
    if (!validation.applicable || !validation.valid) {
      return {
        valid: false,
        code:
          phase === 'recovery' && ['active', 'review'].includes(v2Record.fields['Claim-State'])
            ? 'competing-agent-ownership'
            : phase === 'recovery' && mentionsMarker
              ? 'malformed-operation-evidence'
              : 'malformed-ownership-evidence',
        message: `comment ${comment.id ?? 'unknown'} has incomplete or invalid schema-v2 ownership evidence`,
      };
    }
    fields = v2Record.fields;
  } else {
    const missing = V1_PORTABLE_CLAIM_FIELDS.filter(
      (field) => v1Record.occurrences[field]?.length !== 1,
    );
    if (missing.length > 0 || v1Record.duplicates.length > 0) {
      return {
        valid: false,
        code:
          phase === 'recovery' && ['active', 'review'].includes(v1Record.fields['Claim-State'])
            ? 'competing-agent-ownership'
            : phase === 'recovery' && mentionsMarker
              ? 'malformed-operation-evidence'
              : 'malformed-ownership-evidence',
        message: `comment ${comment.id ?? 'unknown'} has incomplete or duplicate historical ownership evidence`,
      };
    }
    fields = v1Record.fields;
  }

  const state = fields['Claim-State'];
  if (!['proposed', 'ready', 'active', 'blocked', 'review', 'done', 'abandoned'].includes(state)) {
    return {
      valid: false,
      code: 'malformed-ownership-evidence',
      message: `comment ${comment.id ?? 'unknown'} has an unsupported claim state`,
    };
  }
  if (['proposed', 'ready'].includes(state)) {
    const ownershipFields = isV2
      ? AGENT_IDENTITY_FIELDS
      : V1_PORTABLE_CLAIM_FIELDS.filter(
          (field) => !['Claim-State', 'Claimed-At', 'Check-In-By'].includes(field),
        );
    if (ownershipFields.some((field) => fields[field] !== 'unclaimed')) {
      return {
        valid: false,
        code: 'malformed-ownership-evidence',
        message: `comment ${comment.id ?? 'unknown'} has ownership attached to parked work`,
      };
    }
    return { valid: true, kind: 'historical-parked', state };
  }
  if (['active', 'review'].includes(state)) {
    const matching =
      isV2 && AGENT_IDENTITY_FIELDS.every((field) => fields[field] === prepared.fields[field]);
    if (phase === 'before-create' || !matching) {
      return {
        valid: false,
        code: 'competing-agent-ownership',
        message: `comment ${comment.id ?? 'unknown'} carries competing agent-owned evidence`,
      };
    }
    return { valid: true, kind: 'matching-agent-history', state };
  }
  return { valid: true, kind: 'historical-non-agent', state };
}

function inspectClaimComments(comments, prepared, phase, body) {
  const history = evaluateClaimCommentHistoryForBody(body, comments, {
    claimAgent: prepared.fields['Claim-Agent'],
  });
  const { resolution } = history;
  if (resolution.status === 'invalid') {
    return {
      valid: false,
      code: 'invalid-claim-comment-reconciliation',
      message: resolution.problems.map(({ message }) => message).join('; '),
      resolution,
    };
  }
  for (const comment of comments) {
    const operation = inspectOperationEvidence(comment);
    if (!operation.valid) return { ...operation, resolution };
  }
  for (const comment of history.unreconciledComments) {
    const inspection = inspectClaimComment(comment, prepared, phase);
    if (!inspection.valid) return { ...inspection, resolution };
  }
  return { valid: true, resolution };
}

function inspectPrivilegedWriterSnapshot(issue, claim, operationId) {
  const sourceBody = issue.body === claim.expectedBody;
  const preparedBody = issue.body === claim.prepared.body;
  const unsafe = (code, message, status = sourceBody ? 'orphaned' : 'collision', detail = {}) => ({
    valid: false,
    status,
    code,
    message: `${message}; preserve the ref for principal reconciliation`,
    ...detail,
  });
  if (issue.state !== 'open') {
    return unsafe('post-ref-issue-not-open', 'the issue is no longer open');
  }
  if (!sourceBody && !preparedBody) {
    return unsafe(
      'post-ref-body-collision',
      'the issue body is neither the exact parked source nor the prepared claim',
      'collision',
    );
  }
  const labels = issueStateLabels(issue.labels);
  const sourceLabel = `work:${claim.expected.fields['Claim-State']}`;
  const allowedLabels = preparedBody
    ? new Set([sourceLabel, claim.desiredLabel])
    : new Set([sourceLabel]);
  if (labels.length !== 1 || !allowedLabels.has(labels[0])) {
    return unsafe(
      'post-ref-label-mismatch',
      `the sole state label ${labels[0] ?? 'missing'} is unsafe for the observed body stage`,
    );
  }
  const comments = inspectClaimComments(
    issue.comments,
    claim.prepared,
    sourceBody ? 'before-create' : 'recovery',
    issue.body,
  );
  if (!comments.valid) {
    return unsafe(
      `post-ref-${comments.code}`,
      comments.message,
      comments.code === 'competing-agent-ownership' ? 'collision' : undefined,
    );
  }
  const matchingCheckpoints = matchingCheckpointEvidence(
    issue.comments,
    claim,
    comments.resolution,
  );
  const coherent =
    preparedBody &&
    matchingCheckpoints.length > 0 &&
    labels.length === 1 &&
    labels[0] === claim.desiredLabel;
  const observedOperations = [
    ...new Set(matchingCheckpoints.map(({ operationId: id }) => id ?? 'missing')),
  ];
  if (
    preparedBody &&
    !coherent &&
    (matchingCheckpoints.length !== 1 || matchingCheckpoints[0].operationId !== operationId)
  ) {
    return unsafe(
      'post-ref-operation-mismatch',
      `an incomplete claim is recoverable only from one exact checkpoint carrying operation ${operationId}; observed ${observedOperations.join(', ') || 'none'}, so recovery may not mutate or append evidence`,
      'collision',
      { observedOperations },
    );
  }
  return {
    valid: true,
    bodyStage: sourceBody ? 'parked-source' : 'prepared-claim',
    label: labels[0],
    resolution: comments.resolution,
    matchingCheckpoints,
    coherent,
  };
}

function claimSnapshotGuard(claim, operationId, { stopOnCoherent = false } = {}) {
  return ({ issue }) => {
    const inspection = inspectPrivilegedWriterSnapshot(issue, claim, operationId);
    if (!stopOnCoherent || !inspection.valid || !inspection.coherent) return inspection;
    return {
      ...inspection,
      valid: false,
      status: 'existing',
      code: 'existing-coherent-claim',
      message: 'the exact complete claim already exists; no recovery mutation is required',
    };
  };
}

function matchingCheckpointEvidence(comments, claim, resolution) {
  const reconciledIds = new Set(resolution.reconciledIds);
  return comments.flatMap((comment) => {
    if (reconciledIds.has(comment.id)) return [];
    const validation = validateCheckpointComment(comment.body ?? '', claim.prepared.validation);
    if (!validation.applicable || !validation.valid) return [];
    const operation = inspectOperationEvidence(comment);
    return [
      {
        commentId: comment.id,
        operationId: operation.valid ? operation.operationId : null,
      },
    ];
  });
}

function inspectIssueBeforeCreate(issue, claim) {
  if (issue.state !== 'open') {
    return { valid: false, code: 'claim-issue-not-open', message: 'the claim issue must be open' };
  }
  if (issue.body !== claim.expectedBody) {
    return {
      valid: false,
      code: 'pre-create-body-collision',
      message: 'the issue body changed before ref creation',
    };
  }
  const labels = issueStateLabels(issue.labels);
  const expectedLabel = `work:${claim.expected.fields['Claim-State']}`;
  if (labels.length !== 1 || labels[0] !== expectedLabel) {
    return {
      valid: false,
      code: 'pre-create-label-mismatch',
      message: `the issue must have exactly the parked state label ${expectedLabel}`,
    };
  }
  return inspectClaimComments(issue.comments, claim.prepared, 'before-create', issue.body);
}

function preparedClaim({ issueNumber, expectedBody, values, checkpointComment, operationId }) {
  const expected = validateWorkItemBody(expectedBody);
  if (!expected.valid || expected.version !== '2') {
    throw new CoordinationClaimError(
      'invalid-expected-body',
      'initial remote-reference claims require one valid schema-v2 body snapshot',
      { errors: expected.errors },
    );
  }
  if (!['proposed', 'ready'].includes(expected.fields['Claim-State'])) {
    throw new CoordinationClaimError(
      'claim-source-not-parked',
      'initial claims start only from proposed or ready',
    );
  }
  const derivedBranch = claimBranchForIssue(issueNumber);
  if (values?.['Claim-Branch'] !== undefined && values['Claim-Branch'] !== derivedBranch) {
    throw new CoordinationClaimError(
      'caller-selected-branch',
      `Claim-Branch is derived and must equal ${derivedBranch}`,
    );
  }
  const canonicalValues = { ...values, 'Claim-Branch': derivedBranch };
  if (canonicalValues['Claim-State'] !== 'active') {
    throw new CoordinationClaimError(
      'invalid-initial-claim-state',
      'a new remote-reference claim enters active state',
    );
  }
  const writePreparation = prepareClaimEstablishmentWrite({
    currentBody: expectedBody,
    values: canonicalValues,
    checkpointComment,
    operationId,
  });
  return {
    expected,
    prepared: writePreparation.prepared,
    operation: writePreparation.operation,
    desiredLabel: writePreparation.desiredLabel,
    canonicalValues,
    branch: derivedBranch,
    ref: `refs/heads/${derivedBranch}`,
  };
}

export function prepareCoordinationClaim({
  repository,
  issueNumber,
  expectedBase,
  expectedBody,
  values,
  checkpointComment,
  operationId,
}) {
  if (repository !== CANONICAL_REPOSITORY) {
    throw new CoordinationClaimError(
      'repository-mismatch',
      `claims are supported only for ${CANONICAL_REPOSITORY}`,
    );
  }
  positiveIssueNumber(issueNumber);
  fullCommit(expectedBase);
  const claim = preparedClaim({
    issueNumber,
    expectedBody,
    values,
    checkpointComment,
    operationId,
  });
  if (claim.prepared.fields['Checkpoint-Commit'] !== expectedBase) {
    throw new CoordinationClaimError(
      'checkpoint-base-mismatch',
      'the initial checkpoint commit must equal the expected remote main base',
    );
  }
  return { repository, issueNumber, expectedBase, expectedBody, operationId, ...claim };
}

async function verifyRepositoryAndBase(claimHost, repository, expectedBase) {
  const current = await claimHost.readRepository();
  if (current?.nameWithOwner !== repository || current?.defaultBranch !== 'main') {
    throw new CoordinationClaimError(
      'current-repository-mismatch',
      'current GitHub repository and default branch must be the canonical repository main branch',
      { observed: current },
    );
  }
  const main = await claimHost.readMainRef();
  if (main?.ref !== 'refs/heads/main' || main?.object?.type !== 'commit') {
    throw new CoordinationClaimError('invalid-main-ref', 'remote main returned malformed evidence');
  }
  if (main.object.sha !== expectedBase) {
    throw new CoordinationClaimError('stale-base', 'expected base is not current remote main', {
      expected: expectedBase,
      observed: main.object.sha,
    });
  }
}

function scopeBodyHash(body) {
  return createHash('sha256').update(body).digest('hex');
}

async function requireScopeGuard(
  scopeGuard,
  claim,
  phase,
  transition,
  expectedIssueBody,
  { refCreatedByOperation = false } = {},
) {
  if (typeof scopeGuard !== 'function') {
    throw new CoordinationClaimError(
      'scope-guard-required',
      'post-activation claim execution requires the production scope guard',
    );
  }
  const requested = `claim:${claim.issueNumber}`;
  const binding = {
    target: requested,
    phase,
    transition,
    operationId: claim.operationId,
    issueNumber: claim.issueNumber,
    branch: claim.branch,
    ref: claim.ref,
    expectedBase: claim.expectedBase,
    sourceIssueBodySha256: scopeBodyHash(claim.expectedBody),
    expectedIssueBodySha256: scopeBodyHash(expectedIssueBody),
    preparedIssueBodySha256: scopeBodyHash(claim.prepared.body),
    claimHarness: claim.prepared.fields['Claim-Harness'],
    claimRunId: claim.prepared.fields['Claim-Run-ID'],
    claimAgent: claim.prepared.fields['Claim-Agent'],
    claimHost: claim.prepared.fields['Claim-Host'],
    claimedAt: claim.prepared.fields['Claimed-At'],
  };
  const scopeGate = await scopeGuard({
    ...binding,
    requested,
    sourceIssueBody: claim.expectedBody,
    expectedIssueBody,
    preparedIssueBody: claim.prepared.body,
    expectedOperationComment: claim.operation.comment,
    expectedOperationCommentSha256: scopeBodyHash(claim.operation.comment),
    expectedSourceStateLabel: `work:${claim.expected.fields['Claim-State']}`,
    desiredStateLabel: claim.desiredLabel,
    refCreatedByOperation,
  });
  try {
    assertFreshScopeGate(scopeGate, requested, binding);
  } catch {
    throw new CoordinationClaimError(
      'scope-gate-not-clear',
      `fresh ${phase} scope gate ${requested} is not clear and exactly bound to this operation`,
      { scopeGate },
    );
  }
  return scopeGate;
}

function createScopeAuthority(buildReport) {
  return async ({
    phase,
    transition,
    requested,
    operationId,
    issueNumber,
    branch,
    ref,
    expectedBase,
    sourceIssueBody,
    sourceIssueBodySha256,
    expectedIssueBody,
    expectedIssueBodySha256,
    preparedIssueBody,
    preparedIssueBodySha256,
    expectedOperationComment,
    expectedOperationCommentSha256,
    expectedSourceStateLabel,
    desiredStateLabel,
    claimHarness,
    claimRunId,
    claimAgent,
    claimHost,
    claimedAt,
    refCreatedByOperation,
  }) => {
    // Issue #44 established its claim under the previously integrated protocol. Its own proposed
    // controls can never retroactively qualify or activate that claim.
    if (issueNumber === 44) {
      throw new CoordinationClaimError(
        'scope-self-activation-forbidden',
        'issue #44 remains governed by the claim implementation already integrated on its current main',
      );
    }
    const report = buildReport(requested, {
      provisionalClaim: {
        phase,
        transition,
        operationId,
        issueNumber,
        branch,
        ref,
        expectedBase,
        sourceIssueBody,
        sourceIssueBodySha256,
        expectedIssueBody,
        expectedIssueBodySha256,
        preparedIssueBody,
        preparedIssueBodySha256,
        expectedOperationComment,
        expectedOperationCommentSha256,
        expectedSourceStateLabel,
        desiredStateLabel,
        claimHarness,
        claimRunId,
        claimAgent,
        claimHost,
        claimedAt,
        refCreatedByOperation: refCreatedByOperation === true,
      },
    });
    return {
      ...report.scopeGate,
      evidence: {
        version: 1,
        evidenceId: randomUUID(),
        issuedAt: new Date().toISOString(),
        target: requested,
        phase,
        transition,
        operationId,
        issueNumber,
        branch,
        ref,
        expectedBase,
        sourceIssueBodySha256,
        expectedIssueBodySha256,
        preparedIssueBodySha256,
        claimHarness,
        claimRunId,
        claimAgent,
        claimHost,
        claimedAt,
      },
    };
  };
}

function createProductionScopeAuthority() {
  return createScopeAuthority(buildCoordinationStatusReport);
}

function result(status, stage, detail = {}) {
  return {
    status,
    stage,
    refMutations: 0,
    writerMutations: { body: 0, label: 0, comment: 0 },
    ...detail,
  };
}

function hasExactOperationMarker(body, marker) {
  return typeof body === 'string' && body.split(/\r?\n/).some((line) => line.trimEnd() === marker);
}

function writerPartial(stage, error, mutations, detail = {}) {
  return {
    status: 'partial',
    stage,
    recoverable: true,
    mutations,
    error: error instanceof Error ? error.message : String(error),
    ...detail,
  };
}

async function executeClaimEstablishmentWrite({ host, claim, claimSnapshotGuard }) {
  assertWriterHost(host);
  const { issueNumber, expectedBody, prepared, operation, desiredLabel } = claim;
  const marker = `Coordination-Write-ID: ${claim.operationId}`;
  const proposedComment = operation.comment;
  const mutations = { body: 0, label: 0, comment: 0 };
  let issue = await host.readIssue(issueNumber);
  if (
    !issue ||
    typeof issue.body !== 'string' ||
    !Array.isArray(issue.labels) ||
    !Array.isArray(issue.comments)
  ) {
    throw new CoordinationClaimError(
      'invalid-writer-host-read',
      'writer host returned an invalid issue snapshot',
    );
  }

  const guard = claimSnapshotGuard({
    issue,
    expectedBody,
    prepared,
    desiredLabel,
    marker,
    proposedComment,
  });
  if (!guard?.valid) {
    return {
      status: guard?.status ?? 'collision',
      stage: 'claim-snapshot-guard',
      recoverable: false,
      mutations,
      message:
        guard?.message ??
        'post-reference claim evidence is unsafe; preserve the ref for reconciliation',
      guard,
    };
  }

  if (issue.body !== expectedBody && issue.body !== prepared.body) {
    return {
      status: 'collision',
      stage: 'pre-write',
      recoverable: false,
      mutations,
      message: 'the host body changed after the caller snapshot; no mutation was attempted',
    };
  }

  const initialOperationComments = issue.comments.filter((comment) =>
    hasExactOperationMarker(comment.body, marker),
  );
  if (
    initialOperationComments.length > 1 ||
    (initialOperationComments.length === 1 && initialOperationComments[0].body !== proposedComment)
  ) {
    return {
      status: 'collision',
      stage: 'pre-write-comment',
      recoverable: false,
      mutations,
      message: 'the operation marker already identifies different or duplicate evidence',
    };
  }

  if (issue.body !== prepared.body) {
    try {
      mutations.body += 1;
      await host.updateBody(issueNumber, prepared.body);
      issue = await host.readIssue(issueNumber);
    } catch (error) {
      return writerPartial('body', error, mutations, { bodyMayHaveChanged: true });
    }
    if (issue.body !== prepared.body) {
      return writerPartial(
        'body-verification',
        'host body does not equal the validated proposed body',
        mutations,
        { bodyMayHaveChanged: true },
      );
    }
  }

  const currentStateLabels = issueStateLabels(issue.labels);
  if (currentStateLabels.length !== 1 || currentStateLabels[0] !== desiredLabel) {
    try {
      mutations.label += 1;
      await host.replaceStateLabel(issueNumber, desiredLabel);
      issue = await host.readIssue(issueNumber);
    } catch (error) {
      return writerPartial('label', error, mutations, { bodyWritten: true });
    }
    const verifiedLabels = issueStateLabels(issue.labels);
    if (verifiedLabels.length !== 1 || verifiedLabels[0] !== desiredLabel) {
      return writerPartial(
        'label-verification',
        'host state label does not match the proposed body',
        mutations,
        { bodyWritten: true },
      );
    }
  }

  const existing = issue.comments.filter((comment) =>
    hasExactOperationMarker(comment.body, marker),
  );
  if (existing.length > 1 || (existing.length === 1 && existing[0].body !== proposedComment)) {
    return {
      status: 'collision',
      stage: 'comment-collision',
      recoverable: false,
      mutations,
      message: 'the operation marker became duplicated or attached to different evidence',
      bodyWritten: true,
      labelWritten: true,
    };
  }
  if (existing.length === 0) {
    try {
      mutations.comment += 1;
      await host.addComment(issueNumber, proposedComment);
      issue = await host.readIssue(issueNumber);
    } catch (error) {
      return writerPartial('comment', error, mutations, {
        bodyWritten: true,
        labelWritten: true,
        commentMayHaveChanged: true,
      });
    }
  }

  const finalLabels = issueStateLabels(issue.labels);
  const finalComments = issue.comments.filter((comment) =>
    hasExactOperationMarker(comment.body, marker),
  );
  const finalVerification = {
    body: issue.body === prepared.body,
    label: finalLabels.length === 1 && finalLabels[0] === desiredLabel,
    comment: finalComments.length === 1 && finalComments[0].body === proposedComment,
  };
  if (!finalVerification.body) {
    return {
      status: 'collision',
      stage: 'final-verification',
      recoverable: false,
      mutations,
      finalVerification,
      message: 'the issue body drifted before one coherent final snapshot could be verified',
    };
  }
  if (!finalVerification.label || !finalVerification.comment) {
    return writerPartial(
      'final-verification',
      'label or comment drifted before one coherent final snapshot could be verified',
      mutations,
      { bodyWritten: true, finalVerification, commentMayHaveChanged: !finalVerification.comment },
    );
  }

  return {
    status: 'complete',
    stage: 'complete',
    recoverable: false,
    mutations,
    migrated: prepared.migrated,
    body: prepared.body,
    comment: proposedComment,
    desiredLabel,
    finalVerification,
  };
}

async function executeCoordinationClaimWithDependencies({
  claimHost,
  writerHost,
  repository,
  issueNumber,
  expectedBase,
  expectedBody,
  values,
  checkpointComment,
  operationId,
  scopeGuard,
}) {
  assertClaimHost(claimHost);
  assertWriterHost(writerHost);
  const claim = prepareCoordinationClaim({
    repository,
    issueNumber,
    expectedBase,
    expectedBody,
    values,
    checkpointComment,
    operationId,
  });
  if (typeof scopeGuard !== 'function') {
    throw new CoordinationClaimError(
      'scope-guard-required',
      'post-activation claim execution requires the production scope guard',
    );
  }
  await verifyRepositoryAndBase(claimHost, repository, expectedBase);

  const issue = await writerHost.readIssue(issueNumber);
  if (
    !issue ||
    !['open', 'closed'].includes(issue.state) ||
    typeof issue.body !== 'string' ||
    !Array.isArray(issue.labels) ||
    !Array.isArray(issue.comments)
  ) {
    throw new CoordinationClaimError(
      'invalid-issue-read',
      'writer host returned malformed issue evidence',
    );
  }
  const present = await claimHost.readClaimRef(claim.ref);
  if (present) {
    normalizeRef(present, claim.ref, expectedBase);
    if (issue.body === expectedBody) {
      return result('orphaned', 'ref-present-parked-body', {
        message:
          'the deterministic ref already exists while the issue remains parked; preserve it as an orphan and perform zero issue mutation',
      });
    }
    if (issue.body !== claim.prepared.body) {
      return result('collision', 'ref-present-body-collision', {
        message: 'the ref and issue body do not identify one prepared claim',
      });
    }
    const snapshotInspection = claimSnapshotGuard(claim, operationId)({ issue });
    if (!snapshotInspection.valid) {
      return result(
        snapshotInspection.status,
        snapshotInspection.code === 'post-ref-operation-mismatch'
          ? 'ref-present-operation-mismatch'
          : 'post-ref-snapshot-guard',
        {
          message: snapshotInspection.message,
          guard: snapshotInspection,
          observedOperations: snapshotInspection.observedOperations,
        },
      );
    }
    if (snapshotInspection.coherent) {
      return result('existing', 'existing-coherent-claim', {
        message:
          'the exact complete claim already exists; continue only after normal reconciliation',
      });
    }
    try {
      await requireScopeGuard(
        scopeGuard,
        claim,
        'after-ref',
        'writer-recovery',
        claim.prepared.body,
      );
    } catch (error) {
      return result('blocked', 'writer-recovery-scope-guard', {
        message: error.message,
        guard: error.details?.scopeGate,
      });
    }
    const write = await executeClaimEstablishmentWrite({
      host: writerHost,
      claim,
      claimSnapshotGuard: claimSnapshotGuard(claim, operationId, { stopOnCoherent: true }),
    });
    if (write.status === 'complete') {
      try {
        await requireScopeGuard(
          scopeGuard,
          claim,
          'after-write',
          'after-write',
          claim.prepared.body,
        );
      } catch (error) {
        return {
          ...result('blocked', 'post-write-scope-reconciliation'),
          writerMutations: write.mutations,
          message: error.message,
          guard: error.details?.scopeGate,
          writer: write,
        };
      }
    }
    return {
      ...result(
        write.status,
        write.guard?.code === 'existing-coherent-claim'
          ? 'existing-coherent-claim'
          : write.stage === 'claim-snapshot-guard'
            ? 'post-ref-snapshot-guard'
            : 'writer-recovery',
      ),
      writerMutations: write.mutations,
      message: write.message,
      guard: write.guard,
      writer: write,
    };
  }

  if (issue.body === claim.prepared.body) {
    return result('contradiction', 'claim-present-ref-absent', {
      message: 'an agent-owned prepared body has no matching ref; never create it retroactively',
    });
  }
  if (issue.body !== expectedBody) {
    return result('collision', 'pre-create-body-collision', {
      message: 'the issue body changed before ref creation',
    });
  }

  // These are the final repository/base and complete issue-evidence gates immediately before the
  // sole mutation. A closed issue, body/label drift, or ambiguous ownership history creates no ref.
  await verifyRepositoryAndBase(claimHost, repository, expectedBase);
  const finalIssue = await writerHost.readIssue(issueNumber);
  const finalInspection = inspectIssueBeforeCreate(finalIssue, claim);
  if (!finalInspection.valid) {
    return result('collision', finalInspection.code, { message: finalInspection.message });
  }
  await requireScopeGuard(scopeGuard, claim, 'before-ref', 'before-ref', expectedBody);
  let created;
  try {
    created = await claimHost.createClaimRef({ ref: claim.ref, sha: expectedBase });
  } catch (error) {
    if (error?.statusCode === 422) {
      const after422 = await claimHost.readClaimRef(claim.ref);
      return result(after422 ? 'lost-race' : 'failed', 'create-422', {
        message: after422
          ? 'another contender created the deterministic ref; mutate no issue surface'
          : 'GitHub rejected ref creation while the exact ref remained absent',
      });
    }
    const observed = await claimHost.readClaimRef(claim.ref).catch(() => null);
    return result('ambiguous', 'create-ambiguous', {
      message:
        'claim-ref creation did not return a qualifying response; never adopt observed state',
      refObserved: Boolean(observed),
    });
  }

  if (created?.statusCode !== 201) {
    return result('ambiguous', 'create-status', {
      refMutations: 1,
      message: 'claim-ref creation did not return HTTP 201',
    });
  }
  try {
    normalizeRef(created.body, claim.ref, expectedBase);
    normalizeRef(await claimHost.readClaimRef(claim.ref), claim.ref, expectedBase);
  } catch (error) {
    return result('ambiguous', 'create-verification', {
      refMutations: 1,
      message: error.message,
    });
  }

  try {
    await requireScopeGuard(scopeGuard, claim, 'after-ref', 'ref-created-parked', expectedBody, {
      refCreatedByOperation: true,
    });
  } catch (error) {
    return result('blocked', 'post-ref-scope-guard', {
      refMutations: 1,
      message: error.message,
      guard: error.details?.scopeGate,
    });
  }

  const write = await executeClaimEstablishmentWrite({
    host: writerHost,
    claim,
    claimSnapshotGuard: claimSnapshotGuard(claim, operationId, { stopOnCoherent: true }),
  });
  if (write.status === 'complete') {
    try {
      await requireScopeGuard(scopeGuard, claim, 'after-write', 'after-write', claim.prepared.body);
    } catch (error) {
      return {
        ...result('blocked', 'post-write-scope-reconciliation', { refMutations: 1 }),
        writerMutations: write.mutations,
        message: error.message,
        guard: error.details?.scopeGate,
        writer: write,
      };
    }
  }
  return {
    status: write.status,
    stage:
      write.guard?.code === 'existing-coherent-claim'
        ? 'existing-coherent-claim'
        : write.stage === 'claim-snapshot-guard'
          ? 'post-ref-snapshot-guard'
          : write.status === 'complete'
            ? 'complete'
            : 'writer-partial',
    refMutations: 1,
    writerMutations: write.mutations,
    message: write.message,
    guard: write.guard,
    writer: write,
  };
}

const PRODUCTION_CLAIM_FIELDS = new Set([
  'repository',
  'issueNumber',
  'expectedBase',
  'expectedBody',
  'values',
  'checkpointComment',
  'operationId',
]);

function rejectProductionDependencyInjection(options, allowed, boundary) {
  const injected = Object.keys(options ?? {}).filter((key) => !allowed.has(key));
  if (injected.length > 0) {
    throw new CoordinationClaimError(
      'production-dependency-injection-forbidden',
      `${boundary} does not accept caller-selected dependencies: ${injected.join(', ')}`,
    );
  }
}

export async function executeCoordinationClaim(options) {
  rejectProductionDependencyInjection(options, PRODUCTION_CLAIM_FIELDS, 'executeCoordinationClaim');
  const host = createGitHubClaimHost({ repository: options.repository });
  return executeCoordinationClaimWithDependencies({
    ...options,
    claimHost: host,
    writerHost: host,
    scopeGuard: createProductionScopeAuthority(),
  });
}

function parseJson(text, context) {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new CoordinationClaimError('invalid-adapter-output', `${context}: ${error.message}`);
  }
}

async function runClaimGitHubCli(args, input) {
  return await new Promise((resolve, reject) => {
    const child = spawn('gh', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout, stderr }));
    child.stdin.end(input);
  });
}

function parseIncludedResponse(output) {
  const match = output.match(/^HTTP\/\S+\s+(\d{3})[^\n]*\r?\n[\s\S]*?\r?\n\r?\n([\s\S]*)$/);
  if (!match)
    throw new CoordinationClaimError('invalid-adapter-output', 'missing HTTP response metadata');
  return { statusCode: Number(match[1]), body: parseJson(match[2], 'claim-ref create response') };
}

function createGitHubClaimHost({
  repository = CANONICAL_REPOSITORY,
  runGh = runClaimGitHubCli,
} = {}) {
  if (repository !== CANONICAL_REPOSITORY) {
    throw new CoordinationClaimError(
      'repository-mismatch',
      'claim host repository is not canonical',
    );
  }
  const root = `repos/${repository}`;
  async function request(args, input, context, { absent404 = false } = {}) {
    const response = await runGh(args, input);
    if (response.status !== 0) {
      if (absent404 && /HTTP 404|Not Found/i.test(response.stderr)) return null;
      const error = new CoordinationClaimError(
        'github-request-failed',
        `${context}: ${response.stderr.trim()}`,
      );
      error.statusCode = /HTTP 422|Validation Failed/i.test(response.stderr) ? 422 : undefined;
      throw error;
    }
    return parseJson(response.stdout, context);
  }
  async function readRef(path, absent404 = false) {
    return request(['api', `${root}/git/ref/${path}`], undefined, `read ${path}`, { absent404 });
  }
  async function readRawIssue(issueNumber) {
    return request(['api', `${root}/issues/${issueNumber}`], undefined, 'issue read');
  }
  return {
    async readRepository() {
      const record = await request(
        ['repo', 'view', '--json', 'nameWithOwner,defaultBranchRef'],
        undefined,
        'current repository',
      );
      return {
        nameWithOwner: record.nameWithOwner,
        defaultBranch: record.defaultBranchRef?.name,
      };
    },
    async readMainRef() {
      return readRef('heads/main');
    },
    async readClaimRef(ref) {
      return readRef(ref.replace(/^refs\//, ''), true);
    },
    async createClaimRef({ ref, sha }) {
      const response = await runGh(
        ['api', '--include', '--method', 'POST', `${root}/git/refs`, '--input', '-'],
        JSON.stringify({ ref, sha }),
      );
      if (response.status !== 0) {
        const error = new CoordinationClaimError(
          'github-request-failed',
          `create claim ref: ${response.stderr.trim()}`,
        );
        error.statusCode = /HTTP 422|Validation Failed/i.test(response.stderr) ? 422 : undefined;
        throw error;
      }
      return parseIncludedResponse(response.stdout);
    },
    async readIssue(issueNumber) {
      const before = await readRawIssue(issueNumber);
      const pages = await request(
        ['api', '--paginate', '--slurp', `${root}/issues/${issueNumber}/comments`],
        undefined,
        'comment read',
      );
      const after = await readRawIssue(issueNumber);
      if (!Array.isArray(pages) || pages.some((page) => !Array.isArray(page))) {
        throw new CoordinationClaimError(
          'invalid-adapter-output',
          'paginated comment read must return an array of pages',
        );
      }
      const labels = (issue) =>
        Array.isArray(issue.labels)
          ? issue.labels.map((label) => (typeof label === 'string' ? label : label.name)).sort()
          : issue.labels;
      if (
        before.state !== after.state ||
        before.body !== after.body ||
        JSON.stringify(labels(before)) !== JSON.stringify(labels(after))
      ) {
        throw new CoordinationClaimError(
          'unstable-host-read',
          'issue state, body, or label evidence drifted while comments were being read',
        );
      }
      return {
        state: after.state,
        body: after.body,
        labels: labels(after),
        comments: pages.flat().map((comment) => ({
          id: comment.id,
          author: comment.user?.login,
          body: comment.body,
          createdAt: comment.created_at,
          updatedAt: comment.updated_at,
        })),
      };
    },
    async updateBody(issueNumber, body) {
      await request(
        ['api', '--method', 'PATCH', `${root}/issues/${issueNumber}`, '--input', '-'],
        JSON.stringify({ body }),
        'body update',
      );
    },
    async replaceStateLabel(issueNumber, desiredLabel) {
      const issue = await readRawIssue(issueNumber);
      const labels = issue.labels.map((label) => (typeof label === 'string' ? label : label.name));
      const nextLabels = [...labels.filter((label) => !STATE_LABELS.has(label)), desiredLabel];
      await request(
        ['api', '--method', 'PATCH', `${root}/issues/${issueNumber}`, '--input', '-'],
        JSON.stringify({ labels: nextLabels }),
        'label update',
      );
    },
    async addComment(issueNumber, body) {
      await request(
        ['api', '--method', 'POST', `${root}/issues/${issueNumber}/comments`, '--input', '-'],
        JSON.stringify({ body }),
        'comment append',
      );
    },
  };
}

function parseCliArguments(argv) {
  const options = {};
  const values = new Set([
    '--repo',
    '--issue',
    '--expected-base',
    '--expected-body-file',
    '--values-file',
    '--comment-file',
    '--operation-id',
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--dry-run' || argument === '--apply') {
      if (options[argument]) throw new CoordinationClaimError('duplicate-option', argument);
      options[argument] = true;
      continue;
    }
    if (!values.has(argument) || options[argument] !== undefined || argv[index + 1] === undefined) {
      throw new CoordinationClaimError('invalid-option', `invalid ${argument}`);
    }
    options[argument] = argv[index + 1];
    index += 1;
  }
  if (Boolean(options['--dry-run']) === Boolean(options['--apply'])) {
    throw new CoordinationClaimError('explicit-mode-required', 'invoke exactly one mode');
  }
  for (const required of values) {
    if (!options[required])
      throw new CoordinationClaimError('missing-option', `${required} is required`);
  }
  return {
    mode: options['--apply'] ? 'apply' : 'dry-run',
    repository: options['--repo'],
    issueNumberText: options['--issue'],
    expectedBase: options['--expected-base'],
    expectedBodyFile: options['--expected-body-file'],
    valuesFile: options['--values-file'],
    commentFile: options['--comment-file'],
    operationId: options['--operation-id'],
  };
}

async function runCoordinationClaimCliWithDependencies({
  argv,
  readText,
  runGh,
  scopeGuard,
  writeOutput,
}) {
  for (const [name, dependency] of Object.entries({ readText, runGh, writeOutput })) {
    if (typeof dependency !== 'function') {
      throw new CoordinationClaimError(
        'test-dependency-required',
        `the test-only CLI requires an explicit ${name} dependency`,
      );
    }
  }
  const options = parseCliArguments(argv);
  if (!/^[1-9]\d*$/.test(String(options.issueNumberText))) {
    throw new CoordinationClaimError(
      'invalid-issue-number',
      '--issue must be canonical positive ASCII base-10',
    );
  }
  options.issueNumber = Number(options.issueNumberText);
  positiveIssueNumber(options.issueNumber);
  const [expectedBody, valuesText, checkpointComment] = await Promise.all([
    readText(options.expectedBodyFile),
    readText(options.valuesFile),
    readText(options.commentFile),
  ]);
  const values = parseJson(valuesText, 'values file');
  const prepared = prepareCoordinationClaim({
    repository: options.repository,
    issueNumber: options.issueNumber,
    expectedBase: options.expectedBase,
    expectedBody,
    values,
    checkpointComment,
    operationId: options.operationId,
  });
  if (options.mode === 'dry-run') {
    const preview = {
      status: 'dry-run',
      issueNumber: options.issueNumber,
      branch: prepared.branch,
      ref: prepared.ref,
      expectedBase: prepared.expectedBase,
      body: prepared.prepared.body,
    };
    writeOutput(`${JSON.stringify(preview, null, 2)}\n`);
    return preview;
  }
  const host = createGitHubClaimHost({ repository: options.repository, runGh });
  const result = await executeCoordinationClaimWithDependencies({
    claimHost: host,
    writerHost: host,
    repository: options.repository,
    issueNumber: options.issueNumber,
    expectedBase: options.expectedBase,
    expectedBody,
    values,
    checkpointComment,
    operationId: options.operationId,
    scopeGuard,
  });
  writeOutput(`${JSON.stringify(result, null, 2)}\n`);
  return result;
}

const PRODUCTION_CLI_FIELDS = new Set(['argv']);

export async function runCoordinationClaimCli(options) {
  rejectProductionDependencyInjection(options, PRODUCTION_CLI_FIELDS, 'runCoordinationClaimCli');
  return runCoordinationClaimCliWithDependencies({
    argv: options.argv,
    readText: (path) => readFile(path, 'utf8'),
    runGh: runClaimGitHubCli,
    scopeGuard: createProductionScopeAuthority(),
    writeOutput: (text) => process.stdout.write(text),
  });
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  runCoordinationClaimCli({ argv: process.argv.slice(2) })
    .then((result) => {
      if (!['dry-run', 'complete'].includes(result.status)) process.exitCode = 2;
    })
    .catch((error) => {
      console.error(`${error.code ?? 'unexpected-error'}: ${error.message}`);
      process.exitCode = 1;
    });
}
