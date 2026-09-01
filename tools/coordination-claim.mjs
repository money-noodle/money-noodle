#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import {
  V2_PORTABLE_CLAIM_FIELDS,
  structuredRecord,
  validateCheckpointComment,
  validateWorkItemBody,
} from './coordination-schema.mjs';
import {
  createGitHubCliHost,
  executeClaimEstablishmentWrite,
  prepareClaimCoordinationWrite,
  runGitHubCli,
} from './coordination-write.mjs';

export const CANONICAL_REPOSITORY = 'money-noodle/money-noodle';
export const CLAIM_BRANCH_VERSION = 1;
export const BOOTSTRAP_ISSUE = 42;
export const BOOTSTRAP_BRANCH = 'arch/remote-reference-claim-primitive';

const FULL_COMMIT = /^[0-9a-f]{40}$/;
const RESERVED_PREFIX = 'claim-v';
const RESERVED_BRANCH = /^claim-v([1-9]\d*)\/issue-([1-9]\d*)$/;
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

export function claimBranchForIssue(issueNumber) {
  return `claim-v${CLAIM_BRANCH_VERSION}/issue-${positiveIssueNumber(issueNumber)}`;
}

export function claimRefForIssue(issueNumber) {
  return `refs/heads/${claimBranchForIssue(issueNumber)}`;
}

export function parseReservedClaimBranch(branch) {
  if (typeof branch !== 'string' || !branch.startsWith(RESERVED_PREFIX)) {
    return { status: 'not-reserved' };
  }
  const match = branch.match(RESERVED_BRANCH);
  if (!match) return { status: 'malformed', branch };
  const version = Number(match[1]);
  const issueNumber = Number(match[2]);
  if (!Number.isSafeInteger(version) || !Number.isSafeInteger(issueNumber)) {
    return { status: 'malformed', branch };
  }
  if (version !== CLAIM_BRANCH_VERSION) {
    return { status: 'unsupported', branch, version, issueNumber };
  }
  return {
    status: 'supported',
    branch,
    version,
    issueNumber,
    ref: `refs/heads/${branch}`,
  };
}

export function parseReservedClaimRef(ref) {
  if (typeof ref !== 'string' || !ref.startsWith('refs/heads/')) {
    return { status: 'malformed', ref };
  }
  return { ...parseReservedClaimBranch(ref.slice('refs/heads/'.length)), ref };
}

export function validateClaimBranch({ issueNumber, claimState, branch }) {
  positiveIssueNumber(issueNumber);
  if (!['active', 'review'].includes(claimState)) return { status: 'not-agent-owned' };
  if (issueNumber === BOOTSTRAP_ISSUE && branch === BOOTSTRAP_BRANCH) {
    return { status: 'bootstrap', issueNumber, branch };
  }
  if (branch === BOOTSTRAP_BRANCH) {
    return {
      status: 'invalid',
      code: 'bootstrap-branch-wrong-issue',
      expected: claimBranchForIssue(issueNumber),
    };
  }
  const parsed = parseReservedClaimBranch(branch);
  if (parsed.status !== 'supported') {
    return {
      status: 'invalid',
      code:
        parsed.status === 'unsupported'
          ? 'unsupported-claim-branch-version'
          : 'non-derived-agent-claim-branch',
      expected: claimBranchForIssue(issueNumber),
    };
  }
  const expected = claimBranchForIssue(issueNumber);
  if (branch !== expected) {
    return { status: 'invalid', code: 'claim-branch-issue-mismatch', expected };
  }
  return { status: 'derived', issueNumber, branch, ref: `refs/heads/${branch}` };
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

function operationMarkers(comments) {
  return comments.flatMap((comment) =>
    [...(comment.body ?? '').matchAll(/^Coordination-Write-ID:\s*(\S+)\s*$/gm)].map(
      (match) => match[1],
    ),
  );
}

function issueStateLabels(labels) {
  return labels.filter((label) => STATE_LABELS.has(label));
}

function conflictingOwnershipComments(comments, prepared) {
  const identityFields = V2_PORTABLE_CLAIM_FIELDS.filter(
    (field) => !['Claim-State', 'Check-In-By', 'Waiting-Since'].includes(field),
  );
  return comments.filter((comment) => {
    const fields = structuredRecord(comment.body ?? '', V2_PORTABLE_CLAIM_FIELDS).fields;
    if (!['active', 'review'].includes(fields['Claim-State'])) return false;
    return identityFields.some(
      (field) =>
        fields[field] !== undefined &&
        fields[field] !== 'unclaimed' &&
        fields[field] !== prepared.fields[field],
    );
  });
}

function preparedClaim({ issueNumber, expectedBody, values }) {
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
  const prepared = prepareClaimCoordinationWrite({
    currentBody: expectedBody,
    values: canonicalValues,
  });
  return {
    expected,
    prepared,
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
}) {
  if (repository !== CANONICAL_REPOSITORY) {
    throw new CoordinationClaimError(
      'repository-mismatch',
      `claims are supported only for ${CANONICAL_REPOSITORY}`,
    );
  }
  positiveIssueNumber(issueNumber);
  fullCommit(expectedBase);
  const claim = preparedClaim({ issueNumber, expectedBody, values });
  if (claim.prepared.fields['Checkpoint-Commit'] !== expectedBase) {
    throw new CoordinationClaimError(
      'checkpoint-base-mismatch',
      'the initial checkpoint commit must equal the expected remote main base',
    );
  }
  return { repository, issueNumber, expectedBase, ...claim };
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
  });
  await verifyRepositoryAndBase(claimHost, repository, expectedBase);

  const issue = await writerHost.readIssue(issueNumber);
  if (
    !issue ||
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
    if (conflictingOwnershipComments(issue.comments, claim.prepared).length > 0) {
      return result('collision', 'ref-present-identity-collision', {
        message: 'the prepared claim has conflicting ownership evidence',
      });
    }
    const matchingCheckpoint = issue.comments.some((comment) => {
      const validation = validateCheckpointComment(comment.body ?? '', claim.prepared.validation);
      return validation.applicable && validation.valid;
    });
    const labels = issueStateLabels(issue.labels);
    if (matchingCheckpoint && labels.length === 1 && labels[0] === 'work:active') {
      return result('existing', 'existing-coherent-claim', {
        message:
          'the exact complete claim already exists; continue only after normal reconciliation',
      });
    }
    const markers = operationMarkers(issue.comments);
    if (markers.some((marker) => marker !== operationId)) {
      return result('collision', 'ref-present-operation-collision', {
        message: 'the prepared claim has conflicting operation evidence',
      });
    }
    const write = await executeClaimEstablishmentWrite({
      host: writerHost,
      issueNumber,
      expectedBody,
      values: claim.canonicalValues,
      checkpointComment,
      operationId,
    });
    return {
      ...result(write.status, 'writer-recovery'),
      writerMutations: write.mutations,
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

  // This second read is the final current-repository/base gate immediately before the sole mutation.
  await verifyRepositoryAndBase(claimHost, repository, expectedBase);
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
  });
  return {
    status: write.status,
    stage: write.status === 'complete' ? 'complete' : 'writer-partial',
    refMutations: 1,
    writerMutations: write.mutations,
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
