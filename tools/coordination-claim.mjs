#!/usr/bin/env node

import { spawn } from 'node:child_process';
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
import {
  createGitHubCliHost,
  executeClaimEstablishmentWrite,
  prepareClaimEstablishmentWrite,
  runGitHubCli,
} from './coordination-write.mjs';

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
    !coherent &&
    matchingCheckpoints.length > 0 &&
    matchingCheckpoints.some(({ operationId: id }) => id !== operationId)
  ) {
    return unsafe(
      'post-ref-operation-mismatch',
      `every matching checkpoint on an incomplete claim must carry operation ${operationId}; observed ${observedOperations.join(', ')}, so recovery may not mutate or append duplicate checkpoint evidence`,
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
  return { repository, issueNumber, expectedBase, expectedBody, ...claim };
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

function result(status, stage, detail = {}) {
  return {
    status,
    stage,
    refMutations: 0,
    writerMutations: { body: 0, label: 0, comment: 0 },
    ...detail,
  };
}

export async function executeCoordinationClaim({
  claimHost,
  writerHost,
  repository,
  issueNumber,
  expectedBase,
  expectedBody,
  values,
  checkpointComment,
  operationId,
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
        message: 'the deterministic ref exists while the issue remains parked; do not adopt it',
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
    const write = await executeClaimEstablishmentWrite({
      host: writerHost,
      issueNumber,
      expectedBody,
      values: claim.canonicalValues,
      checkpointComment,
      operationId,
      claimSnapshotGuard: claimSnapshotGuard(claim, operationId, { stopOnCoherent: true }),
    });
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

  const write = await executeClaimEstablishmentWrite({
    host: writerHost,
    issueNumber,
    expectedBody,
    values: claim.canonicalValues,
    checkpointComment,
    operationId,
    claimSnapshotGuard: claimSnapshotGuard(claim, operationId, { stopOnCoherent: true }),
  });
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

function parseJson(text, context) {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new CoordinationClaimError('invalid-adapter-output', `${context}: ${error.message}`);
  }
}

export async function runClaimGitHubCli(args, input) {
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

export function createGitHubClaimHost({
  repository = CANONICAL_REPOSITORY,
  runGh = runClaimGitHubCli,
}) {
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

export async function runCoordinationClaimCli({
  argv,
  readText = (path) => readFile(path, 'utf8'),
  claimRunGh = runClaimGitHubCli,
  writerRunGh = runGitHubCli,
  writeOutput = (text) => process.stdout.write(text),
}) {
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
  const result = await executeCoordinationClaim({
    claimHost: createGitHubClaimHost({ repository: options.repository, runGh: claimRunGh }),
    writerHost: createGitHubCliHost({ repository: options.repository, runGh: writerRunGh }),
    repository: options.repository,
    issueNumber: options.issueNumber,
    expectedBase: options.expectedBase,
    expectedBody,
    values,
    checkpointComment,
    operationId: options.operationId,
  });
  writeOutput(`${JSON.stringify(result, null, 2)}\n`);
  return result;
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
