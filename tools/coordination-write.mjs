#!/usr/bin/env node

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

export function prepareCoordinationWrite({ currentBody, values, kind = 'work-item' }) {
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

  return {
    kind,
    body,
    fields: canonical,
    validation,
    migrated: version.version === '1',
    sourceVersion: version.version,
    targetVersion: CURRENT_REGISTRY_SCHEMA_VERSION,
  };
}

function stateLabels(labels) {
  return labels.filter((label) => STATE_LABELS.has(label));
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

function assertHost(host) {
  for (const method of ['readIssue', 'updateBody', 'replaceStateLabel', 'addComment']) {
    if (typeof host?.[method] !== 'function') {
      throw new CoordinationWriteError('invalid-host-port', `host.${method} must be a function`);
    }
  }
}

export async function executeCoordinationWrite({
  host,
  issueNumber,
  expectedBody,
  values,
  checkpointComment,
  operationId,
  kind = 'work-item',
}) {
  assertHost(host);
  if (!Number.isSafeInteger(issueNumber) || issueNumber < 1) {
    throw new CoordinationWriteError(
      'invalid-issue-number',
      'issueNumber must be a positive safe integer',
    );
  }

  const prepared = prepareCoordinationWrite({ currentBody: expectedBody, values, kind });
  if (kind !== 'work-item') {
    throw new CoordinationWriteError(
      'plan-cross-surface-write-unsupported',
      'plan body construction is supported, but plan label/comment lifecycle requires a separately defined contract',
    );
  }
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
  const proposedComment = `${marker}\n${checkpointComment.trim()}\n`;
  const commentValidation = validateCheckpointComment(proposedComment, prepared.validation);
  if (!commentValidation.valid) {
    throw new CoordinationWriteError(
      'invalid-checkpoint-comment',
      'checkpoint comment does not match the complete proposed record',
      {
        errors: commentValidation.errors,
      },
    );
  }

  const desiredLabel = `work:${prepared.fields['Claim-State']}`;
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

  if (issue.body !== expectedBody && issue.body !== prepared.body) {
    return {
      status: 'collision',
      stage: 'pre-write',
      recoverable: false,
      mutations,
      message: 'the host body changed after the caller snapshot; no mutation was attempted',
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
    return partial(
      'comment-collision',
      'operation marker is duplicated or attached to different evidence',
      mutations,
      {
        bodyWritten: true,
        labelWritten: true,
      },
    );
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

  const verifiedComments = issue.comments.filter((comment) => comment.body?.includes(marker));
  if (verifiedComments.length !== 1 || verifiedComments[0].body !== proposedComment) {
    return partial(
      'comment-verification',
      'append-only checkpoint evidence was not verified',
      mutations,
      {
        bodyWritten: true,
        labelWritten: true,
        commentMayHaveChanged: true,
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
  };
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  console.log(
    'coordination-write.mjs exposes a validated writer library over an injected host port. It intentionally has no live GitHub adapter during schema-v2 bootstrap.',
  );
}
