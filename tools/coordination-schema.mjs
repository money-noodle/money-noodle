export const REGISTRY_SCHEMA_VERSION_FIELD = 'Registry-Schema-Version';
export const CURRENT_REGISTRY_SCHEMA_VERSION = '2';
export const CLAIM_BRANCH_VERSION = 1;
export const BOOTSTRAP_ISSUE = 42;
export const BOOTSTRAP_BRANCH = 'arch/remote-reference-claim-primitive';

const RESERVED_CLAIM_PREFIX = 'claim-v';
const RESERVED_CLAIM_BRANCH = /^claim-v([1-9]\d*)\/issue-([1-9]\d*)$/;

function positiveClaimIssueNumber(value) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError('issue number must be a canonical positive safe integer');
  }
  return value;
}

export function claimBranchForIssue(issueNumber) {
  return `claim-v${CLAIM_BRANCH_VERSION}/issue-${positiveClaimIssueNumber(issueNumber)}`;
}

export function claimRefForIssue(issueNumber) {
  return `refs/heads/${claimBranchForIssue(issueNumber)}`;
}

export function parseReservedClaimBranch(branch) {
  if (typeof branch !== 'string' || !branch.startsWith(RESERVED_CLAIM_PREFIX)) {
    return { status: 'not-reserved' };
  }
  const match = branch.match(RESERVED_CLAIM_BRANCH);
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
  positiveClaimIssueNumber(issueNumber);
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

export const CLAIM_STATES = [
  'proposed',
  'ready',
  'active',
  'blocked',
  'review',
  'done',
  'abandoned',
];
export const CLAIM_HARNESSES = ['unclaimed', 'pi', 'claude-code', 'copilot', 'other'];
export const CHECK_VERDICTS = [
  'passed',
  'pending',
  'failed',
  'cancelled',
  'skipped',
  'missing',
  'unavailable',
  'mixed',
];
export const IMPACT_VALUES = ['none', 'present', 'unknown'];

export const V1_PORTABLE_CLAIM_FIELDS = [
  'Claim-State',
  'Claim-Harness',
  'Claim-Run-ID',
  'Claim-Agent',
  'Claim-Branch',
  'Claim-Worktree',
  'Claimed-At',
  'Check-In-By',
];

export const V2_PORTABLE_CLAIM_FIELDS = [
  'Claim-State',
  'Claim-Harness',
  'Claim-Run-ID',
  'Claim-Agent',
  'Claim-Branch',
  'Claim-Host',
  'Claimed-At',
  'Check-In-By',
  'Waiting-Since',
];

export const CHECKPOINT_EVIDENCE_FIELDS = [
  'Checkpoint-Evidence-Version',
  'Checkpoint-State',
  'Checkpoint-At',
  'Checkpoint-Commit',
  'Checkpoint-Changed-Path-Count',
  'Checkpoint-Checks-Verdict',
  'Checkpoint-CI-Run',
  'Checkpoint-CI-Commit',
  'Checkpoint-Security-Impact',
  'Checkpoint-Tenant-Impact',
  'Checkpoint-Provider-Impact',
  'Checkpoint-Deployment-Impact',
  'Checkpoint-Residual-Risk-Count',
  'Next-Action',
  'Blockers',
];

export const V2_WORK_ITEM_FIELDS = [
  REGISTRY_SCHEMA_VERSION_FIELD,
  'Parent-Plan',
  'Scope-Paths',
  'Depends-On',
  'Dependency-Notes',
  'Integration-Owner',
  'Reconciled-Claim-Comment-IDs',
  ...V2_PORTABLE_CLAIM_FIELDS,
  ...CHECKPOINT_EVIDENCE_FIELDS,
];

export const V2_PLAN_FIELDS = [
  REGISTRY_SCHEMA_VERSION_FIELD,
  'Plan-State',
  'Integration-Owner',
  'Last-Plan-Update',
];

export const ALL_KNOWN_FIELDS = [
  ...new Set([
    ...V2_WORK_ITEM_FIELDS,
    ...V2_PLAN_FIELDS,
    ...V1_PORTABLE_CLAIM_FIELDS,
    'Checkpoint-At',
    'Checkpoint-Commit',
    'Next-Action',
    'Blockers',
    'Shared-Hotspots',
  ]),
];

const UNCLAIMED_VALUES = new Set(['', 'missing', 'none', 'unclaimed', '_no response_']);
const FULL_COMMIT = /^[0-9a-f]{40}$/;
const CI_RUN = /^https:\/\/github\.com\/money-noodle\/money-noodle\/actions\/runs\/[1-9]\d*$/;
const HOST_LABEL = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,62}[A-Za-z0-9])?$/;
const PLAN_STATES = new Set(['proposed', 'active', 'complete']);

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function headingOccurrences(body, name) {
  const escaped = escapeRegExp(name);
  const matches = body.matchAll(
    new RegExp(`^###\\s+${escaped}\\s*$\\n+([\\s\\S]*?)(?=^###\\s+|^##\\s+|(?![\\s\\S]))`, 'gm'),
  );
  return [...matches].map((match) => ({
    syntax: 'issue-form',
    start: match.index,
    end: match.index + match[0].length,
    value: match[1].trim(),
  }));
}

function lineOccurrences(body, name) {
  const escaped = escapeRegExp(name);
  return [...body.matchAll(new RegExp(`^${escaped}:\\s*(.*?)\\s*$`, 'gm'))].map((match) => ({
    syntax: 'field-line',
    start: match.index,
    end: match.index + match[0].length,
    value: match[1].trim(),
  }));
}

export function structuredRecord(body, names = ALL_KNOWN_FIELDS) {
  if (typeof body !== 'string') throw new TypeError('structured record must be a string');

  const fields = {};
  const duplicates = [];
  const occurrences = {};
  for (const name of names) {
    const found = [...lineOccurrences(body, name), ...headingOccurrences(body, name)].sort(
      (left, right) => left.start - right.start,
    );
    occurrences[name] = found;
    if (found.length > 1) duplicates.push(name);
    if (found.length > 0) fields[name] = found.at(-1).value;
  }
  return { fields, duplicates, occurrences };
}

export function isoInstantMilliseconds(value) {
  if (typeof value !== 'string') return undefined;
  const match = value.match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|([+-])(\d{2}):(\d{2}))$/,
  );
  if (!match) return undefined;

  const [
    ,
    yearText,
    monthText,
    dayText,
    hourText,
    minuteText,
    secondText,
    fraction = '',
    zone,
    sign,
    offsetHourText,
    offsetMinuteText,
  ] = match;
  const [year, month, day, hour, minute, second] = [
    yearText,
    monthText,
    dayText,
    hourText,
    minuteText,
    secondText,
  ].map(Number);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysInMonth[month - 1] ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  ) {
    return undefined;
  }

  let offsetMinutes = 0;
  if (zone !== 'Z') {
    const offsetHour = Number(offsetHourText);
    const offsetMinute = Number(offsetMinuteText);
    if (offsetHour > 14 || offsetMinute > 59 || (offsetHour === 14 && offsetMinute !== 0)) {
      return undefined;
    }
    offsetMinutes = (offsetHour * 60 + offsetMinute) * (sign === '+' ? 1 : -1);
  }

  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, Number((fraction + '000').slice(0, 3)));
  return date.getTime() - offsetMinutes * 60_000;
}

export function isMeaningful(value) {
  return typeof value === 'string' && !UNCLAIMED_VALUES.has(value.trim().toLowerCase());
}

function problem(code, field, message) {
  return { code, field, message };
}

function requireFields(record, names, errors) {
  for (const name of names) {
    if (record.occurrences[name]?.length !== 1) {
      errors.push(
        problem(
          record.occurrences[name]?.length > 1 ? 'duplicate-field' : 'missing-field',
          name,
          `${name} must occur exactly once`,
        ),
      );
    }
  }
}

export function registryVersion(body) {
  const record = structuredRecord(body, [REGISTRY_SCHEMA_VERSION_FIELD]);
  if (record.duplicates.length > 0) {
    return {
      version: 'unknown',
      explicit: true,
      status: 'invalid',
      errors: [
        problem(
          'duplicate-schema-version',
          REGISTRY_SCHEMA_VERSION_FIELD,
          `${REGISTRY_SCHEMA_VERSION_FIELD} must occur exactly once at most`,
        ),
      ],
    };
  }
  const raw = record.fields[REGISTRY_SCHEMA_VERSION_FIELD];
  if (raw === undefined) return { version: '1', explicit: false, status: 'supported', errors: [] };
  if (raw === '1' || raw === '2') {
    return { version: raw, explicit: true, status: 'supported', errors: [] };
  }
  return {
    version: raw || 'empty',
    explicit: true,
    status: 'unsupported',
    errors: [
      problem(
        'unsupported-schema-version',
        REGISTRY_SCHEMA_VERSION_FIELD,
        `unsupported registry schema version ${raw || 'empty'}`,
      ),
    ],
  };
}

export function parseStrictDependencies(value) {
  if (value === 'none') return { status: 'clear', numbers: [] };
  if (typeof value !== 'string' || !/^#[1-9]\d*(?:, #[1-9]\d*)*$/.test(value)) {
    return { status: 'invalid', numbers: [] };
  }
  const numbers = value.split(', ').map((entry) => Number(entry.slice(1)));
  if (
    new Set(numbers).size !== numbers.length ||
    numbers.some((number) => !Number.isSafeInteger(number))
  ) {
    return { status: 'invalid', numbers: [] };
  }
  return { status: 'declared', numbers };
}

export function normalizeScopePaths(value) {
  if (typeof value !== 'string') return { status: 'invalid', paths: [] };
  const trimmed = value.trim();
  if (trimmed === 'none') return { status: 'none', paths: [] };
  const paths = trimmed
    .split(/\r?\n|,\s*/)
    .map((entry) => entry.trim().replace(/^[-*]\s+/, ''))
    .filter(Boolean);
  if (
    paths.length === 0 ||
    new Set(paths).size !== paths.length ||
    paths.some(
      (path) =>
        path.startsWith('/') ||
        path.startsWith('~/') ||
        /^[A-Za-z]:\//.test(path) ||
        path.includes('\\') ||
        path.split('/').some((segment) => ['', '.', '..'].includes(segment)) ||
        /[\0\r\n,]/.test(path) ||
        /\s/.test(path),
    )
  ) {
    return { status: 'invalid', paths: [] };
  }
  return { status: 'declared', paths };
}

function validateCheckpoint(record, claimState, errors, { allowInitial = true } = {}) {
  requireFields(record, CHECKPOINT_EVIDENCE_FIELDS, errors);
  if (errors.some(({ field }) => CHECKPOINT_EVIDENCE_FIELDS.includes(field))) return;
  const fields = record.fields;

  if (fields['Checkpoint-Evidence-Version'] !== '1') {
    errors.push(
      problem(
        'invalid-checkpoint-version',
        'Checkpoint-Evidence-Version',
        'checkpoint evidence version must be 1',
      ),
    );
  }
  if (fields['Checkpoint-State'] !== claimState) {
    errors.push(
      problem(
        'checkpoint-state-mismatch',
        'Checkpoint-State',
        'Checkpoint-State must equal Claim-State',
      ),
    );
  }
  const initial = allowInitial && ['proposed', 'ready'].includes(claimState);
  if (
    !(initial && fields['Checkpoint-At'] === 'unclaimed') &&
    isoInstantMilliseconds(fields['Checkpoint-At']) === undefined
  ) {
    errors.push(
      problem(
        'invalid-checkpoint-at',
        'Checkpoint-At',
        'Checkpoint-At must be a strict ISO instant',
      ),
    );
  }
  if (!(
    FULL_COMMIT.test(fields['Checkpoint-Commit']) || fields['Checkpoint-Commit'] === 'uncommitted'
  )) {
    errors.push(
      problem(
        'invalid-checkpoint-commit',
        'Checkpoint-Commit',
        'Checkpoint-Commit must be uncommitted or a full commit',
      ),
    );
  }
  if (!/^\d+$/.test(fields['Checkpoint-Changed-Path-Count'])) {
    errors.push(
      problem(
        'invalid-changed-path-count',
        'Checkpoint-Changed-Path-Count',
        'changed-path count must be a non-negative integer',
      ),
    );
  }
  if (!CHECK_VERDICTS.includes(fields['Checkpoint-Checks-Verdict'])) {
    errors.push(
      problem(
        'invalid-checks-verdict',
        'Checkpoint-Checks-Verdict',
        'checks verdict is not supported',
      ),
    );
  }
  const run = fields['Checkpoint-CI-Run'];
  const ciCommit = fields['Checkpoint-CI-Commit'];
  if (!(run === 'unavailable' || CI_RUN.test(run))) {
    errors.push(
      problem(
        'invalid-ci-run',
        'Checkpoint-CI-Run',
        'CI run must be unavailable or an immutable repository run URL',
      ),
    );
  }
  if (!(ciCommit === 'unavailable' || FULL_COMMIT.test(ciCommit))) {
    errors.push(
      problem(
        'invalid-ci-commit',
        'Checkpoint-CI-Commit',
        'CI commit must be unavailable or a full commit',
      ),
    );
  }
  if (CI_RUN.test(run) && ciCommit !== fields['Checkpoint-Commit']) {
    errors.push(
      problem(
        'ci-commit-mismatch',
        'Checkpoint-CI-Commit',
        'CI commit must equal Checkpoint-Commit when a run exists',
      ),
    );
  }
  if (run === 'unavailable' && ciCommit !== 'unavailable') {
    errors.push(
      problem(
        'ci-evidence-mismatch',
        'Checkpoint-CI-Commit',
        'CI commit must be unavailable when the run is unavailable',
      ),
    );
  }
  if (fields['Checkpoint-Checks-Verdict'] === 'passed' && !CI_RUN.test(run)) {
    errors.push(
      problem(
        'passed-without-ci',
        'Checkpoint-Checks-Verdict',
        'passed requires an immutable CI run',
      ),
    );
  }
  for (const field of [
    'Checkpoint-Security-Impact',
    'Checkpoint-Tenant-Impact',
    'Checkpoint-Provider-Impact',
    'Checkpoint-Deployment-Impact',
  ]) {
    if (!IMPACT_VALUES.includes(fields[field])) {
      errors.push(problem('invalid-impact', field, `${field} must be none, present, or unknown`));
    }
  }
  if (!/^\d+$/.test(fields['Checkpoint-Residual-Risk-Count'])) {
    errors.push(
      problem(
        'invalid-residual-risk-count',
        'Checkpoint-Residual-Risk-Count',
        'residual-risk count must be a non-negative integer',
      ),
    );
  }
  for (const field of ['Next-Action', 'Blockers']) {
    if (typeof fields[field] !== 'string' || fields[field].trim() === '') {
      errors.push(problem('empty-narrative-field', field, `${field} must be explicit`));
    }
  }
}

function validateV2Ownership(record, errors) {
  const fields = record.fields;
  const state = fields['Claim-State'];
  if (!CLAIM_STATES.includes(state)) {
    errors.push(problem('invalid-claim-state', 'Claim-State', 'Claim-State is not supported'));
    return;
  }
  if (!CLAIM_HARNESSES.includes(fields['Claim-Harness'])) {
    errors.push(
      problem('invalid-claim-harness', 'Claim-Harness', 'Claim-Harness is not supported'),
    );
  }

  const ownershipFields = [
    'Claim-Harness',
    'Claim-Run-ID',
    'Claim-Agent',
    'Claim-Branch',
    'Claim-Host',
    'Claimed-At',
  ];
  const meaningfulOwnership = ownershipFields.map((field) => isMeaningful(fields[field]));
  const allOwned = meaningfulOwnership.every(Boolean);
  const noneOwned = meaningfulOwnership.every((value) => !value);

  if (['active', 'review'].includes(state)) {
    if (!allOwned) {
      errors.push(
        problem(
          'incomplete-agent-ownership',
          'Claim-State',
          `${state} requires complete agent ownership fields`,
        ),
      );
    }
    if (isoInstantMilliseconds(fields['Check-In-By']) === undefined) {
      errors.push(
        problem(
          'missing-agent-liveness',
          'Check-In-By',
          `${state} requires a strict check-in deadline`,
        ),
      );
    }
    if (isMeaningful(fields['Waiting-Since'])) {
      errors.push(
        problem(
          'mixed-liveness',
          'Waiting-Since',
          `${state} cannot carry principal-waiting liveness`,
        ),
      );
    }
  } else if (state === 'blocked') {
    if (!noneOwned) {
      errors.push(
        problem(
          'blocked-agent-ownership',
          'Claim-State',
          'blocked is principal-owned in schema v2; agent-impeded work remains active',
        ),
      );
    }
    if (isMeaningful(fields['Check-In-By'])) {
      errors.push(
        problem(
          'mixed-liveness',
          'Check-In-By',
          'principal-waiting blocked work has no check-in deadline',
        ),
      );
    }
    if (isoInstantMilliseconds(fields['Waiting-Since']) === undefined) {
      errors.push(
        problem(
          'missing-principal-liveness',
          'Waiting-Since',
          'blocked requires a strict Waiting-Since instant',
        ),
      );
    }
  } else if (['proposed', 'ready'].includes(state)) {
    if (!noneOwned)
      errors.push(problem('parked-ownership', 'Claim-State', `${state} must remain unclaimed`));
    if (isMeaningful(fields['Check-In-By']) || isMeaningful(fields['Waiting-Since'])) {
      errors.push(
        problem('parked-liveness', 'Claim-State', `${state} carries no liveness timestamp`),
      );
    }
  } else {
    if (!(allOwned || noneOwned)) {
      errors.push(
        problem(
          'partial-terminal-ownership',
          'Claim-State',
          `${state} may retain complete ownership evidence or none`,
        ),
      );
    }
    if (isMeaningful(fields['Check-In-By']) || isMeaningful(fields['Waiting-Since'])) {
      errors.push(
        problem(
          'terminal-liveness',
          'Claim-State',
          `${state} carries no current liveness timestamp`,
        ),
      );
    }
  }

  if (
    isMeaningful(fields['Claimed-At']) &&
    isoInstantMilliseconds(fields['Claimed-At']) === undefined
  ) {
    errors.push(
      problem('invalid-claimed-at', 'Claimed-At', 'Claimed-At must be a strict ISO instant'),
    );
  }
  if (isMeaningful(fields['Claim-Host']) && !HOST_LABEL.test(fields['Claim-Host'])) {
    errors.push(
      problem(
        'invalid-claim-host',
        'Claim-Host',
        'Claim-Host must be a portable host label, not a filesystem path',
      ),
    );
  }
}

export function validateWorkItemBody(body) {
  const version = registryVersion(body);
  if (version.status !== 'supported')
    return { ...version, kind: 'work-item', valid: false, fields: {}, duplicates: [] };

  const record = structuredRecord(body, ALL_KNOWN_FIELDS);
  if (version.version === '1') {
    return {
      ...version,
      kind: 'work-item',
      valid: true,
      fields: record.fields,
      duplicates: record.duplicates,
      errors: [],
    };
  }

  const errors = [...version.errors];
  requireFields(record, V2_WORK_ITEM_FIELDS, errors);
  for (const removed of ['Claim-Worktree', 'Shared-Hotspots']) {
    if (record.occurrences[removed]?.length > 0) {
      errors.push(
        problem(
          'removed-v2-field',
          removed,
          `${removed} is not permitted in registry schema version 2`,
        ),
      );
    }
  }
  if (errors.some(({ code }) => ['missing-field', 'duplicate-field'].includes(code))) {
    return {
      ...version,
      kind: 'work-item',
      valid: false,
      fields: record.fields,
      duplicates: record.duplicates,
      errors,
    };
  }

  const fields = record.fields;
  if (!/^#[1-9]\d*$/.test(fields['Parent-Plan'])) {
    errors.push(
      problem('invalid-parent-plan', 'Parent-Plan', 'Parent-Plan must be one issue reference'),
    );
  }
  const scope = normalizeScopePaths(fields['Scope-Paths']);
  if (scope.status === 'invalid') {
    errors.push(
      problem(
        'invalid-scope-paths',
        'Scope-Paths',
        'Scope-Paths must be none or unique repository-relative paths/globs',
      ),
    );
  }
  const dependencies = parseStrictDependencies(fields['Depends-On']);
  if (dependencies.status === 'invalid') {
    errors.push(
      problem(
        'invalid-dependencies',
        'Depends-On',
        'Depends-On must be none or a canonical comma-space issue list',
      ),
    );
  }
  if (typeof fields['Dependency-Notes'] !== 'string' || fields['Dependency-Notes'].trim() === '') {
    errors.push(
      problem(
        'missing-dependency-notes',
        'Dependency-Notes',
        'Dependency-Notes must be explicit, using none when empty',
      ),
    );
  }
  if (!isMeaningful(fields['Integration-Owner'])) {
    errors.push(
      problem(
        'missing-integration-owner',
        'Integration-Owner',
        'Integration-Owner must name a principal',
      ),
    );
  }
  const resolution = fields['Reconciled-Claim-Comment-IDs'];
  if (!(resolution === 'none' || /^[1-9]\d*(?:, [1-9]\d*)*$/.test(resolution))) {
    errors.push(
      problem(
        'invalid-reconciled-comments',
        'Reconciled-Claim-Comment-IDs',
        'reconciled comment IDs must be none or a canonical comma-space list',
      ),
    );
  }
  validateV2Ownership(record, errors);
  validateCheckpoint(record, fields['Claim-State'], errors);

  return {
    ...version,
    kind: 'work-item',
    valid: errors.length === 0,
    fields,
    duplicates: record.duplicates,
    normalized: { scopePaths: scope.paths, dependencies: dependencies.numbers },
    errors,
  };
}

export function validatePlanBody(body) {
  const version = registryVersion(body);
  if (version.status !== 'supported')
    return { ...version, kind: 'plan', valid: false, fields: {}, duplicates: [] };
  const record = structuredRecord(body, ALL_KNOWN_FIELDS);
  if (version.version === '1') {
    return {
      ...version,
      kind: 'plan',
      valid: true,
      fields: record.fields,
      duplicates: record.duplicates,
      errors: [],
    };
  }

  const errors = [...version.errors];
  requireFields(record, V2_PLAN_FIELDS, errors);
  if (!errors.some(({ code }) => ['missing-field', 'duplicate-field'].includes(code))) {
    if (!PLAN_STATES.has(record.fields['Plan-State'])) {
      errors.push(
        problem(
          'invalid-plan-state',
          'Plan-State',
          'Plan-State must be proposed, active, or complete',
        ),
      );
    }
    if (!isMeaningful(record.fields['Integration-Owner'])) {
      errors.push(
        problem(
          'missing-integration-owner',
          'Integration-Owner',
          'Integration-Owner must name a principal',
        ),
      );
    }
    if (isoInstantMilliseconds(record.fields['Last-Plan-Update']) === undefined) {
      errors.push(
        problem(
          'invalid-plan-update',
          'Last-Plan-Update',
          'Last-Plan-Update must be a strict ISO instant',
        ),
      );
    }
  }
  return {
    ...version,
    kind: 'plan',
    valid: errors.length === 0,
    fields: record.fields,
    duplicates: record.duplicates,
    errors,
  };
}

export function validatePlanComment(body, planRecord) {
  if (typeof body !== 'string') throw new TypeError('plan comment must be a string');
  if (planRecord?.version !== '2') {
    return { applicable: false, valid: false, fields: {}, errors: [] };
  }

  const record = structuredRecord(body, [...V2_PLAN_FIELDS, 'Coordination-Write-ID']);
  const errors = [];
  requireFields(record, V2_PLAN_FIELDS, errors);
  if (!errors.some(({ code }) => ['missing-field', 'duplicate-field'].includes(code))) {
    for (const field of V2_PLAN_FIELDS) {
      if (record.fields[field] !== planRecord.fields[field]) {
        errors.push(
          problem('body-comment-mismatch', field, `${field} does not match the proposed body`),
        );
      }
    }
  }
  return { applicable: true, valid: errors.length === 0, fields: record.fields, errors };
}

export function validateCheckpointComment(body, workRecord) {
  if (typeof body !== 'string') throw new TypeError('checkpoint comment must be a string');
  const commentShape = structuredRecord(body, ['Claim-Worktree', 'Claim-Host']);
  if (
    workRecord?.version === '2' &&
    commentShape.fields['Claim-Worktree'] !== undefined &&
    commentShape.fields['Claim-Host'] === undefined
  ) {
    return {
      applicable: false,
      historicalContract: true,
      contractVersion: '1',
      valid: true,
      fields: {},
      errors: [],
    };
  }
  const hasEvidenceHeader = structuredRecord(body, ['Checkpoint-Evidence-Version']).fields[
    'Checkpoint-Evidence-Version'
  ];
  if (workRecord?.version === '1' && hasEvidenceHeader === undefined) {
    return { applicable: false, valid: true, fields: {}, errors: [] };
  }
  if (!['1', '2'].includes(workRecord?.version)) {
    return { applicable: false, valid: true, fields: {}, errors: [] };
  }

  const claimFields =
    workRecord.version === '2' ? V2_PORTABLE_CLAIM_FIELDS : V1_PORTABLE_CLAIM_FIELDS;
  const names = [...claimFields, ...CHECKPOINT_EVIDENCE_FIELDS, 'Coordination-Write-ID'];
  const record = structuredRecord(body, names);
  const errors = [];
  requireFields(record, [...claimFields, ...CHECKPOINT_EVIDENCE_FIELDS], errors);
  if (!errors.some(({ code }) => ['missing-field', 'duplicate-field'].includes(code))) {
    for (const field of claimFields) {
      if (record.fields[field] !== workRecord.fields[field]) {
        errors.push(
          problem('body-comment-mismatch', field, `${field} does not match the proposed body`),
        );
      }
    }
    validateCheckpoint(record, record.fields['Claim-State'], errors, { allowInitial: true });
    for (const field of CHECKPOINT_EVIDENCE_FIELDS) {
      if (record.fields[field] !== workRecord.fields[field]) {
        errors.push(
          problem('body-comment-mismatch', field, `${field} does not match the proposed body`),
        );
      }
    }
  }
  return { applicable: true, valid: errors.length === 0, fields: record.fields, errors };
}
