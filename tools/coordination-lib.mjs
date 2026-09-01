import {
  BOOTSTRAP_BRANCH,
  BOOTSTRAP_ISSUE,
  parseReservedClaimRef,
  validateClaimBranch,
} from './coordination-claim.mjs';
import {
  CHECKPOINT_EVIDENCE_FIELDS,
  V1_PORTABLE_CLAIM_FIELDS,
  V2_PORTABLE_CLAIM_FIELDS,
  isoInstantMilliseconds as schemaIsoInstantMilliseconds,
  structuredRecord,
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

export const NONTERMINAL_CLAIMED_STATES = new Set(["active", "blocked", "review"]);
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

function evaluateClaimCommentResolution(record, fields, comments) {
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
  if (parsed.ids.length > 0 && integrationOwner === fields["Claim-Agent"]) {
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
  const claimComments = comments.filter((comment) => hasClaimSignal(comment.body));
  const claimCommentResolution = evaluateClaimCommentResolution(record, fields, comments);
  if (claimCommentResolution.status === "invalid") {
    questions.push(
      question(
        "claim-comment-resolution-invalid",
        claimCommentResolution.problems.map(({ message }) => message).join("; "),
      ),
    );
  }
  const reconciledIds = new Set(claimCommentResolution.reconciledIds);
  const claimCommentEvidence = claimComments.map((comment) => ({
    ...commentEvidence(comment),
    reconciliation: reconciledIds.has(comment.id) ? "reconciled" : "unresolved",
  }));
  const unresolvedClaimComments = claimComments.filter((comment) => !reconciledIds.has(comment.id));
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

export function reconcileRemoteClaims({ issues, workItems, reservedRefs = [] }) {
  const issueByNumber = new Map(issues.map((issue) => [issue.number, issue]));
  const itemByNumber = new Map(workItems.map((item) => [item.number, item]));
  const refsByIssue = new Map();
  const questions = [];

  for (const remote of reservedRefs) {
    const parsed = parseReservedClaimRef(remote.ref);
    const evidence = { ...remote, mapping: parsed };
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
      questions.push(
        question('claim-ref-issue-malformed', `${remote.ref} maps to a malformed issue record`),
      );
    } else if (['proposed', 'ready'].includes(state)) {
      questions.push(
        question(
          'orphaned-claim-ref',
          `${remote.ref} exists while issue #${parsed.issueNumber} is ${state}; do not adopt or release it automatically`,
        ),
      );
    } else if (branch !== parsed.branch) {
      questions.push(
        question(
          'claim-ref-branch-mismatch',
          `${remote.ref} disagrees with issue #${parsed.issueNumber} Claim-Branch ${branch}`,
        ),
      );
    }
  }

  for (const item of workItems.filter(
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
  }

  const bootstrap = workItems.find(
    (item) =>
      item.number === BOOTSTRAP_ISSUE &&
      item.registrySchema?.version === '2' &&
      ['active', 'review'].includes(item.claimState) &&
      item.claim['Claim-Branch'] === BOOTSTRAP_BRANCH,
  );
  if (bootstrap) {
    for (const competing of workItems.filter(
      (item) =>
        item.number !== BOOTSTRAP_ISSUE && ['active', 'review'].includes(item.claimState),
    )) {
      addRemoteQuestion(
        competing,
        'claim-primitive-rollout-blocked',
        `#${competing.number} is agent-owned while the #42 bootstrap claim is active`,
      );
      addRemoteQuestion(
        bootstrap,
        'claim-primitive-rollout-blocked',
        `#42 cannot activate while #${competing.number} is active or in review`,
      );
    }
  }

  return {
    refs: reservedRefs.map((remote) => ({ ...remote, mapping: parseReservedClaimRef(remote.ref) })),
    questions,
  };
}

export function analyzeCoordination({
  issues,
  commentsByIssue,
  local,
  reservedRefs = [],
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
        questions: schema.valid
          ? []
          : schema.errors.map((error) =>
              question('invalid-plan-registry-schema', `${error.field}: ${error.message}`),
            ),
        latestComment: commentEvidence(latestComment(commentsByIssue.get(issue.number) ?? [])),
      };
    });
  const workItems = coordinated
    .filter((issue) => !issue.labels.includes("work:plan"))
    .map((issue) => analyzeWorkItem(issue, commentsByIssue.get(issue.number) ?? [], issueByNumber, local, nowMs));

  const remoteClaims = reconcileRemoteClaims({ issues, workItems, reservedRefs });

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
