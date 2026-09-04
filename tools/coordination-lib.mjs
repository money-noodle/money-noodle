import {
  BOOTSTRAP_BRANCH,
  BOOTSTRAP_ISSUE,
  CHECKPOINT_EVIDENCE_FIELDS,
  V1_PORTABLE_CLAIM_FIELDS,
  claimBranchForIssue,
  V2_PORTABLE_CLAIM_FIELDS,
  isoInstantMilliseconds as schemaIsoInstantMilliseconds,
  parseReservedClaimRef,
  structuredRecord,
  validateClaimBranch,
  validateCheckpointComment,
  validatePlanBody,
  validateWorkItemBody,
} from './coordination-schema.mjs';

export const SCHEMA_VERSION = '1.0';

export const PORTABLE_CLAIM_FIELDS = V1_PORTABLE_CLAIM_FIELDS;

export const CHECKPOINT_FIELDS = [
  'Checkpoint-At',
  'Checkpoint-Commit',
  'Next-Action',
  'Blockers',
];

const ALL_PORTABLE_CLAIM_FIELDS = [
  ...new Set([...V1_PORTABLE_CLAIM_FIELDS, ...V2_PORTABLE_CLAIM_FIELDS]),
];
const ALL_COMMENT_FIELDS = [...ALL_PORTABLE_CLAIM_FIELDS, ...CHECKPOINT_EVIDENCE_FIELDS];

function claimFieldsForVersion(version) {
  return version === '2' ? V2_PORTABLE_CLAIM_FIELDS : V1_PORTABLE_CLAIM_FIELDS;
}

function ownershipFieldsForVersion(version) {
  return claimFieldsForVersion(version).filter(
    (name) => !['Claim-State', 'Claimed-At', 'Check-In-By', 'Waiting-Since'].includes(name),
  );
}
export const CLAIM_COMMENT_RESOLUTION_FIELD = "Reconciled-Claim-Comment-IDs";

const FULL_COMMIT = /^[0-9a-f]{40}$/;
const INTEGRATION_HOLD_HEADING = '## Integration hold evidence';
const INTEGRATION_HOLD_FIELDS = [
  'Integration-Hold-Evidence-Version',
  'Integration-Hold-Action',
  'Integration-Hold-ID',
  'Integration-Hold-Principal',
  'Integration-Hold-PR',
  'Integration-Hold-Head',
  'Integration-Hold-Base',
  'Integration-Hold-Attempt',
  'Integration-Hold-Scratch-Branch',
  'Integration-Hold-Acquired-At',
  'Integration-Hold-Event-At',
  'Integration-Hold-Outcome',
];

export const NONTERMINAL_CLAIMED_STATES = new Set(["active", "blocked", "review"]);

export function classifyCommitRelationship({
  left,
  right,
  leftIsAncestor,
  rightIsAncestor,
  available = true,
}) {
  if (!available || !FULL_COMMIT.test(left ?? '') || !FULL_COMMIT.test(right ?? '')) {
    return 'unavailable';
  }
  if (left === right) return 'equal';
  if (leftIsAncestor === true && rightIsAncestor === false) return 'right-ahead';
  if (leftIsAncestor === false && rightIsAncestor === true) return 'left-ahead';
  if (leftIsAncestor === false && rightIsAncestor === false) return 'divergence';
  return 'unavailable';
}

export function classifyIntegrationCheckout({
  symbolicBranch,
  clean,
  inProgress,
  localHead,
  remoteHead,
  relationship,
  available = true,
}) {
  if (!available || !FULL_COMMIT.test(localHead ?? '') || !FULL_COMMIT.test(remoteHead ?? '')) {
    return 'unavailable';
  }
  if (symbolicBranch !== 'main') return 'divergence';
  if (!clean || inProgress) return 'dirty-or-in-progress';
  if (localHead === remoteHead) return 'mirrored';
  if (relationship === 'equal') return 'unavailable';
  if (relationship === 'right-ahead') return 'fast-forward-lag';
  if (relationship === 'left-ahead') return 'local-ahead';
  if (relationship === 'divergence') return 'divergence';
  return 'unavailable';
}

export function classifyRemoteClaimLifecycle({ checkpointCommit, remoteHead, relationship }) {
  if (remoteHead === null) return 'missing-branch';
  if (!FULL_COMMIT.test(checkpointCommit ?? '') || !FULL_COMMIT.test(remoteHead ?? '')) {
    return 'unavailable';
  }
  if (checkpointCommit === remoteHead) return 'matched';
  if (relationship === 'equal') return 'unavailable';
  if (relationship === 'left-ahead') return 'local-ahead';
  if (relationship === 'right-ahead') return 'remote-ahead';
  if (relationship === 'divergence') return 'divergence';
  return 'unavailable';
}

export function authoritativeCommitRelationship({
  left,
  right,
  compareBefore,
  compareAfter,
  localRelationship = 'unavailable',
  allowContainedLocalAhead = false,
}) {
  if (!FULL_COMMIT.test(left ?? '') || !FULL_COMMIT.test(right ?? '')) return 'unavailable';
  if (left === right) return 'equal';
  const stableCompare =
    compareBefore?.status === 'available' &&
    compareAfter?.status === 'available' &&
    compareBefore.relationship === compareAfter.relationship &&
    compareBefore.evidenceKey === compareAfter.evidenceKey;
  if (stableCompare) return compareBefore.relationship;
  if (allowContainedLocalAhead && localRelationship === 'left-ahead') return 'left-ahead';
  return 'unavailable';
}

export function classifyRemoteClaimEvidence({
  checkpointCommit,
  expectedRef,
  enumeratedRemoteHead,
  directRefBefore,
  directRefAfter,
  compareBefore,
  compareAfter,
  localContainment,
}) {
  const unavailable = (reason) => ({
    status: 'unavailable',
    checkpointCommit,
    remoteHead: directRefAfter?.sha ?? directRefBefore?.sha ?? null,
    reason,
  });
  if (!FULL_COMMIT.test(checkpointCommit ?? '')) return unavailable('checkpoint commit is malformed');
  if (directRefBefore?.status === 'missing' && directRefAfter?.status === 'missing') {
    return enumeratedRemoteHead === null
      ? { status: 'missing-branch', checkpointCommit, remoteHead: null, reason: 'exact direct ref is missing' }
      : unavailable('paginated ref exists while exact direct ref is missing');
  }
  for (const [name, direct] of [
    ['initial', directRefBefore],
    ['final', directRefAfter],
  ]) {
    if (direct?.status !== 'found') return unavailable(`${name} direct-ref evidence is ${direct?.status ?? 'unavailable'}`);
    if (direct.ref !== expectedRef || direct.objectType !== 'commit' || !FULL_COMMIT.test(direct.sha ?? '')) {
      return unavailable(`${name} direct-ref evidence is malformed`);
    }
  }
  if (directRefBefore.sha !== directRefAfter.sha) return unavailable('exact direct ref changed during verification');
  const remoteHead = directRefAfter.sha;
  if (enumeratedRemoteHead !== remoteHead) {
    return unavailable('paginated and direct-ref evidence disagree');
  }
  if (checkpointCommit === remoteHead) {
    return { status: 'matched', checkpointCommit, remoteHead, reason: null, source: 'direct-ref' };
  }
  const relationship = authoritativeCommitRelationship({
    left: checkpointCommit,
    right: remoteHead,
    compareBefore,
    compareAfter,
    localRelationship: localContainment?.relationship,
    allowContainedLocalAhead: localContainment?.status === 'contained',
  });
  if (relationship === 'left-ahead' && localContainment?.status !== 'contained') {
    return unavailable(`unpublished checkpoint lacks same-host containment: ${localContainment?.status ?? 'missing'}`);
  }
  const status = classifyRemoteClaimLifecycle({ checkpointCommit, remoteHead, relationship });
  return {
    status,
    checkpointCommit,
    remoteHead,
    reason: status === 'unavailable' ? 'authoritative compare evidence is unstable or unavailable' : null,
    source:
      relationship === 'left-ahead' && compareBefore?.status !== 'available'
        ? 'same-host-local-containment'
        : 'github-compare',
  };
}

export function validateClaimBootstrapEvidence(evidence) {
  const errors = [];
  const issueNumber = evidence?.issueNumber;
  const branch = `claim-v1/issue-${issueNumber}`;
  const fullRef = `refs/heads/${branch}`;
  const trackingRef = `refs/remotes/origin/${branch}`;
  const commit = evidence?.checkpointCommit;
  if (!Number.isSafeInteger(issueNumber) || issueNumber < 1) errors.push('issue number is invalid');
  if (!FULL_COMMIT.test(commit ?? '')) errors.push('checkpoint commit is invalid');

  for (const [name, direct] of [
    ['initial direct ref', evidence?.directRefBefore],
    ['final direct ref', evidence?.directRefAfter],
  ]) {
    if (direct?.status !== 'found') errors.push(`${name} is ${direct?.status ?? 'unavailable'}`);
    else if (direct.ref !== fullRef || direct.objectType !== 'commit' || !FULL_COMMIT.test(direct.sha ?? '')) {
      errors.push(`${name} is malformed or mismatched`);
    }
  }
  if (
    evidence?.directRefBefore?.status === 'found' &&
    evidence?.directRefAfter?.status === 'found' &&
    evidence.directRefBefore.sha !== evidence.directRefAfter.sha
  ) {
    errors.push('direct ref changed during bootstrap');
  }

  const preexisting = evidence?.preexisting ?? {};
  if (preexisting.localBranch) errors.push('local branch collision existed before bootstrap');
  if (preexisting.worktreePath) errors.push('worktree path collision existed before bootstrap');
  if (preexisting.branchWorktree) errors.push('claim branch already had a worktree before bootstrap');
  if (preexisting.remoteTracking !== 'missing') {
    errors.push('remote-tracking destination collision existed before bootstrap');
  }

  const fetch = evidence?.fetch ?? {};
  const exactFetch =
    fetch.remote === 'origin' &&
    fetch.sourceRef === fullRef &&
    fetch.destinationRef === trackingRef &&
    fetch.tags === false &&
    fetch.force === false &&
    fetch.writeFetchHead === false &&
    fetch.recurseSubmodules === false &&
    fetch.autoMaintenance === false;
  if (!exactFetch) errors.push('fetch contract is not the exact no-tag non-force single-ref operation');
  if (fetch.status !== 'succeeded') errors.push(`fetch result is ${fetch.status ?? 'unavailable'}`);
  if (evidence?.pushCount !== 0) errors.push('bootstrap must perform zero pushes');

  const directHead = evidence?.directRefAfter?.sha;
  const surfaces = [
    commit,
    directHead,
    evidence?.remoteTrackingHead,
    evidence?.localBranchHead,
    evidence?.claimWorktree?.head,
  ];
  if (surfaces.some((sha) => !FULL_COMMIT.test(sha ?? '')) || new Set(surfaces).size !== 1) {
    errors.push('five SHA surfaces do not agree');
  }
  if (evidence?.branchRemote !== 'origin' || evidence?.branchMerge !== fullRef) {
    errors.push('tracking configuration is not exact');
  }

  const worktree = evidence?.claimWorktree;
  if (!worktree) errors.push('claim worktree is missing');
  else {
    if (worktree.branch !== fullRef || worktree.symbolicRef !== fullRef) {
      errors.push('claim worktree is not on the exact symbolic branch');
    }
    if (worktree.countForBranch !== 1 || worktree.locked || worktree.prunable) {
      errors.push('claim branch worktree registration is ambiguous');
    }
    if (!worktree.clean) errors.push('claim worktree is dirty');
  }

  const integrationBefore = evidence?.integrationBefore;
  const integrationAfter = evidence?.integrationAfter;
  if (!integrationBefore || !integrationAfter) errors.push('integration checkout evidence is incomplete');
  else if (JSON.stringify(integrationBefore) !== JSON.stringify(integrationAfter)) {
    errors.push('integration checkout changed during bootstrap');
  } else if (
    integrationAfter.symbolicRef !== 'refs/heads/main' ||
    !FULL_COMMIT.test(integrationAfter.head ?? '') ||
    !integrationAfter.clean ||
    integrationAfter.inProgress
  ) {
    errors.push('integration checkout is not a clean symbolic main checkout');
  }

  return { valid: errors.length === 0, status: errors.length === 0 ? 'matched' : 'question', errors };
}
const UNCLAIMED_VALUES = new Set(["", "missing", "none", "unclaimed"]);
const STATE_LABELS = new Set([
  "work:proposed",
  "work:ready",
  "work:active",
  "work:blocked",
  "work:review",
  "work:done",
  "work:abandoned",
]);

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function structuredFields(body, names = [...PORTABLE_CLAIM_FIELDS, ...CHECKPOINT_FIELDS]) {
  const { fields, duplicates } = structuredRecord(body, names);
  return { fields, duplicates };
}

export function claimField(body, name) {
  return structuredFields(body, [name]).fields[name] ?? "missing";
}

export function isoInstantMilliseconds(value) {
  return schemaIsoInstantMilliseconds(value);
}

export function deadlineStatus(value, nowMs = Date.now()) {
  if (typeof value !== "string" || UNCLAIMED_VALUES.has(value.trim().toLowerCase())) return "unknown";
  const deadline = isoInstantMilliseconds(value);
  if (deadline === undefined) return "invalid";
  return deadline < nowMs ? "overdue" : "current";
}

export function staleClaimReason(state, checkIn, nowMs = Date.now()) {
  if (!NONTERMINAL_CLAIMED_STATES.has(state)) return undefined;
  const status = deadlineStatus(checkIn, nowMs);
  return status === "current" ? undefined : `check-in ${status}`;
}

export function parseDependencies(value) {
  if (typeof value !== "string") return { status: "unknown", numbers: [] };
  if (UNCLAIMED_VALUES.has(value.trim().toLowerCase())) {
    return { status: value.trim().toLowerCase() === "none" ? "clear" : "unknown", numbers: [] };
  }

  const tokens = value
    .split(/[\s,]+/)
    .map((token) => token.trim())
    .filter(Boolean);
  if (tokens.length === 0 || tokens.some((token) => !/^#\d+$/.test(token))) {
    return { status: "invalid", numbers: [] };
  }
  return { status: "declared", numbers: [...new Set(tokens.map((token) => Number(token.slice(1))))] };
}

export function parseReconciledClaimCommentIds(value) {
  if (value === undefined || value === "missing" || value === "none") {
    return { status: "none", ids: [], problems: [] };
  }
  if (typeof value !== "string" || !/^[1-9]\d*(?:, [1-9]\d*)*$/.test(value)) {
    return {
      status: "invalid",
      ids: [],
      problems: [{ code: "malformed-resolution", message: "expected none or comma-space-separated positive comment IDs" }],
    };
  }

  const ids = value.split(", ").map(Number);
  if (ids.some((id) => !Number.isSafeInteger(id))) {
    return {
      status: "invalid",
      ids,
      problems: [{ code: "unsafe-resolution-id", message: "comment IDs must be safe positive integers" }],
    };
  }
  if (new Set(ids).size !== ids.length) {
    return {
      status: "invalid",
      ids,
      problems: [{ code: "duplicate-resolution-id", message: "comment IDs may appear only once" }],
    };
  }
  return { status: "declared", ids, problems: [] };
}

export function hasClaimSignal(body) {
  if (typeof body !== "string") throw new TypeError("comment body must be a string");
  if (PORTABLE_CLAIM_FIELDS.some((name) => new RegExp(`^${escapeRegExp(name)}:`, "m").test(body))) {
    return true;
  }
  return /\bclaim(?:ed|ing)?\b|\bcheck[- ]?in\b|\bcheckpoint\b|\b(?:started|starting|began|beginning)\s+(?:the\s+)?work\b|\b(?:take|taking|took|assume|assuming)\s+ownership\b/i.test(
    body,
  );
}

function meaningful(value) {
  return typeof value === "string" && !UNCLAIMED_VALUES.has(value.trim().toLowerCase());
}

export function evaluateClaimCommentResolution(
  record,
  fields,
  comments,
  { claimAgent = fields['Claim-Agent'] } = {},
) {
  const raw = fields[CLAIM_COMMENT_RESOLUTION_FIELD] ?? "missing";
  const parsed = parseReconciledClaimCommentIds(raw);
  const problems = [...parsed.problems];
  if (record.duplicates.includes(CLAIM_COMMENT_RESOLUTION_FIELD)) {
    problems.push({
      code: "duplicate-resolution-field",
      message: `${CLAIM_COMMENT_RESOLUTION_FIELD} must occur exactly once at most`,
    });
  }

  const integrationOwner = fields["Integration-Owner"] ?? "missing";
  if (parsed.ids.length > 0 && !meaningful(integrationOwner)) {
    problems.push({
      code: "resolution-authority-unknown",
      message: "a declared Integration-Owner is required to authorize reconciliation",
    });
  }
  if (parsed.ids.length > 0 && integrationOwner === claimAgent) {
    problems.push({
      code: "claimant-self-resolution",
      message: "the current claimant cannot also be the reconciliation authority",
    });
  }

  const commentById = new Map(comments.map((comment) => [comment.id, comment]));
  for (const id of parsed.ids) {
    const comment = commentById.get(id);
    if (!comment) {
      problems.push({ code: "unknown-resolution-id", commentId: id, message: `comment ${id} does not exist` });
    } else if (!hasClaimSignal(comment.body)) {
      problems.push({
        code: "non-claim-resolution-id",
        commentId: id,
        message: `comment ${id} is not claim-bearing`,
      });
    } else if (isoInstantMilliseconds(comment.updatedAt) !== isoInstantMilliseconds(comment.createdAt)) {
      problems.push({
        code: "edited-resolution-id",
        commentId: id,
        message: `comment ${id} was edited and cannot be reconciled by ID`,
      });
    }
  }

  const valid = problems.length === 0;
  return {
    field: CLAIM_COMMENT_RESOLUTION_FIELD,
    raw,
    status: valid ? (parsed.status === "declared" ? "valid" : "none") : "invalid",
    authority: "maintainer-or-integration-owner",
    integrationOwner,
    requestedIds: parsed.ids,
    reconciledIds: valid ? parsed.ids : [],
    problems,
  };
}

export function evaluateClaimCommentHistory(
  record,
  fields,
  comments,
  { claimAgent } = {},
) {
  const resolution = evaluateClaimCommentResolution(record, fields, comments, { claimAgent });
  const claimComments = comments.filter((comment) => hasClaimSignal(comment.body));
  const reconciledIds = new Set(resolution.reconciledIds);
  return {
    resolution,
    claimComments,
    unresolvedClaimComments: claimComments.filter(({ id }) => !reconciledIds.has(id)),
    unreconciledComments: comments.filter(({ id }) => !reconciledIds.has(id)),
  };
}

export function evaluateClaimCommentHistoryForBody(body, comments, { claimAgent } = {}) {
  const record = structuredFields(body, [
    ...ALL_PORTABLE_CLAIM_FIELDS,
    ...CHECKPOINT_EVIDENCE_FIELDS,
    'Integration-Owner',
    CLAIM_COMMENT_RESOLUTION_FIELD,
  ]);
  return evaluateClaimCommentHistory(record, record.fields, comments, { claimAgent });
}

function latestComment(comments) {
  if (comments.length === 0) return null;
  return [...comments].sort((left, right) => {
    const time = isoInstantMilliseconds(left.createdAt) - isoInstantMilliseconds(right.createdAt);
    return time || left.id - right.id;
  }).at(-1);
}

function commentEvidence(comment) {
  if (!comment) return null;
  const record = structuredFields(comment.body, ALL_COMMENT_FIELDS);
  return {
    id: comment.id,
    author: comment.author,
    createdAt: comment.createdAt,
    updatedAt: comment.updatedAt,
    claimSignal: hasClaimSignal(comment.body),
    structuredFields: record.fields,
    duplicateFields: record.duplicates,
  };
}

function question(code, message) {
  return { code, message };
}

function stateLabels(labels) {
  return labels.filter((label) => STATE_LABELS.has(label));
}

function evaluateDependencies(value, issueByNumber, issueNumber) {
  const parsed = parseDependencies(value);
  const result = {
    declared: parsed.numbers,
    satisfied: [],
    blocked: [],
    unknown: [],
    status: "clear",
  };

  if (parsed.status === "unknown" || parsed.status === "invalid") {
    result.status = "unknown";
    return result;
  }

  for (const dependencyNumber of parsed.numbers) {
    const dependency = issueByNumber.get(dependencyNumber);
    if (dependencyNumber === issueNumber || !dependency) {
      result.unknown.push(dependencyNumber);
      continue;
    }
    if (dependency.state !== "closed") {
      result.blocked.push(dependencyNumber);
      continue;
    }
    const dependencySchema = validateWorkItemBody(dependency.body);
    const dependencyRecord = structuredFields(dependency.body, ['Claim-State']);
    const dependencyState = dependencyRecord.fields['Claim-State'];
    const dependencyWorkLabels = dependency.labels.filter((label) => label.startsWith('work:'));
    if (
      dependencySchema.valid &&
      dependencyRecord.duplicates.length === 0 &&
      dependencyState === 'done' &&
      dependencyWorkLabels.length === 1 &&
      dependencyWorkLabels[0] === 'work:done'
    ) {
      result.satisfied.push(dependencyNumber);
    } else {
      result.unknown.push(dependencyNumber);
    }
  }

  if (result.unknown.length > 0) result.status = "unknown";
  else if (result.blocked.length > 0) result.status = "blocked";
  return result;
}

function evaluateLocalEvidence(fields, local, version = '1') {
  if (version === '2') return { status: 'not-applicable', questions: [] };
  const branch = fields['Claim-Branch'];
  const worktree = fields["Claim-Worktree"];
  if (!meaningful(branch) || !meaningful(worktree)) return { status: "not-applicable", questions: [] };

  const questions = [];
  const pathMatch = local.worktrees.find((entry) => entry.path === worktree);
  const branchWorktrees = local.worktrees.filter((entry) => entry.branch === branch);
  const localBranch = local.branches.some((entry) => entry.name === branch);

  const relevantWorktrees = [...new Set([pathMatch, ...branchWorktrees].filter(Boolean))];
  for (const entry of relevantWorktrees) {
    if (entry.locked) {
      questions.push(
        question(
          "worktree-locked",
          `locally observed worktree ${entry.path} is locked${entry.locked === true ? "" : `: ${entry.locked}`}`,
        ),
      );
    }
    if (entry.prunable) {
      questions.push(
        question(
          "worktree-prunable",
          `locally observed worktree ${entry.path} is prunable${entry.prunable === true ? "" : `: ${entry.prunable}`}`,
        ),
      );
    }
  }

  if (pathMatch && pathMatch.branch !== branch) {
    questions.push(
      question(
        "worktree-branch-mismatch",
        `registered worktree ${worktree} contains ${pathMatch.branch ?? "a detached HEAD"}, not ${branch}`,
      ),
    );
  }
  for (const entry of branchWorktrees) {
    if (entry.path !== worktree) {
      questions.push(
        question(
          "branch-worktree-mismatch",
          `registered branch ${branch} is checked out at ${entry.path}, not ${worktree}`,
        ),
      );
    }
  }
  if (localBranch && branchWorktrees.length === 0 && !pathMatch) {
    questions.push(
      question(
        "claimed-worktree-not-local",
        `registered branch ${branch} exists locally but registered worktree ${worktree} is not present`,
      ),
    );
  }

  const observed = Boolean(pathMatch || localBranch || branchWorktrees.length > 0);
  return {
    status: questions.length > 0 ? "contradiction" : observed ? "matched" : "not-observed",
    questions,
  };
}

function classify(item) {
  if (item.questions.length > 0 || item.dependencies.status === "unknown") return "question";
  if (item.claimState === "ready" && item.dependencies.status === "clear") return "candidate";
  if (item.dependencies.status === "blocked" || item.claimState === "blocked") return "blocked";
  if (item.claimState === "active") return "claimed";
  if (item.claimState === "review") return "review";
  if (item.claimState === "proposed") return "proposed";
  return item.claimState || "question";
}

function analyzeWorkItem(issue, comments, issueByNumber, local, nowMs) {
  const registrySchema = validateWorkItemBody(issue.body);
  const portableClaimFields = claimFieldsForVersion(registrySchema.version);
  const ownershipFields = ownershipFieldsForVersion(registrySchema.version);
  const commentRecordFields =
    registrySchema.version === '2'
      ? [...portableClaimFields, ...CHECKPOINT_EVIDENCE_FIELDS]
      : [
          ...portableClaimFields.filter((name) => name !== 'Claimed-At'),
          'Checkpoint-At',
          'Checkpoint-Commit',
        ];
  const record = structuredFields(issue.body, [
    ...ALL_PORTABLE_CLAIM_FIELDS,
    ...CHECKPOINT_EVIDENCE_FIELDS,
    'Parent-Plan',
    'Scope-Paths',
    'Depends-On',
    'Dependency-Notes',
    'Integration-Owner',
    CLAIM_COMMENT_RESOLUTION_FIELD,
  ]);
  const fields = record.fields;
  const claimState = (fields['Claim-State'] ?? 'missing').toLowerCase();
  const questions = record.duplicates.map((name) =>
    question('duplicate-body-field', `issue body repeats structured field ${name}`),
  );
  if (!registrySchema.valid) {
    questions.push(
      ...registrySchema.errors.map((error) =>
        question(
          error.code === 'unsupported-schema-version'
            ? 'unsupported-registry-schema'
            : 'invalid-registry-schema',
          `${error.field}: ${error.message}`,
        ),
      ),
    );
  }
  const labels = stateLabels(issue.labels);

  if (labels.length !== 1 || labels[0] !== `work:${claimState}`) {
    questions.push(
      question(
        "body-label-state-mismatch",
        `Claim-State ${claimState} does not match exactly one state label (found ${labels.join(", ") || "none"})`,
      ),
    );
  }

  const hasOwnershipEvidence = ownershipFields.some((name) => meaningful(fields[name]));
  const claimExpected =
    ['active', 'review'].includes(claimState) ||
    (registrySchema.version === '1' && claimState === 'blocked' && hasOwnershipEvidence);
  if (registrySchema.version === '1') {
    if (claimExpected) {
      const missingClaimFields = portableClaimFields
        .slice(1)
        .filter((name) => !meaningful(fields[name]));
      if (missingClaimFields.length > 0) {
        questions.push(
          question(
            'incomplete-claim',
            `${missingClaimFields.join(', ')} missing or unclaimed for ${claimState} work`,
          ),
        );
      }
    } else if (['proposed', 'ready'].includes(claimState)) {
      const unexpectedClaimFields = portableClaimFields
        .slice(1)
        .filter((name) => meaningful(fields[name]));
      if (unexpectedClaimFields.length > 0) {
        questions.push(
          question(
            'unexpected-claim-evidence',
            `${unexpectedClaimFields.join(', ')} retain claim or deadline evidence while Claim-State is ${claimState}`,
          ),
        );
      }
    }
  }

  const checkIn = fields['Check-In-By'] ?? 'missing';
  const checkInStatus = deadlineStatus(checkIn, nowMs);
  const staleReason = claimExpected ? staleClaimReason(claimState, checkIn, nowMs) : undefined;
  if (staleReason) {
    questions.push(question(`check-in-${checkInStatus}`, `${staleReason}; do not infer abandonment or takeover authority`));
  }

  const latest = latestComment(comments);
  const claimCommentHistory = evaluateClaimCommentHistory(record, fields, comments);
  const { claimComments, unresolvedClaimComments } = claimCommentHistory;
  const claimCommentResolution = claimCommentHistory.resolution;
  if (claimCommentResolution.status === "invalid") {
    questions.push(
      question(
        "claim-comment-resolution-invalid",
        claimCommentResolution.problems.map(({ message }) => message).join("; "),
      ),
    );
  }
  const unresolvedIds = new Set(unresolvedClaimComments.map(({ id }) => id));
  const claimCommentEvidence = claimComments.map((comment) => ({
    ...commentEvidence(comment),
    reconciliation: unresolvedIds.has(comment.id) ? "unresolved" : "reconciled",
  }));
  const unresolvedClaimCommentEvidence = claimCommentEvidence.filter(
    ({ reconciliation }) => reconciliation === "unresolved",
  );
  const latestClaim = latestComment(claimComments);
  const latestClaimEvidence = commentEvidence(latestClaim);
  const latestUnresolvedClaim = latestComment(unresolvedClaimComments);
  const latestUnresolvedClaimEvidence = commentEvidence(latestUnresolvedClaim);
  const unstructuredClaimComments = unresolvedClaimCommentEvidence.filter(
    (evidence) => Object.keys(evidence.structuredFields).length === 0,
  );
  if (unstructuredClaimComments.length > 0) {
    questions.push(
      question(
        "unstructured-claim-comment",
        `unresolved claim/ownership comments ${unstructuredClaimComments.map(({ id }) => id).join(", ")} have no portable fields; do not infer ownership`,
      ),
    );
  }

  const editedClaimComments = unresolvedClaimComments.filter(
    (comment) => isoInstantMilliseconds(comment.updatedAt) !== isoInstantMilliseconds(comment.createdAt),
  );
  if (editedClaimComments.length > 0) {
    questions.push(
      question(
        "edited-claim-comment",
        `unresolved claim/ownership comments ${editedClaimComments.map(({ id }) => id).join(", ")} were edited; creation order cannot resolve their intent`,
      ),
    );
  }

  const competingClaimComments = unresolvedClaimCommentEvidence.filter((evidence) => {
    const commentState = evidence.structuredFields["Claim-State"];
    if (["done", "abandoned"].includes(commentState)) return false;
    return ownershipFields.some(
      (name) =>
        meaningful(evidence.structuredFields[name]) &&
        evidence.structuredFields[name] !== fields[name],
    );
  });
  if (competingClaimComments.length > 0) {
    questions.push(
      question(
        "competing-ownership-comment",
        `unresolved claim/ownership comments ${competingClaimComments.map(({ id }) => id).join(", ")} carry ownership fields that disagree with the body`,
      ),
    );
  }

  if (latestUnresolvedClaimEvidence) {
    const comparableCommentFields = Object.entries(
      latestUnresolvedClaimEvidence.structuredFields,
    ).filter(([name]) => commentRecordFields.includes(name));
    if (latestUnresolvedClaimEvidence.duplicateFields.length > 0) {
      questions.push(
        question(
          'duplicate-comment-field',
          `latest unresolved claim/checkpoint comment repeats ${latestUnresolvedClaimEvidence.duplicateFields.join(', ')}`,
        ),
      );
    }
    const checkpointValidation = validateCheckpointComment(
      latestUnresolvedClaim.body,
      registrySchema,
    );
    if (checkpointValidation.historicalContract) {
      questions.push(
        question(
          'partial-schema-transition',
          'the body is v2 but its latest checkpoint remains immutable v1 evidence; resume the supported write by appending the matching v2 checkpoint',
        ),
      );
    } else if (checkpointValidation.applicable && !checkpointValidation.valid) {
      questions.push(
        question(
          'invalid-checkpoint-evidence',
          checkpointValidation.errors.map(({ message }) => message).join('; '),
        ),
      );
    }
    if (!checkpointValidation.historicalContract && comparableCommentFields.length > 0) {
      const missingCommentFields = commentRecordFields.filter(
        (name) => latestUnresolvedClaimEvidence.structuredFields[name] === undefined,
      );
      if (missingCommentFields.length > 0) {
        questions.push(
          question(
            "incomplete-claim-comment",
            `latest unresolved claim/checkpoint comment omits ${missingCommentFields.join(", ")}`,
          ),
        );
      }
      for (const [name, value] of comparableCommentFields) {
        if ((fields[name] ?? "missing") !== value) {
          questions.push(
            question(
              "body-comment-mismatch",
              `latest unresolved claim/checkpoint comment says ${name}=${value}, body says ${fields[name] ?? "missing"}`,
            ),
          );
        }
      }
    }
  }

  if (["done", "abandoned"].includes(claimState) && issue.state === "open") {
    questions.push(
      question("terminal-work-open", `Claim-State is ${claimState} but the GitHub issue remains open`),
    );
  }

  const dependencies = evaluateDependencies(fields["Depends-On"] ?? "missing", issueByNumber, issue.number);
  if (dependencies.status === "unknown") {
    questions.push(
      question(
        "dependency-unknown",
        `Depends-On evidence is missing, malformed, self-referential, absent, or not closed as work:done`,
      ),
    );
  }

  const localEvidence = evaluateLocalEvidence(fields, local, registrySchema.version);
  questions.push(...localEvidence.questions);

  const item = {
    number: issue.number,
    title: issue.title,
    url: issue.url,
    githubState: issue.state,
    labels: issue.labels,
    updatedAt: issue.updatedAt,
    parentPlan: fields['Parent-Plan'] ?? 'missing',
    integrationOwner: fields['Integration-Owner'] ?? 'missing',
    registrySchema: {
      version: registrySchema.version,
      explicit: registrySchema.explicit,
      status: registrySchema.status,
      valid: registrySchema.valid,
      errors: registrySchema.errors,
    },
    scopePaths: registrySchema.normalized?.scopePaths ?? [],
    dependencyNotes: fields['Dependency-Notes'] ?? 'missing',
    claimState,
    claim: Object.fromEntries(
      portableClaimFields.map((name) => [name, fields[name] ?? 'missing']),
    ),
    checkpoint: Object.fromEntries(
      (registrySchema.version === '2' ? CHECKPOINT_EVIDENCE_FIELDS : CHECKPOINT_FIELDS).map(
        (name) => [name, fields[name] ?? 'missing'],
      ),
    ),
    deadline: { value: checkIn, status: checkInStatus },
    waiting: {
      value: fields['Waiting-Since'] ?? 'missing',
      since:
        isoInstantMilliseconds(fields['Waiting-Since']) === undefined
          ? null
          : fields['Waiting-Since'],
    },
    dependencies,
    latestComment: commentEvidence(latest),
    latestClaimComment: latestClaimEvidence,
    latestUnresolvedClaimComment: latestUnresolvedClaimEvidence,
    claimComments: claimCommentEvidence,
    claimCommentResolution: {
      ...claimCommentResolution,
      unresolvedIds: unresolvedClaimCommentEvidence.map(({ id }) => id),
    },
    localEvidence: { status: localEvidence.status },
    questions,
    reconciliation: "consistent",
    triage: "question",
    candidateSafety: "not-established",
  };
  item.reconciliation = questions.length > 0 ? "question" : "consistent";
  item.triage = classify(item);
  return item;
}

export function isCoordinatedIssue(issue, comments = []) {
  if (issue.labels.some((label) => label === "work:plan" || STATE_LABELS.has(label))) return true;
  if (structuredFields(issue.body, ["Claim-State"]).fields["Claim-State"] !== undefined) return true;
  return comments.some((comment) => hasClaimSignal(comment.body));
}

function addRemoteQuestion(item, code, message) {
  item.questions.push(question(code, message));
  item.reconciliation = 'question';
  item.triage = 'question';
}

export function reconcileRemoteClaims({
  issues,
  workItems,
  reservedRefs = [],
  commentsByIssue = new Map(),
  local = { branches: [], worktrees: [] },
  claimRelationships = new Map(),
  claimLifecycles = new Map(),
  nowMs = Date.now(),
}) {
  const issueByNumber = new Map(issues.map((issue) => [issue.number, issue]));
  const analyzedByNumber = new Map(workItems.map((item) => [item.number, item]));
  const openWorkItemNumbers = new Set(workItems.map((item) => item.number));
  const refsByIssue = new Map();
  const remoteRefEvidence = [];
  const questions = [];

  for (const remote of reservedRefs) {
    const parsed = parseReservedClaimRef(remote.ref);
    const evidence = {
      ...remote,
      mapping: parsed,
      disposition: 'question',
      currentOwnership: false,
      lifecycleMonitoring: false,
    };
    remoteRefEvidence.push(evidence);
    if (remote.objectType !== 'commit' || !/^[0-9a-f]{40}$/.test(remote.sha ?? '')) {
      questions.push(
        question(
          'malformed-claim-ref-object',
          `reserved ref ${remote.ref} must identify one full commit object`,
        ),
      );
      continue;
    }
    if (parsed.status !== 'supported') {
      questions.push(
        question(
          parsed.status === 'unsupported'
            ? 'unsupported-claim-ref-version'
            : 'malformed-claim-ref',
          `reserved ref ${remote.ref} is ${parsed.status}`,
        ),
      );
      continue;
    }
    evidence.issueNumber = parsed.issueNumber;
    refsByIssue.set(parsed.issueNumber, [...(refsByIssue.get(parsed.issueNumber) ?? []), evidence]);
    const issue = issueByNumber.get(parsed.issueNumber);
    if (!issue) {
      questions.push(
        question('claim-ref-issue-missing', `${remote.ref} maps to missing issue #${parsed.issueNumber}`),
      );
      continue;
    }
    const schema = validateWorkItemBody(issue.body);
    const fields = schema.fields ?? {};
    const state = fields['Claim-State'];
    const branch = fields['Claim-Branch'];
    if (!schema.valid) {
      evidence.disposition = 'question';
      questions.push(
        question('claim-ref-issue-malformed', `${remote.ref} maps to a malformed issue record`),
      );
    } else if (['proposed', 'ready'].includes(state)) {
      Object.assign(evidence, {
        disposition: 'orphaned',
        currentOwnership: false,
        lifecycleMonitoring: false,
      });
      questions.push(
        question(
          'orphaned-claim-ref',
          `${remote.ref} exists while issue #${parsed.issueNumber} is ${state}; do not adopt or release it automatically`,
        ),
      );
    } else if (
      (state === 'blocked' && branch === 'unclaimed') ||
      (['done', 'abandoned'].includes(state) &&
        (branch === 'unclaimed' || branch === parsed.branch))
    ) {
      Object.assign(evidence, {
        disposition: 'preserved-non-ownership',
        currentOwnership: false,
        lifecycleMonitoring: false,
      });
    } else if (branch !== parsed.branch) {
      evidence.disposition = 'question';
      questions.push(
        question(
          'claim-ref-branch-mismatch',
          `${remote.ref} disagrees with issue #${parsed.issueNumber} Claim-Branch ${branch}`,
        ),
      );
    } else {
      Object.assign(evidence, {
        disposition: 'current-agent-claim-evidence',
        currentOwnership: true,
        lifecycleMonitoring: true,
      });
    }
  }

  for (const [issueNumber] of refsByIssue) {
    const issue = issueByNumber.get(issueNumber);
    if (!issue || issue.state !== 'closed') continue;
    const item = analyzeWorkItem(
      issue,
      commentsByIssue.get(issueNumber) ?? [],
      issueByNumber,
      local,
      nowMs,
    );
    analyzedByNumber.set(issueNumber, item);
    if (!['done', 'abandoned'].includes(item.claimState)) {
      item.questions.push(
        question(
          'closed-claim-nonterminal',
          `closed issue #${issueNumber} mapped by a reserved ref is ${item.claimState}, not terminal`,
        ),
      );
    }
    for (const entry of item.questions) questions.push({ issueNumber, ...entry });
  }

  for (const item of [...analyzedByNumber.values()].filter(
    ({ claimState, registrySchema }) =>
      registrySchema?.version === '2' && ['blocked', 'done', 'abandoned'].includes(claimState),
  )) {
    const matchingRefs = (refsByIssue.get(item.number) ?? []).filter(
      ({ disposition }) => disposition === 'preserved-non-ownership',
    );
    if (matchingRefs.length === 1) {
      item.remoteClaim = {
        disposition: 'preserved-non-ownership',
        expectedBranch: claimBranchForIssue(item.number),
        matchingRefs,
        currentOwnership: false,
        lifecycle: { status: 'not-applicable', monitoring: false },
      };
    } else if (matchingRefs.length > 1) {
      const code = 'duplicate-derived-claim-ref';
      const message = `preserved claim evidence for #${item.number} requires at most one exact derived remote ref`;
      addRemoteQuestion(item, code, message);
      if (!openWorkItemNumbers.has(item.number)) questions.push({ issueNumber: item.number, ...question(code, message) });
    }
  }

  for (const item of [...analyzedByNumber.values()].filter(
    ({ claimState, registrySchema }) =>
      registrySchema?.version === '2' && ['active', 'review'].includes(claimState),
  )) {
    const branch = item.claim['Claim-Branch'];
    const validation = validateClaimBranch({
      issueNumber: item.number,
      claimState: item.claimState,
      branch,
    });
    item.remoteClaim = {
      branchStatus: validation.status,
      expectedBranch: validation.expected ?? null,
      matchingRefs: refsByIssue.get(item.number) ?? [],
    };
    if (validation.status === 'invalid') {
      addRemoteQuestion(
        item,
        validation.code,
        `Claim-Branch ${branch} is invalid for #${item.number}; expected ${validation.expected}`,
      );
    } else if (validation.status === 'derived' && item.remoteClaim.matchingRefs.length !== 1) {
      addRemoteQuestion(
        item,
        item.remoteClaim.matchingRefs.length === 0
          ? 'derived-claim-ref-missing'
          : 'duplicate-derived-claim-ref',
        `derived claim #${item.number} requires exactly one matching remote ref`,
      );
    }

    if (validation.status === 'derived') {
      const remoteHead =
        item.remoteClaim.matchingRefs.length === 0
          ? null
          : item.remoteClaim.matchingRefs.length === 1
            ? item.remoteClaim.matchingRefs[0].sha
            : undefined;
      const relationship = claimRelationships.get(item.number) ?? 'unavailable';
      const suppliedLifecycle = claimLifecycles.get(item.number);
      const lifecycle =
        suppliedLifecycle ??
        {
          status: classifyRemoteClaimLifecycle({
            checkpointCommit: item.checkpoint['Checkpoint-Commit'],
            remoteHead,
            relationship,
          }),
          checkpointCommit: item.checkpoint['Checkpoint-Commit'],
          remoteHead: remoteHead ?? null,
          reason: null,
        };
      item.remoteClaim.lifecycle = lifecycle;
      if (['remote-ahead', 'missing-branch', 'divergence', 'unavailable'].includes(lifecycle.status)) {
        addRemoteQuestion(
          item,
          `claim-lifecycle-${lifecycle.status}`,
          `checkpoint versus exact derived remote ref lifecycle is ${lifecycle.status}${lifecycle.reason ? ` (${lifecycle.reason})` : ''}; preserve evidence and do not repair automatically`,
        );
      }
    }
  }

  const bootstrap = analyzedByNumber.get(BOOTSTRAP_ISSUE);
  if (
    bootstrap?.registrySchema?.version === '2' &&
    ['active', 'review'].includes(bootstrap.claimState) &&
    bootstrap.claim['Claim-Branch'] === BOOTSTRAP_BRANCH
  ) {
    const rolloutStates = new Map(
      issues.map((issue) => [
        issue.number,
        validateWorkItemBody(issue.body).fields?.['Claim-State'],
      ]),
    );
    for (const item of workItems) {
      if (!rolloutStates.has(item.number)) rolloutStates.set(item.number, item.claimState);
    }
    for (const [issueNumber, state] of rolloutStates) {
      if (issueNumber === BOOTSTRAP_ISSUE || !['active', 'review'].includes(state)) continue;
      const message = `#${issueNumber} is agent-owned while the #42 bootstrap claim is active`;
      const competing = analyzedByNumber.get(issueNumber);
      if (competing) {
        addRemoteQuestion(competing, 'claim-primitive-rollout-blocked', message);
      }
      if (!openWorkItemNumbers.has(issueNumber)) {
        questions.push({
          issueNumber,
          ...question('claim-primitive-rollout-blocked', message),
        });
      }
      addRemoteQuestion(
        bootstrap,
        'claim-primitive-rollout-blocked',
        `#42 cannot activate while #${issueNumber} is active or in review`,
      );
    }
  }

  return {
    refs: remoteRefEvidence,
    questions,
  };
}

function canonicalUtcInstant(value) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value ?? '')) return false;
  const milliseconds = isoInstantMilliseconds(value);
  return milliseconds !== undefined && new Date(milliseconds).toISOString() === value;
}

function parseIntegrationHoldComment(comment) {
  const lines = comment.body.split('\n');
  const headingIndexes = lines
    .map((line, index) => (line === INTEGRATION_HOLD_HEADING ? index : -1))
    .filter((index) => index >= 0);
  const record = structuredFields(comment.body, INTEGRATION_HOLD_FIELDS);
  const errors = [];
  if (headingIndexes.length !== 1) errors.push('the exact integration-hold heading must occur once');
  for (const field of INTEGRATION_HOLD_FIELDS) {
    if (record.fields[field] === undefined) errors.push(`${field} is required`);
  }
  for (const field of record.duplicates) errors.push(`${field} must occur once`);
  const fieldIndexes = INTEGRATION_HOLD_FIELDS.map((field) =>
    lines.findIndex((line) => line.startsWith(`${field}:`)),
  );
  if (
    headingIndexes.length === 1 &&
    fieldIndexes.every((index) => index >= 0) &&
    (fieldIndexes[0] <= headingIndexes[0] ||
      fieldIndexes.some((index, position) => position > 0 && index <= fieldIndexes[position - 1]))
  ) {
    errors.push('integration-hold fields must follow the heading in exact order');
  }
  const unknownFields = lines.filter(
    (line) =>
      line.startsWith('Integration-Hold-') &&
      !INTEGRATION_HOLD_FIELDS.some((field) => line.startsWith(`${field}:`)),
  );
  if (unknownFields.length > 0) errors.push('unknown integration-hold fields are not permitted');
  if (errors.length > 0) return { valid: false, errors };

  const fields = record.fields;
  const action = fields['Integration-Hold-Action'];
  const pr = fields['Integration-Hold-PR'];
  const head = fields['Integration-Hold-Head'];
  const base = fields['Integration-Hold-Base'];
  const attempt = fields['Integration-Hold-Attempt'];
  const principal = fields['Integration-Hold-Principal'];
  const acquiredAt = fields['Integration-Hold-Acquired-At'];
  const eventAt = fields['Integration-Hold-Event-At'];
  const outcome = fields['Integration-Hold-Outcome'];
  const holdId = fields['Integration-Hold-ID'];
  const scratchBranch = fields['Integration-Hold-Scratch-Branch'];

  if (fields['Integration-Hold-Evidence-Version'] !== '1') errors.push('evidence version must be 1');
  if (!['acquire', 'release'].includes(action)) errors.push('action must be acquire or release');
  if (!/^[1-9]\d*$/.test(pr) || !Number.isSafeInteger(Number(pr))) {
    errors.push('PR must be a canonical positive safe integer');
  }
  if (!FULL_COMMIT.test(head)) errors.push('head must be one lowercase full commit');
  if (!FULL_COMMIT.test(base)) errors.push('base must be one lowercase full commit');
  if (!/^[1-9]\d*$/.test(attempt) || !Number.isSafeInteger(Number(attempt))) {
    errors.push('attempt must be a canonical positive safe integer');
  }
  if (!/^[A-Za-z\d](?:[A-Za-z\d-]{0,37}[A-Za-z\d])?$/.test(principal)) {
    errors.push('principal must be a GitHub login');
  }
  if (comment.author !== principal) errors.push('GitHub author must equal the recorded principal');
  if (isoInstantMilliseconds(comment.updatedAt) !== isoInstantMilliseconds(comment.createdAt)) {
    errors.push('integration-hold evidence must be unedited');
  }
  if (!canonicalUtcInstant(acquiredAt)) errors.push('acquired timestamp must be canonical UTC');
  if (!canonicalUtcInstant(eventAt)) errors.push('event timestamp must be canonical UTC');
  if (canonicalUtcInstant(acquiredAt) && canonicalUtcInstant(eventAt) && Date.parse(eventAt) < Date.parse(acquiredAt)) {
    errors.push('event timestamp cannot precede acquisition');
  }

  const expectedId = `pr-${pr}-head-${head}-base-${base}-attempt-${attempt}`;
  if (holdId !== expectedId) errors.push('hold ID must canonically include PR, full head, full base, and attempt');
  const expectedScratch = `test/integration-pr-${pr}-base-${base.slice(0, 12)}-attempt-${attempt}`;
  if (scratchBranch !== expectedScratch) errors.push('scratch branch does not match the canonical convention');
  if (action === 'acquire' && eventAt !== acquiredAt) {
    errors.push('acquisition event timestamp must equal acquired timestamp');
  }
  if (action === 'acquire' && outcome !== 'unclaimed') {
    errors.push('acquisition outcome must be unclaimed');
  }
  if (action === 'release' && !['integrated', 'aborted'].includes(outcome)) {
    errors.push('release outcome must be integrated or aborted');
  }

  return { valid: errors.length === 0, errors, fields, action, holdId };
}

export function evaluateIntegrationHolds(comments) {
  const evidence = [];
  const questions = [];
  for (const comment of comments.filter(({ body }) => {
    const lines = body.split('\n');
    return lines.includes(INTEGRATION_HOLD_HEADING) || lines.some((line) => line.startsWith('Integration-Hold-'));
  })) {
    const parsed = parseIntegrationHoldComment(comment);
    evidence.push({
      commentId: comment.id,
      author: comment.author,
      createdAt: comment.createdAt,
      updatedAt: comment.updatedAt,
      ...parsed,
    });
    if (!parsed.valid) {
      questions.push(
        question(
          'integration-hold-malformed',
          `comment ${comment.id}: ${parsed.errors.join('; ')}`,
        ),
      );
    }
  }

  const validEvidence = evidence
    .filter(({ valid }) => valid)
    .sort((left, right) =>
      isoInstantMilliseconds(left.createdAt) - isoInstantMilliseconds(right.createdAt) ||
      left.commentId - right.commentId,
    );
  const identityFields = [
    'Integration-Hold-Evidence-Version',
    'Integration-Hold-ID',
    'Integration-Hold-Principal',
    'Integration-Hold-PR',
    'Integration-Hold-Head',
    'Integration-Hold-Base',
    'Integration-Hold-Attempt',
    'Integration-Hold-Scratch-Branch',
    'Integration-Hold-Acquired-At',
  ];
  const seenAcquisitions = new Set();
  const integratedSequences = new Set();
  const latestAttemptByPr = new Map();
  const latestReleaseEventByPr = new Map();
  let active = null;
  for (const entry of validEvidence) {
    const sequence = [
      entry.fields['Integration-Hold-PR'],
      entry.fields['Integration-Hold-Head'],
      entry.fields['Integration-Hold-Base'],
    ].join(':');
    if (entry.action === 'acquire') {
      const pr = entry.fields['Integration-Hold-PR'];
      const attempt = Number(entry.fields['Integration-Hold-Attempt']);
      const previousAttempt = latestAttemptByPr.get(pr);
      const previousReleaseEvent = latestReleaseEventByPr.get(pr);
      if (previousAttempt !== undefined && attempt <= previousAttempt) {
        questions.push(
          question(
            'integration-hold-ambiguous',
            `${entry.holdId} does not increase the prior attempt ${previousAttempt}`,
          ),
        );
      }
      if (
        previousReleaseEvent &&
        Date.parse(entry.fields['Integration-Hold-Acquired-At']) < Date.parse(previousReleaseEvent)
      ) {
        questions.push(
          question(
            'integration-hold-ambiguous',
            `${entry.holdId} acquisition timestamp precedes the prior release event`,
          ),
        );
      }
      latestAttemptByPr.set(pr, Math.max(previousAttempt ?? 0, attempt));
      if (seenAcquisitions.has(entry.holdId)) {
        questions.push(
          question('integration-hold-ambiguous', `${entry.holdId} acquisition is reused`),
        );
      }
      seenAcquisitions.add(entry.holdId);
      if (integratedSequences.has(sequence)) {
        questions.push(
          question(
            'integration-hold-ambiguous',
            `${entry.holdId} reuses a PR/head/base sequence after an integrated release`,
          ),
        );
      }
      if (active) {
        questions.push(
          question(
            'integration-hold-overlap',
            `${entry.holdId} was acquired while ${active.holdId} remained unmatched`,
          ),
        );
      } else {
        active = entry;
      }
      continue;
    }

    if (!active) {
      questions.push(
        question('integration-hold-ambiguous', `${entry.holdId} release has no unmatched acquisition`),
      );
      continue;
    }
    if (entry.holdId !== active.holdId) {
      questions.push(
        question(
          'integration-hold-ambiguous',
          `${entry.holdId} release does not match active ${active.holdId}`,
        ),
      );
      continue;
    }
    const mismatches = identityFields.filter(
      (field) => active.fields[field] !== entry.fields[field],
    );
    if (mismatches.length > 0) {
      questions.push(
        question(
          'integration-hold-ambiguous',
          `${entry.holdId} release disagrees on ${mismatches.join(', ')}`,
        ),
      );
      continue;
    }
    if (entry.fields['Integration-Hold-Outcome'] === 'integrated') {
      integratedSequences.add(sequence);
    }
    latestReleaseEventByPr.set(
      entry.fields['Integration-Hold-PR'],
      entry.fields['Integration-Hold-Event-At'],
    );
    active = null;
  }

  return {
    status: questions.length > 0 ? 'question' : active ? 'held' : 'clear',
    active: questions.length === 0 ? active : null,
    evidence,
    questions,
  };
}

export function analyzeCoordination({
  issues,
  commentsByIssue,
  local,
  reservedRefs = [],
  claimRelationships = new Map(),
  claimLifecycles = new Map(),
  nowMs = Date.now(),
}) {
  const issueByNumber = new Map(issues.map((issue) => [issue.number, issue]));
  const openIssues = issues.filter((issue) => issue.state === "open");
  const coordinated = openIssues.filter((issue) =>
    isCoordinatedIssue(issue, commentsByIssue.get(issue.number) ?? []),
  );
  const plans = coordinated
    .filter((issue) => issue.labels.includes('work:plan'))
    .map((issue) => {
      const schema = validatePlanBody(issue.body);
      const comments = commentsByIssue.get(issue.number) ?? [];
      const integrationHold = evaluateIntegrationHolds(comments);
      return {
        number: issue.number,
        title: issue.title,
        url: issue.url,
        updatedAt: issue.updatedAt,
        planState: claimField(issue.body, 'Plan-State'),
        integrationOwner: claimField(issue.body, 'Integration-Owner'),
        registrySchema: {
          version: schema.version,
          explicit: schema.explicit,
          status: schema.status,
          valid: schema.valid,
          errors: schema.errors,
        },
        integrationHold,
        questions: [
          ...(schema.valid
            ? []
            : schema.errors.map((error) =>
                question('invalid-plan-registry-schema', `${error.field}: ${error.message}`),
              )),
          ...integrationHold.questions,
        ],
        latestComment: commentEvidence(latestComment(comments)),
      };
    });
  const workItems = coordinated
    .filter((issue) => !issue.labels.includes("work:plan"))
    .map((issue) => analyzeWorkItem(issue, commentsByIssue.get(issue.number) ?? [], issueByNumber, local, nowMs));

  const remoteClaims = reconcileRemoteClaims({
    issues,
    workItems,
    reservedRefs,
    commentsByIssue,
    local,
    claimRelationships,
    claimLifecycles,
    nowMs,
  });

  for (const key of ["Claim-Branch", "Claim-Worktree"]) {
    const groups = new Map();
    for (const item of workItems.filter((candidate) => NONTERMINAL_CLAIMED_STATES.has(candidate.claimState))) {
      const value = item.claim[key];
      if (!meaningful(value)) continue;
      groups.set(value, [...(groups.get(value) ?? []), item]);
    }
    for (const [value, items] of groups) {
      if (items.length < 2) continue;
      for (const item of items) {
        item.questions.push(
          question(
            "duplicate-claim-locality",
            `${key} ${value} is registered by multiple nonterminal claims: ${items.map(({ number }) => `#${number}`).join(", ")}`,
          ),
        );
        item.reconciliation = "question";
        item.triage = "question";
      }
    }
  }

  return { plans, workItems, remoteClaims };
}
