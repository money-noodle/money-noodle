#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import {
  ALL_KNOWN_FIELDS,
  CURRENT_REGISTRY_SCHEMA_VERSION,
  REGISTRY_SCHEMA_VERSION_FIELD,
  V2_PLAN_FIELDS,
  V2_WORK_ITEM_FIELDS,
  normalizeScopePaths,
  registryVersion,
  structuredRecord,
  validateCheckpointComment,
  validatePlanBody,
  validatePlanComment,
  validateWorkItemBody,
} from './coordination-schema.mjs';

const V2_ONLY_FIELDS = new Set(['Scope-Paths', 'Claim-Host', 'Waiting-Since', 'Dependency-Notes']);
const STATE_LABELS = new Set([
  'work:proposed',
  'work:ready',
  'work:active',
  'work:blocked',
  'work:review',
  'work:done',
  'work:abandoned',
]);

export class CoordinationWriteError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'CoordinationWriteError';
    this.code = code;
    this.details = details;
  }
}

function oneLine(value, field) {
  if (typeof value !== 'string') {
    throw new CoordinationWriteError('invalid-field-value', `${field} must be a string`, { field });
  }
  const normalized = value.replaceAll(/\s+/g, ' ').trim();
  if (!normalized) {
    throw new CoordinationWriteError('invalid-field-value', `${field} must not be empty`, {
      field,
    });
  }
  return normalized;
}

function canonicalValue(field, value) {
  if (field === 'Scope-Paths') {
    const scope = normalizeScopePaths(value);
    if (scope.status === 'invalid') {
      throw new CoordinationWriteError('invalid-scope-paths', 'Scope-Paths is malformed', {
        field,
      });
    }
    return scope.status === 'none' ? 'none' : scope.paths.join(', ');
  }
  return oneLine(value, field);
}

function stripCanonicalSection(body) {
  return body.replace(/^## Registry record\s*$\n[\s\S]*?(?=^##\s+|(?![\s\S]))/gm, '');
}

function stripKnownFields(body, record) {
  const ranges = Object.values(record.occurrences)
    .flat()
    .sort((left, right) => right.start - left.start);
  let result = body;
  let previousStart = Number.POSITIVE_INFINITY;
  for (const range of ranges) {
    if (range.end > previousStart) continue;
    result = `${result.slice(0, range.start)}${result.slice(range.end)}`;
    previousStart = range.start;
  }
  return result.replaceAll(/\n{4,}/g, '\n\n\n').trimEnd();
}

function validatePrepared(kind, body) {
  return kind === 'plan' ? validatePlanBody(body) : validateWorkItemBody(body);
}

function prepareCoordinationWriteInternal({ currentBody, values, kind = 'work-item' }, authority) {
  if (typeof currentBody !== 'string') {
    throw new CoordinationWriteError('invalid-current-body', 'current body must be a string');
  }
  if (!values || typeof values !== 'object' || Array.isArray(values)) {
    throw new CoordinationWriteError(
      'invalid-values',
      'values must be a complete field-value object',
    );
  }
  if (!['work-item', 'plan'].includes(kind)) {
    throw new CoordinationWriteError('invalid-kind', 'kind must be work-item or plan');
  }

  const version = registryVersion(currentBody);
  if (version.status === 'unsupported') {
    throw new CoordinationWriteError('unsupported-schema-version', version.errors[0].message, {
      version: version.version,
    });
  }
  if (version.status === 'invalid') {
    throw new CoordinationWriteError('invalid-schema-version', version.errors[0].message);
  }

  const source = structuredRecord(currentBody, ALL_KNOWN_FIELDS);
  if (source.duplicates.length > 0) {
    throw new CoordinationWriteError(
      'field-collision',
      'current body contains duplicate structured fields',
      {
        fields: source.duplicates,
      },
    );
  }
  if (
    !version.explicit &&
    [...V2_ONLY_FIELDS].some((field) => source.fields[field] !== undefined)
  ) {
    throw new CoordinationWriteError(
      'migration-collision',
      'implicit version 1 body contains version 2-only fields and cannot be reinterpreted automatically',
      { fields: [...V2_ONLY_FIELDS].filter((field) => source.fields[field] !== undefined) },
    );
  }

  const orderedFields = kind === 'plan' ? V2_PLAN_FIELDS : V2_WORK_ITEM_FIELDS;
  const merged = {
    ...source.fields,
    ...values,
    [REGISTRY_SCHEMA_VERSION_FIELD]: CURRENT_REGISTRY_SCHEMA_VERSION,
  };
  const canonical = {};
  for (const field of orderedFields) {
    if (merged[field] === undefined) {
      throw new CoordinationWriteError(
        'incomplete-proposed-record',
        `${field} is required before writing`,
        {
          field,
        },
      );
    }
    canonical[field] = canonicalValue(field, merged[field]);
  }

  const withoutCanonical = stripCanonicalSection(currentBody);
  const stripped = stripKnownFields(
    withoutCanonical,
    structuredRecord(withoutCanonical, ALL_KNOWN_FIELDS),
  );
  const fieldBlock = orderedFields.map((field) => `${field}: ${canonical[field]}`).join('\n');
  const body = `${stripped}\n\n## Registry record\n\n${fieldBlock}\n`;
  const validation = validatePrepared(kind, body);
  if (!validation.valid) {
    throw new CoordinationWriteError(
      'invalid-proposed-record',
      `complete proposed ${kind} record failed semantic validation`,
      { errors: validation.errors },
    );
  }

  const prepared = {
    kind,
    body,
    fields: canonical,
    validation,
    migrated: version.version === '1',
    sourceVersion: version.version,
    targetVersion: CURRENT_REGISTRY_SCHEMA_VERSION,
  };
  if (
    isInitialClaimTransition(currentBody, prepared) &&
    authority !== CLAIM_ESTABLISHMENT_AUTHORITY
  ) {
    throw new CoordinationWriteError(
      'initial-claim-requires-reference',
      'parked-to-agent-owned transitions require the dedicated remote-reference claim module',
    );
  }
  return prepared;
}

export function prepareCoordinationWrite(input) {
  return prepareCoordinationWriteInternal(input, undefined);
}

// This preparation entry point is imported only by coordination-claim.mjs.
export function prepareClaimCoordinationWrite(input) {
  return prepareCoordinationWriteInternal(input, CLAIM_ESTABLISHMENT_AUTHORITY);
}

function stateLabels(labels) {
  return labels.filter((label) => STATE_LABELS.has(label));
}

function desiredStateLabel(prepared) {
  if (prepared.kind === 'plan') {
    return `work:${prepared.fields['Plan-State'] === 'complete' ? 'done' : prepared.fields['Plan-State']}`;
  }
  return `work:${prepared.fields['Claim-State']}`;
}

const CLAIM_ESTABLISHMENT_AUTHORITY = Symbol('claim-establishment-authority');
const PARKED_STATES = new Set(['proposed', 'ready']);
const AGENT_OWNED_STATES = new Set(['active', 'review']);

function isInitialClaimTransition(expectedBody, prepared) {
  if (prepared.kind !== 'work-item') return false;
  const currentState = structuredRecord(expectedBody, ['Claim-State']).fields['Claim-State'];
  return PARKED_STATES.has(currentState) && AGENT_OWNED_STATES.has(prepared.fields['Claim-State']);
}

function writeMarker(operationId) {
  if (typeof operationId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(operationId)) {
    throw new CoordinationWriteError(
      'invalid-operation-id',
      'operationId must be a portable opaque identifier',
    );
  }
  return `Coordination-Write-ID: ${operationId}`;
}

function partial(stage, error, mutations, detail = {}) {
  return {
    status: 'partial',
    stage,
    recoverable: true,
    mutations,
    error: error instanceof Error ? error.message : String(error),
    ...detail,
  };
}

function prepareOperationComment(prepared, checkpointComment, operationId) {
  const marker = writeMarker(operationId);
  if (typeof checkpointComment !== 'string' || checkpointComment.trim() === '') {
    throw new CoordinationWriteError(
      'missing-checkpoint-comment',
      'a complete append-only checkpoint comment is required',
    );
  }
  if (checkpointComment.includes('Coordination-Write-ID:')) {
    throw new CoordinationWriteError(
      'reserved-comment-field',
      'the writer owns Coordination-Write-ID',
    );
  }
  const comment = `${marker}\n${checkpointComment.trim()}\n`;
  const validation =
    prepared.kind === 'plan'
      ? validatePlanComment(comment, prepared.validation)
      : validateCheckpointComment(comment, prepared.validation);
  if (!validation.valid) {
    throw new CoordinationWriteError(
      'invalid-checkpoint-comment',
      'checkpoint comment does not match the complete proposed record',
      { errors: validation.errors },
    );
  }
  return { marker, comment, validation };
}

function assertHost(host) {
  for (const method of ['readIssue', 'updateBody', 'replaceStateLabel', 'addComment']) {
    if (typeof host?.[method] !== 'function') {
      throw new CoordinationWriteError('invalid-host-port', `host.${method} must be a function`);
    }
  }
}

async function executeCoordinationWriteInternal(
  { host, issueNumber, expectedBody, values, checkpointComment, operationId, kind = 'work-item' },
  authority,
) {
  assertHost(host);
  if (!Number.isSafeInteger(issueNumber) || issueNumber < 1) {
    throw new CoordinationWriteError(
      'invalid-issue-number',
      'issueNumber must be a positive safe integer',
    );
  }

  const prepared = prepareCoordinationWriteInternal(
    { currentBody: expectedBody, values, kind },
    authority,
  );
  const { marker, comment: proposedComment } = prepareOperationComment(
    prepared,
    checkpointComment,
    operationId,
  );
  const desiredLabel = desiredStateLabel(prepared);
  const mutations = { body: 0, label: 0, comment: 0 };
  let issue = await host.readIssue(issueNumber);
  if (
    !issue ||
    typeof issue.body !== 'string' ||
    !Array.isArray(issue.labels) ||
    !Array.isArray(issue.comments)
  ) {
    throw new CoordinationWriteError(
      'invalid-host-read',
      'host.readIssue returned an invalid issue snapshot',
    );
  }

  if (
    isInitialClaimTransition(expectedBody, prepared) &&
    issue.body !== prepared.body &&
    authority !== CLAIM_ESTABLISHMENT_AUTHORITY
  ) {
    throw new CoordinationWriteError(
      'initial-claim-requires-reference',
      'parked-to-agent-owned transitions require the dedicated remote-reference claim module',
    );
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
    comment.body?.includes(marker),
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
      return partial('body', error, mutations, { bodyMayHaveChanged: true });
    }
    if (issue.body !== prepared.body) {
      return partial(
        'body-verification',
        'host body does not equal the validated proposed body',
        mutations,
        {
          bodyMayHaveChanged: true,
        },
      );
    }
  }

  const currentStateLabels = stateLabels(issue.labels);
  if (currentStateLabels.length !== 1 || currentStateLabels[0] !== desiredLabel) {
    try {
      mutations.label += 1;
      await host.replaceStateLabel(issueNumber, desiredLabel);
      issue = await host.readIssue(issueNumber);
    } catch (error) {
      return partial('label', error, mutations, { bodyWritten: true });
    }
    const verifiedLabels = stateLabels(issue.labels);
    if (verifiedLabels.length !== 1 || verifiedLabels[0] !== desiredLabel) {
      return partial(
        'label-verification',
        'host state label does not match the proposed body',
        mutations,
        {
          bodyWritten: true,
        },
      );
    }
  }

  const existing = issue.comments.filter((comment) => comment.body?.includes(marker));
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
      return partial('comment', error, mutations, {
        bodyWritten: true,
        labelWritten: true,
        commentMayHaveChanged: true,
      });
    }
  }

  const finalLabels = stateLabels(issue.labels);
  const finalComments = issue.comments.filter((comment) => comment.body?.includes(marker));
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
    return partial(
      'final-verification',
      'label or comment drifted before one coherent final snapshot could be verified',
      mutations,
      {
        bodyWritten: true,
        finalVerification,
        commentMayHaveChanged: !finalVerification.comment,
      },
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

export async function executeCoordinationWrite(input) {
  return executeCoordinationWriteInternal(input, undefined);
}

// This narrow entry point is imported only by coordination-claim.mjs. The ordinary writer and
// its CLI never receive the module-private authority token.
export async function executeClaimEstablishmentWrite(input) {
  return executeCoordinationWriteInternal(input, CLAIM_ESTABLISHMENT_AUTHORITY);
}

function parseJsonOutput(output, description) {
  const text = typeof output === 'string' ? output : output?.stdout;
  if (typeof text !== 'string') {
    throw new CoordinationWriteError('invalid-adapter-output', `${description} returned no text`);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new CoordinationWriteError(
      'invalid-adapter-output',
      `${description} returned malformed JSON: ${error.message}`,
    );
  }
}

export async function runGitHubCli(args, input) {
  return await new Promise((resolve, reject) => {
    const child = spawn('gh', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('error', reject);
    child.stdin.on('error', (error) => {
      if (error.code !== 'EPIPE') reject(error);
    });
    child.on('close', (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`gh exited ${code}: ${stderr.trim() || 'no diagnostic'}`));
    });
    child.stdin.end(input);
  });
}

function repositoryPath(repository) {
  if (typeof repository !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    throw new CoordinationWriteError(
      'invalid-repository',
      'repository must be an explicit owner/name',
    );
  }
  return `repos/${repository}`;
}

export function createGitHubCliHost({ repository, runGh = runGitHubCli }) {
  const root = repositoryPath(repository);
  if (typeof runGh !== 'function') {
    throw new CoordinationWriteError('invalid-gh-runner', 'runGh must be a function');
  }

  async function request(args, input, description) {
    return parseJsonOutput(await runGh(args, input), description);
  }

  async function readRawIssue(issueNumber) {
    return await request(['api', `${root}/issues/${issueNumber}`], undefined, 'issue read');
  }

  return {
    async readIssue(issueNumber) {
      const before = await readRawIssue(issueNumber);
      const pages = await request(
        ['api', '--paginate', '--slurp', `${root}/issues/${issueNumber}/comments`],
        undefined,
        'comment read',
      );
      const after = await readRawIssue(issueNumber);
      if (!Array.isArray(pages) || pages.some((page) => !Array.isArray(page))) {
        throw new CoordinationWriteError(
          'invalid-adapter-output',
          'paginated comment read must return an array of pages',
        );
      }
      const labels = (issue) =>
        Array.isArray(issue.labels)
          ? issue.labels.map((label) => (typeof label === 'string' ? label : label.name)).sort()
          : issue.labels;
      if (
        before.body !== after.body ||
        JSON.stringify(labels(before)) !== JSON.stringify(labels(after))
      ) {
        throw new CoordinationWriteError(
          'unstable-host-read',
          'body or label evidence drifted while comments were being read',
        );
      }
      return {
        body: after.body,
        labels: labels(after),
        comments: pages.flat().map((comment) => ({ id: comment.id, body: comment.body })),
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
  const valueOptions = new Set([
    '--repo',
    '--issue',
    '--kind',
    '--expected-body-file',
    '--values-file',
    '--comment-file',
    '--operation-id',
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--dry-run' || argument === '--apply') {
      if (options[argument]) throw new CoordinationWriteError('duplicate-option', argument);
      options[argument] = true;
      continue;
    }
    if (!valueOptions.has(argument)) {
      throw new CoordinationWriteError('unknown-option', `unsupported option ${argument}`);
    }
    if (options[argument] !== undefined || argv[index + 1] === undefined) {
      throw new CoordinationWriteError('invalid-option', `invalid ${argument}`);
    }
    options[argument] = argv[index + 1];
    index += 1;
  }
  if (Boolean(options['--dry-run']) === Boolean(options['--apply'])) {
    throw new CoordinationWriteError(
      'explicit-mode-required',
      'invoke exactly one of --dry-run or --apply',
    );
  }
  for (const required of [
    '--repo',
    '--issue',
    '--kind',
    '--expected-body-file',
    '--values-file',
    '--comment-file',
    '--operation-id',
  ]) {
    if (!options[required]) {
      throw new CoordinationWriteError('missing-option', `${required} is required`);
    }
  }
  const issueNumber = Number(options['--issue']);
  if (!Number.isSafeInteger(issueNumber) || issueNumber < 1) {
    throw new CoordinationWriteError('invalid-issue-number', '--issue must be a positive integer');
  }
  const kind = options['--kind'];
  if (!['work-item', 'plan'].includes(kind)) {
    throw new CoordinationWriteError('invalid-kind', '--kind must be work-item or plan');
  }
  repositoryPath(options['--repo']);
  return {
    mode: options['--apply'] ? 'apply' : 'dry-run',
    repository: options['--repo'],
    issueNumber,
    kind,
    expectedBodyFile: options['--expected-body-file'],
    valuesFile: options['--values-file'],
    commentFile: options['--comment-file'],
    operationId: options['--operation-id'],
  };
}

export async function runCoordinationWriteCli({
  argv,
  readText = (path) => readFile(path, 'utf8'),
  runGh = runGitHubCli,
  writeOutput = (text) => process.stdout.write(text),
}) {
  const options = parseCliArguments(argv);
  const [expectedBody, valuesText, checkpointComment] = await Promise.all([
    readText(options.expectedBodyFile),
    readText(options.valuesFile),
    readText(options.commentFile),
  ]);
  let values;
  try {
    values = JSON.parse(valuesText);
  } catch (error) {
    throw new CoordinationWriteError(
      'invalid-values-json',
      `values file is malformed JSON: ${error.message}`,
    );
  }
  const prepared = prepareCoordinationWrite({
    currentBody: expectedBody,
    values,
    kind: options.kind,
  });
  const operationComment = prepareOperationComment(
    prepared,
    checkpointComment,
    options.operationId,
  );
  const preview = {
    status: 'dry-run',
    issueNumber: options.issueNumber,
    kind: options.kind,
    migrated: prepared.migrated,
    desiredLabel: desiredStateLabel(prepared),
    body: prepared.body,
    comment: operationComment.comment,
  };
  if (options.mode === 'dry-run') {
    writeOutput(`${JSON.stringify(preview, null, 2)}\n`);
    return preview;
  }

  const host = createGitHubCliHost({ repository: options.repository, runGh });
  const result = await executeCoordinationWrite({
    host,
    issueNumber: options.issueNumber,
    expectedBody,
    values,
    checkpointComment,
    operationId: options.operationId,
    kind: options.kind,
  });
  writeOutput(`${JSON.stringify(result, null, 2)}\n`);
  return result;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  runCoordinationWriteCli({ argv: process.argv.slice(2) })
    .then((result) => {
      if (!['dry-run', 'complete'].includes(result.status)) process.exitCode = 2;
    })
    .catch((error) => {
      const code = error instanceof CoordinationWriteError ? error.code : 'unexpected-error';
      console.error(`${code}: ${error.message}`);
      process.exitCode = 1;
    });
}
