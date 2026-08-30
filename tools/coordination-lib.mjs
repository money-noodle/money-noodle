export const SCHEMA_VERSION = "1.0";

export const PORTABLE_CLAIM_FIELDS = [
  "Claim-State",
  "Claim-Harness",
  "Claim-Run-ID",
  "Claim-Agent",
  "Claim-Branch",
  "Claim-Worktree",
  "Claimed-At",
  "Check-In-By",
];

export const CHECKPOINT_FIELDS = [
  "Checkpoint-At",
  "Checkpoint-Commit",
  "Next-Action",
  "Blockers",
];

const COMMENT_RECORD_FIELDS = [
  "Claim-State",
  "Claim-Harness",
  "Claim-Run-ID",
  "Claim-Agent",
  "Claim-Branch",
  "Claim-Worktree",
  "Check-In-By",
  "Checkpoint-At",
  "Checkpoint-Commit",
];

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
  if (typeof body !== "string") throw new TypeError("structured record must be a string");

  const fields = {};
  const duplicates = [];
  for (const name of names) {
    const matches = [...body.matchAll(new RegExp(`^${escapeRegExp(name)}:\\s*(.*?)\\s*$`, "gm"))];
    if (matches.length > 1) duplicates.push(name);
    if (matches.length > 0) fields[name] = matches.at(-1)[1].trim();
  }
  return { fields, duplicates };
}

export function claimField(body, name) {
  return structuredFields(body, [name]).fields[name] ?? "missing";
}

export function deadlineStatus(value, nowMs = Date.now()) {
  if (typeof value !== "string" || UNCLAIMED_VALUES.has(value.trim().toLowerCase())) return "unknown";
  const deadline = Date.parse(value);
  if (Number.isNaN(deadline)) return "invalid";
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

export function hasClaimSignal(body) {
  if (typeof body !== "string") throw new TypeError("comment body must be a string");
  if (PORTABLE_CLAIM_FIELDS.some((name) => new RegExp(`^${escapeRegExp(name)}:`, "m").test(body))) {
    return true;
  }
  return /\bclaim(?:ed|ing)?\b|\bcheck[- ]?in\b|\bcheckpoint\b/i.test(body);
}

function meaningful(value) {
  return typeof value === "string" && !UNCLAIMED_VALUES.has(value.trim().toLowerCase());
}

function latestComment(comments) {
  if (comments.length === 0) return null;
  return [...comments].sort((left, right) => {
    const time = Date.parse(left.updatedAt) - Date.parse(right.updatedAt);
    return time || left.id - right.id;
  }).at(-1);
}

function commentEvidence(comment) {
  if (!comment) return null;
  const record = structuredFields(comment.body);
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
    const dependencyState = claimField(dependency.body, "Claim-State").toLowerCase();
    const dependencyLabels = stateLabels(dependency.labels);
    if (dependencyState === "done" && dependencyLabels.length === 1 && dependencyLabels[0] === "work:done") {
      result.satisfied.push(dependencyNumber);
    } else {
      result.unknown.push(dependencyNumber);
    }
  }

  if (result.unknown.length > 0) result.status = "unknown";
  else if (result.blocked.length > 0) result.status = "blocked";
  return result;
}

function evaluateLocalEvidence(fields, local) {
  const branch = fields["Claim-Branch"];
  const worktree = fields["Claim-Worktree"];
  if (!meaningful(branch) || !meaningful(worktree)) return { status: "not-applicable", questions: [] };

  const questions = [];
  const pathMatch = local.worktrees.find((entry) => entry.path === worktree);
  const branchWorktrees = local.worktrees.filter((entry) => entry.branch === branch);
  const localBranch = local.branches.some((entry) => entry.name === branch);

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
  const record = structuredFields(issue.body, [...PORTABLE_CLAIM_FIELDS, ...CHECKPOINT_FIELDS, "Parent-Plan", "Depends-On"]);
  const fields = record.fields;
  const claimState = (fields["Claim-State"] ?? "missing").toLowerCase();
  const questions = record.duplicates.map((name) =>
    question("duplicate-body-field", `issue body repeats structured field ${name}`),
  );
  const labels = stateLabels(issue.labels);

  if (labels.length !== 1 || labels[0] !== `work:${claimState}`) {
    questions.push(
      question(
        "body-label-state-mismatch",
        `Claim-State ${claimState} does not match exactly one state label (found ${labels.join(", ") || "none"})`,
      ),
    );
  }

  const hasOwnershipEvidence = PORTABLE_CLAIM_FIELDS.slice(1, 7).some((name) => meaningful(fields[name]));
  const claimExpected = ["active", "review"].includes(claimState) ||
    (claimState === "blocked" && hasOwnershipEvidence);
  if (claimExpected) {
    const missingClaimFields = PORTABLE_CLAIM_FIELDS.slice(1).filter((name) => !meaningful(fields[name]));
    if (missingClaimFields.length > 0) {
      questions.push(
        question(
          "incomplete-claim",
          `${missingClaimFields.join(", ")} missing or unclaimed for ${claimState} work`,
        ),
      );
    }
  } else if (["proposed", "ready"].includes(claimState)) {
    const unexpectedOwnerFields = PORTABLE_CLAIM_FIELDS.slice(1, 7).filter((name) => meaningful(fields[name]));
    if (unexpectedOwnerFields.length > 0) {
      questions.push(
        question(
          "unexpected-claim-owner",
          `${unexpectedOwnerFields.join(", ")} carry ownership while Claim-State is ${claimState}`,
        ),
      );
    }
  }

  const checkIn = fields["Check-In-By"] ?? "missing";
  const checkInStatus = deadlineStatus(checkIn, nowMs);
  const staleReason = claimExpected ? staleClaimReason(claimState, checkIn, nowMs) : undefined;
  if (staleReason) {
    questions.push(question(`check-in-${checkInStatus}`, `${staleReason}; do not infer abandonment or takeover authority`));
  }

  const latest = latestComment(comments);
  const latestClaim = latestComment(comments.filter((comment) => hasClaimSignal(comment.body)));
  const latestClaimEvidence = commentEvidence(latestClaim);
  if (latestClaimEvidence) {
    const commentRecordFields = Object.entries(latestClaimEvidence.structuredFields).filter(
      ([name]) => PORTABLE_CLAIM_FIELDS.includes(name) || CHECKPOINT_FIELDS.includes(name),
    );
    if (latestClaimEvidence.duplicateFields.length > 0) {
      questions.push(
        question(
          "duplicate-comment-field",
          `latest claim/checkpoint comment repeats ${latestClaimEvidence.duplicateFields.join(", ")}`,
        ),
      );
    }
    if (commentRecordFields.length === 0) {
      questions.push(
        question(
          "unstructured-claim-comment",
          "latest claim/checkpoint comment has no portable claim or checkpoint fields to reconcile",
        ),
      );
    } else {
      const missingCommentFields = COMMENT_RECORD_FIELDS.filter(
        (name) => latestClaimEvidence.structuredFields[name] === undefined,
      );
      if (missingCommentFields.length > 0) {
        questions.push(
          question(
            "incomplete-claim-comment",
            `latest claim/checkpoint comment omits ${missingCommentFields.join(", ")}`,
          ),
        );
      }
      for (const [name, value] of commentRecordFields) {
        if ((fields[name] ?? "missing") !== value) {
          questions.push(
            question(
              "body-comment-mismatch",
              `latest claim/checkpoint comment says ${name}=${value}, body says ${fields[name] ?? "missing"}`,
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

  const localEvidence = evaluateLocalEvidence(fields, local);
  questions.push(...localEvidence.questions);

  const item = {
    number: issue.number,
    title: issue.title,
    url: issue.url,
    githubState: issue.state,
    labels: issue.labels,
    updatedAt: issue.updatedAt,
    parentPlan: fields["Parent-Plan"] ?? "missing",
    claimState,
    claim: Object.fromEntries(PORTABLE_CLAIM_FIELDS.map((name) => [name, fields[name] ?? "missing"])),
    checkpoint: Object.fromEntries(CHECKPOINT_FIELDS.map((name) => [name, fields[name] ?? "missing"])),
    deadline: { value: checkIn, status: checkInStatus },
    dependencies,
    latestComment: commentEvidence(latest),
    latestClaimComment: latestClaimEvidence,
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

export function analyzeCoordination({ issues, commentsByIssue, local, nowMs = Date.now() }) {
  const issueByNumber = new Map(issues.map((issue) => [issue.number, issue]));
  const openIssues = issues.filter((issue) => issue.state === "open");
  const coordinated = openIssues.filter((issue) =>
    isCoordinatedIssue(issue, commentsByIssue.get(issue.number) ?? []),
  );
  const plans = coordinated
    .filter((issue) => issue.labels.includes("work:plan"))
    .map((issue) => ({
      number: issue.number,
      title: issue.title,
      url: issue.url,
      updatedAt: issue.updatedAt,
      planState: claimField(issue.body, "Plan-State"),
      integrationOwner: claimField(issue.body, "Integration-Owner"),
      latestComment: commentEvidence(latestComment(commentsByIssue.get(issue.number) ?? [])),
    }));
  const workItems = coordinated
    .filter((issue) => !issue.labels.includes("work:plan"))
    .map((issue) => analyzeWorkItem(issue, commentsByIssue.get(issue.number) ?? [], issueByNumber, local, nowMs));

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

  return { plans, workItems };
}
