import assert from "node:assert/strict";
import test from "node:test";

import {
  analyzeCoordination,
  claimField,
  deadlineStatus,
  hasClaimSignal,
  isCoordinatedIssue,
  parseDependencies,
  staleClaimReason,
  structuredFields,
} from "./coordination-lib.mjs";

const NOW = Date.parse("2026-08-29T20:00:00Z");

function issue({
  number,
  state = "ready",
  labels = [`work:${state}`],
  dependencies = "none",
  claimed = ["active", "blocked", "review"].includes(state),
}) {
  return {
    number,
    title: `Work ${number}`,
    state: "open",
    labels,
    updatedAt: "2026-08-29T19:00:00Z",
    url: `https://example.invalid/${number}`,
    body: [
      "Parent-Plan: #27",
      `Depends-On: ${dependencies}`,
      "Integration-Owner: maintainer",
      "Reconciled-Claim-Comment-IDs: none",
      `Claim-State: ${state}`,
      `Claim-Harness: ${claimed ? "pi" : "unclaimed"}`,
      `Claim-Run-ID: ${claimed ? `run-${number}` : "unclaimed"}`,
      `Claim-Agent: ${claimed ? `agent-${number}` : "unclaimed"}`,
      `Claim-Branch: ${claimed ? `test/${number}` : "unclaimed"}`,
      `Claim-Worktree: ${claimed ? `/worktree/${number}` : "unclaimed"}`,
      `Claimed-At: ${claimed ? "2026-08-29T18:00:00Z" : "unclaimed"}`,
      `Check-In-By: ${claimed ? "2026-08-29T21:00:00Z" : "unclaimed"}`,
      "Checkpoint-At: unclaimed",
      "Checkpoint-Commit: uncommitted",
      "Next-Action: test",
      "Blockers: none",
    ].join("\n"),
  };
}

function checkpointComment({
  id,
  number = 4,
  state = "active",
  claimed = ["active", "blocked", "review"].includes(state),
  runId = claimed ? `run-${number}` : "unclaimed",
  createdAt = "2026-08-29T19:30:00Z",
  updatedAt = createdAt,
}) {
  return {
    id,
    author: claimed ? `agent-${number}` : "maintainer",
    body: [
      `Claim-State: ${state}`,
      `Claim-Harness: ${claimed ? "pi" : "unclaimed"}`,
      `Claim-Run-ID: ${runId}`,
      `Claim-Agent: ${claimed ? `agent-${number}` : "unclaimed"}`,
      `Claim-Branch: ${claimed ? `test/${number}` : "unclaimed"}`,
      `Claim-Worktree: ${claimed ? `/worktree/${number}` : "unclaimed"}`,
      `Check-In-By: ${claimed ? "2026-08-29T21:00:00Z" : "unclaimed"}`,
      "Checkpoint-At: unclaimed",
      "Checkpoint-Commit: uncommitted",
    ].join("\n"),
    createdAt,
    updatedAt,
  };
}

const EMPTY_LOCAL = { branches: [], worktrees: [], status: "" };

test("structured fields read exact portable names and report duplicates", () => {
  const body = "Claim-State: ready\nClaim-Agent: first\nClaim-Agent: second\n";
  const record = structuredFields(body);

  assert.equal(claimField(body, "Claim-State"), "ready");
  assert.equal(record.fields["Claim-Agent"], "second");
  assert.deepEqual(record.duplicates, ["Claim-Agent"]);
  assert.equal(claimField(body, "Claim-Run-ID"), "missing");
});

test("deadlines require strict real ISO instants", () => {
  assert.equal(deadlineStatus("2026-08-29T21:00:00Z", NOW), "current");
  assert.equal(deadlineStatus("2026-08-29T22:30:00+02:00", NOW), "current");
  assert.equal(deadlineStatus("2026-08-29T19:00:00Z", NOW), "overdue");
  assert.equal(deadlineStatus("unclaimed", NOW), "unknown");
  for (const invalid of [
    "tomorrowish",
    "2026-08-29",
    "2026-08-29T21:00:00",
    "2026-02-30T21:00:00Z",
    "2026-08-29T24:00:00Z",
    "2026-08-29T21:00:00+14:01",
  ]) {
    assert.equal(deadlineStatus(invalid, NOW), "invalid", invalid);
  }
});

test("every nonterminal claimed state warns on bad check-in evidence", () => {
  for (const state of ["active", "blocked", "review"]) {
    assert.equal(staleClaimReason(state, "missing", NOW), "check-in unknown");
    assert.equal(staleClaimReason(state, "2026-08-29T19:00:00Z", NOW), "check-in overdue");
  }
  assert.equal(staleClaimReason("ready", "missing", NOW), undefined);
  assert.equal(staleClaimReason("done", "2026-08-29T19:00:00Z", NOW), undefined);
});

test("dependency parser accepts none and issue lists but rejects ambiguous records", () => {
  assert.deepEqual(parseDependencies("none"), { status: "clear", numbers: [] });
  assert.deepEqual(parseDependencies("#2, #7 #2"), { status: "declared", numbers: [2, 7] });
  assert.deepEqual(parseDependencies("issue 2"), { status: "invalid", numbers: [] });
  assert.deepEqual(parseDependencies("missing"), { status: "unknown", numbers: [] });
});

test("ready work becomes candidate evidence only when dependencies are proven done", () => {
  const dependency = issue({ number: 2, state: "done" });
  dependency.state = "closed";
  const candidate = issue({ number: 3, dependencies: "#2" });
  const result = analyzeCoordination({
    issues: [dependency, candidate],
    commentsByIssue: new Map(),
    local: EMPTY_LOCAL,
    nowMs: NOW,
  });

  assert.equal(result.workItems[0].triage, "candidate");
  assert.deepEqual(result.workItems[0].dependencies.satisfied, [2]);
  assert.equal(result.workItems[0].candidateSafety, "not-established");
});

test("ambiguous closed dependency completion records remain unknown", () => {
  const mutations = [
    (dependency) => {
      dependency.body += "\nClaim-State: done";
    },
    (dependency) => {
      dependency.body = dependency.body.replace("Claim-State: done", "Claim-State: Done");
    },
    (dependency) => {
      dependency.labels.push("work:dnoe");
    },
  ];

  for (const [index, mutate] of mutations.entries()) {
    const dependency = issue({ number: 20 + index, state: "done" });
    dependency.state = "closed";
    mutate(dependency);
    const candidate = issue({ number: 30 + index, dependencies: `#${dependency.number}` });
    const result = analyzeCoordination({
      issues: [dependency, candidate],
      commentsByIssue: new Map(),
      local: EMPTY_LOCAL,
      nowMs: NOW,
    });

    assert.equal(result.workItems[0].dependencies.status, "unknown");
    assert.equal(result.workItems[0].triage, "question");
  }
});

test("an open dependency keeps ready work blocked without asserting claim safety", () => {
  const dependency = issue({ number: 2, state: "active" });
  const candidate = issue({ number: 3, dependencies: "#2" });
  const result = analyzeCoordination({
    issues: [dependency, candidate],
    commentsByIssue: new Map(),
    local: EMPTY_LOCAL,
    nowMs: NOW,
  });
  const item = result.workItems.find(({ number }) => number === 3);

  assert.equal(item.dependencies.status, "blocked");
  assert.equal(item.triage, "blocked");
  assert.equal(item.candidateSafety, "not-established");
});

test("ready and proposed records with leftover deadlines are not candidates", () => {
  for (const state of ["ready", "proposed"]) {
    const work = issue({ number: state === "ready" ? 40 : 41, state, claimed: false });
    work.body = work.body.replace("Check-In-By: unclaimed", "Check-In-By: 2026-08-29T21:00:00Z");
    const result = analyzeCoordination({
      issues: [work],
      commentsByIssue: new Map(),
      local: EMPTY_LOCAL,
      nowMs: NOW,
    });

    assert.equal(result.workItems[0].triage, "question");
    assert(result.workItems[0].questions.some(({ code }) => code === "unexpected-claim-evidence"));
  }
});

test("unclaimed blocked work does not invent stale-claim ownership", () => {
  const blocked = issue({ number: 4, state: "blocked", claimed: false });
  const result = analyzeCoordination({
    issues: [blocked],
    commentsByIssue: new Map(),
    local: EMPTY_LOCAL,
    nowMs: NOW,
  });

  assert.equal(result.workItems[0].triage, "blocked");
  assert(result.workItems[0].questions.every(({ code }) => !code.startsWith("check-in-")));
  assert(result.workItems[0].questions.every(({ code }) => code !== "incomplete-claim"));
});

test("missing dependency evidence is a maintainer question", () => {
  const candidate = issue({ number: 3, dependencies: "#999" });
  const result = analyzeCoordination({
    issues: [candidate],
    commentsByIssue: new Map(),
    local: EMPTY_LOCAL,
    nowMs: NOW,
  });

  assert.equal(result.workItems[0].dependencies.status, "unknown");
  assert.equal(result.workItems[0].triage, "question");
  assert(result.workItems[0].questions.some(({ code }) => code === "dependency-unknown"));
});

test("a complete matching latest checkpoint comment reconciles consistently", () => {
  const active = issue({ number: 4, state: "active" });
  const comments = new Map([
    [4, [{
      id: 1,
      author: "maintainer",
      body: [
        "Claim-State: active",
        "Claim-Harness: pi",
        "Claim-Run-ID: run-4",
        "Claim-Agent: agent-4",
        "Claim-Branch: test/4",
        "Claim-Worktree: /worktree/4",
        "Check-In-By: 2026-08-29T21:00:00Z",
        "Checkpoint-At: unclaimed",
        "Checkpoint-Commit: uncommitted",
      ].join("\n"),
      createdAt: "2026-08-29T19:30:00Z",
      updatedAt: "2026-08-29T19:30:00Z",
    }]],
  ]);
  const result = analyzeCoordination({ issues: [active], commentsByIssue: comments, local: EMPTY_LOCAL, nowMs: NOW });

  assert.equal(result.workItems[0].reconciliation, "consistent");
  assert.equal(result.workItems[0].triage, "claimed");
});

test("authorized reconciliation keeps historical prose visible and clears its question", () => {
  const active = issue({ number: 4, state: "active" });
  active.body = active.body.replace(
    "Reconciled-Claim-Comment-IDs: none",
    "Reconciled-Claim-Comment-IDs: 1",
  );
  const historical = {
    id: 1,
    author: "agent-4",
    body: "Claimed this item before structured checkpoints existed.",
    createdAt: "2026-08-29T19:00:00Z",
    updatedAt: "2026-08-29T19:00:00Z",
  };
  const current = checkpointComment({ id: 2 });
  const result = analyzeCoordination({
    issues: [active],
    commentsByIssue: new Map([[4, [historical, current]]]),
    local: EMPTY_LOCAL,
    nowMs: NOW,
  });
  const item = result.workItems[0];

  assert.equal(item.reconciliation, "consistent");
  assert.equal(item.claimCommentResolution.status, "valid");
  assert.deepEqual(item.claimCommentResolution.reconciledIds, [1]);
  assert.deepEqual(item.claimCommentResolution.unresolvedIds, [2]);
  assert.equal(item.claimComments.find(({ id }) => id === 1).reconciliation, "reconciled");
  assert.equal(item.latestClaimComment.id, 2);
  assert.equal(item.latestUnresolvedClaimComment.id, 2);
});

test("authorized takeover can supersede exact prior structured ownership", () => {
  const active = issue({ number: 4, state: "active" });
  active.body = active.body.replace(
    "Reconciled-Claim-Comment-IDs: none",
    "Reconciled-Claim-Comment-IDs: 10",
  );
  const prior = checkpointComment({ id: 10, runId: "prior-run", createdAt: "2026-08-29T19:00:00Z" });
  const current = checkpointComment({ id: 11 });
  const result = analyzeCoordination({
    issues: [active],
    commentsByIssue: new Map([[4, [prior, current]]]),
    local: EMPTY_LOCAL,
    nowMs: NOW,
  });

  assert.equal(result.workItems[0].reconciliation, "consistent");
  assert.deepEqual(result.workItems[0].claimCommentResolution.reconciledIds, [10]);
  assert(result.workItems[0].questions.every(({ code }) => code !== "competing-ownership-comment"));
});

test("authorized release to ready can reconcile the prior claim without hiding it", () => {
  const ready = issue({ number: 4, state: "ready", claimed: false });
  ready.body = ready.body.replace(
    "Reconciled-Claim-Comment-IDs: none",
    "Reconciled-Claim-Comment-IDs: 20",
  );
  const prior = checkpointComment({ id: 20, createdAt: "2026-08-29T19:00:00Z" });
  const release = checkpointComment({ id: 21, state: "ready", claimed: false });
  const result = analyzeCoordination({
    issues: [ready],
    commentsByIssue: new Map([[4, [prior, release]]]),
    local: EMPTY_LOCAL,
    nowMs: NOW,
  });
  const item = result.workItems[0];

  assert.equal(item.triage, "candidate");
  assert.equal(item.candidateSafety, "not-established");
  assert.deepEqual(item.claimCommentResolution.reconciledIds, [20]);
  assert.equal(item.claimComments.find(({ id }) => id === 20).reconciliation, "reconciled");
});

test("malformed unknown duplicate non-claim edited or self-authorized resolutions fail closed", () => {
  const cases = [
    { value: "1,2", comments: [], code: "malformed-resolution" },
    { value: "999", comments: [], code: "unknown-resolution-id" },
    {
      value: "1, 1",
      comments: [{
        id: 1,
        author: "agent-4",
        body: "Claimed this item.",
        createdAt: "2026-08-29T19:00:00Z",
        updatedAt: "2026-08-29T19:00:00Z",
      }],
      code: "duplicate-resolution-id",
    },
    {
      value: "1",
      duplicateField: true,
      comments: [{
        id: 1,
        author: "agent-4",
        body: "Claimed this item.",
        createdAt: "2026-08-29T19:00:00Z",
        updatedAt: "2026-08-29T19:00:00Z",
      }],
      code: "duplicate-resolution-field",
    },
    {
      value: "1",
      comments: [{
        id: 1,
        author: "observer",
        body: "No ownership intent here.",
        createdAt: "2026-08-29T19:00:00Z",
        updatedAt: "2026-08-29T19:00:00Z",
      }],
      code: "non-claim-resolution-id",
    },
    {
      value: "1",
      comments: [{
        id: 1,
        author: "agent-4",
        body: "Claimed this item.",
        createdAt: "2026-08-29T19:00:00Z",
        updatedAt: "2026-08-29T19:05:00Z",
      }],
      code: "edited-resolution-id",
    },
    {
      value: "1",
      integrationOwner: "unclaimed",
      comments: [{
        id: 1,
        author: "agent-4",
        body: "Claimed this item.",
        createdAt: "2026-08-29T19:00:00Z",
        updatedAt: "2026-08-29T19:00:00Z",
      }],
      code: "resolution-authority-unknown",
    },
    {
      value: "1",
      integrationOwner: "self",
      comments: [{
        id: 1,
        author: "agent-4",
        body: "Claimed this item.",
        createdAt: "2026-08-29T19:00:00Z",
        updatedAt: "2026-08-29T19:00:00Z",
      }],
      code: "claimant-self-resolution",
    },
  ];

  for (const [index, scenario] of cases.entries()) {
    const active = issue({ number: 50 + index, state: "active" });
    const integrationOwner = scenario.integrationOwner === "self"
      ? `agent-${50 + index}`
      : scenario.integrationOwner ?? "maintainer";
    active.body = active.body
      .replace("Reconciled-Claim-Comment-IDs: none", `Reconciled-Claim-Comment-IDs: ${scenario.value}`)
      .replace("Integration-Owner: maintainer", `Integration-Owner: ${integrationOwner}`);
    if (scenario.duplicateField) {
      active.body += `\nReconciled-Claim-Comment-IDs: ${scenario.value}`;
    }
    const current = checkpointComment({ id: 100 + index, number: 50 + index });
    const result = analyzeCoordination({
      issues: [active],
      commentsByIssue: new Map([[50 + index, [...scenario.comments, current]]]),
      local: EMPTY_LOCAL,
      nowMs: NOW,
    });
    const item = result.workItems[0];

    assert.equal(item.claimCommentResolution.status, "invalid", scenario.code);
    assert.deepEqual(item.claimCommentResolution.reconciledIds, [], scenario.code);
    assert(item.claimCommentResolution.problems.some(({ code }) => code === scenario.code));
    assert(item.questions.some(({ code }) => code === "claim-comment-resolution-invalid"));
  }
});

test("later unlisted competing intent remains unresolved", () => {
  const active = issue({ number: 4, state: "active" });
  active.body = active.body.replace(
    "Reconciled-Claim-Comment-IDs: none",
    "Reconciled-Claim-Comment-IDs: 1",
  );
  const historical = {
    id: 1,
    author: "agent-4",
    body: "Claimed this item before structured checkpoints existed.",
    createdAt: "2026-08-29T19:00:00Z",
    updatedAt: "2026-08-29T19:00:00Z",
  };
  const current = checkpointComment({ id: 2, createdAt: "2026-08-29T19:30:00Z" });
  const laterCompeting = checkpointComment({
    id: 3,
    runId: "later-competing-run",
    createdAt: "2026-08-29T19:45:00Z",
  });
  const result = analyzeCoordination({
    issues: [active],
    commentsByIssue: new Map([[4, [historical, current, laterCompeting]]]),
    local: EMPTY_LOCAL,
    nowMs: NOW,
  });
  const item = result.workItems[0];

  assert.deepEqual(item.claimCommentResolution.reconciledIds, [1]);
  assert.deepEqual(item.claimCommentResolution.unresolvedIds, [2, 3]);
  assert.equal(item.latestUnresolvedClaimComment.id, 3);
  assert(item.questions.some(({ code }) => code === "competing-ownership-comment"));
  assert.equal(item.triage, "question");
});

test("latest structured comment is reconciled against the body", () => {
  const active = issue({ number: 4, state: "active" });
  const comments = new Map([
    [4, [{
      id: 1,
      author: "maintainer",
      body: "Claim-State: blocked\nClaim-Agent: other-agent\n",
      createdAt: "2026-08-29T19:30:00Z",
      updatedAt: "2026-08-29T19:30:00Z",
    }]],
  ]);
  const result = analyzeCoordination({ issues: [active], commentsByIssue: comments, local: EMPTY_LOCAL, nowMs: NOW });

  assert.equal(result.workItems[0].reconciliation, "question");
  assert(result.workItems[0].questions.some(({ code }) => code === "body-comment-mismatch"));
});

test("competing structured ownership comments cannot be hidden by a later matching checkpoint", () => {
  const active = issue({ number: 4, state: "active" });
  const current = [
    "Claim-State: active",
    "Claim-Harness: pi",
    "Claim-Run-ID: run-4",
    "Claim-Agent: agent-4",
    "Claim-Branch: test/4",
    "Claim-Worktree: /worktree/4",
    "Check-In-By: 2026-08-29T21:00:00Z",
    "Checkpoint-At: unclaimed",
    "Checkpoint-Commit: uncommitted",
  ];
  const competing = current.map((line) =>
    line === "Claim-Run-ID: run-4" ? "Claim-Run-ID: competing-run" : line,
  );
  const comments = new Map([
    [4, [
      {
        id: 1,
        author: "other-agent",
        body: competing.join("\n"),
        createdAt: "2026-08-29T19:00:00Z",
        updatedAt: "2026-08-29T19:00:00Z",
      },
      {
        id: 2,
        author: "maintainer",
        body: current.join("\n"),
        createdAt: "2026-08-29T19:30:00Z",
        updatedAt: "2026-08-29T19:30:00Z",
      },
    ]],
  ]);
  const result = analyzeCoordination({ issues: [active], commentsByIssue: comments, local: EMPTY_LOCAL, nowMs: NOW });

  assert(result.workItems[0].questions.some(({ code }) => code === "competing-ownership-comment"));
  assert.equal(result.workItems[0].triage, "question");
});

test("editing an older ownership comment cannot make updated ordering hide intent", () => {
  const active = issue({ number: 4, state: "active" });
  const body = [
    "Claim-State: active",
    "Claim-Harness: pi",
    "Claim-Run-ID: run-4",
    "Claim-Agent: agent-4",
    "Claim-Branch: test/4",
    "Claim-Worktree: /worktree/4",
    "Check-In-By: 2026-08-29T21:00:00Z",
    "Checkpoint-At: unclaimed",
    "Checkpoint-Commit: uncommitted",
  ].join("\n");
  const comments = new Map([
    [4, [
      {
        id: 1,
        author: "agent-4",
        body,
        createdAt: "2026-08-29T19:00:00Z",
        updatedAt: "2026-08-29T19:45:00Z",
      },
      {
        id: 2,
        author: "maintainer",
        body,
        createdAt: "2026-08-29T19:30:00Z",
        updatedAt: "2026-08-29T19:30:00Z",
      },
    ]],
  ]);
  const result = analyzeCoordination({ issues: [active], commentsByIssue: comments, local: EMPTY_LOCAL, nowMs: NOW });

  assert.equal(result.workItems[0].latestClaimComment.id, 2);
  assert(result.workItems[0].questions.some(({ code }) => code === "edited-claim-comment"));
});

test("claim signals without structured fields remain ambiguous", () => {
  for (const signal of [
    "Claimed by another session; checkpoint pending.",
    "I started work on this item.",
    "Taking ownership now.",
  ]) {
    assert.equal(hasClaimSignal(signal), true, signal);
  }
  const active = issue({ number: 4, state: "active" });
  const comments = new Map([
    [4, [{
      id: 1,
      author: "maintainer",
      body: "Claimed by another session; checkpoint pending.",
      createdAt: "2026-08-29T19:30:00Z",
      updatedAt: "2026-08-29T19:30:00Z",
    }]],
  ]);
  const result = analyzeCoordination({ issues: [active], commentsByIssue: comments, local: EMPTY_LOCAL, nowMs: NOW });

  assert(result.workItems[0].questions.some(({ code }) => code === "unstructured-claim-comment"));
});

test("claim-bearing unlabeled issues are coordinated and cannot disappear", () => {
  const unlabeled = issue({ number: 5, state: "active", labels: ["area:foundation"] });

  assert.equal(isCoordinatedIssue(unlabeled), true);
  const result = analyzeCoordination({
    issues: [unlabeled],
    commentsByIssue: new Map(),
    local: EMPTY_LOCAL,
    nowMs: NOW,
  });
  assert.equal(result.workItems.length, 1);
  assert(result.workItems[0].questions.some(({ code }) => code === "body-label-state-mismatch"));
});

test("comment-only claim signals keep unlabeled open issues visible", () => {
  const unlabeled = {
    ...issue({ number: 6, state: "ready", labels: [] }),
    body: "ordinary issue body",
  };
  const comments = [{
    id: 1,
    author: "maintainer",
    body: "Claim-State: active\nClaim-Agent: agent-6\n",
    createdAt: "2026-08-29T19:30:00Z",
    updatedAt: "2026-08-29T19:30:00Z",
  }];

  assert.equal(isCoordinatedIssue(unlabeled, comments), true);
  const result = analyzeCoordination({
    issues: [unlabeled],
    commentsByIssue: new Map([[6, comments]]),
    local: EMPTY_LOCAL,
    nowMs: NOW,
  });
  assert.equal(result.workItems.length, 1);
  assert.equal(result.workItems[0].triage, "question");
});

test("local branch and worktree mismatches are contradictions, not cleanup instructions", () => {
  const active = issue({ number: 6, state: "active" });
  const local = {
    status: "",
    branches: [{ name: "test/6", head: "abc" }],
    worktrees: [{ path: "/different/path", head: "abc", branch: "test/6" }],
  };
  const result = analyzeCoordination({ issues: [active], commentsByIssue: new Map(), local, nowMs: NOW });

  assert.equal(result.workItems[0].localEvidence.status, "contradiction");
  assert(result.workItems[0].questions.some(({ code }) => code === "branch-worktree-mismatch"));
  assert(result.workItems[0].questions.every(({ message }) => !/remove|clean|reset/i.test(message)));
});

test("locked or prunable registered worktrees are contradictions, never matches", () => {
  for (const property of ["locked", "prunable"]) {
    const active = issue({ number: 6, state: "active" });
    const local = {
      status: "",
      branches: [{ name: "test/6", head: "abc" }],
      worktrees: [{
        path: "/worktree/6",
        head: "abc",
        branch: "test/6",
        locked: null,
        prunable: null,
        [property]: "adversarial evidence",
      }],
    };
    const result = analyzeCoordination({ issues: [active], commentsByIssue: new Map(), local, nowMs: NOW });

    assert.equal(result.workItems[0].localEvidence.status, "contradiction");
    assert(result.workItems[0].questions.some(({ code }) => code === `worktree-${property}`));
  }
});

test("duplicate branch registration across claims becomes a maintainer question", () => {
  const first = issue({ number: 7, state: "active" });
  const second = issue({ number: 8, state: "review" });
  second.body = second.body
    .replace("Claim-Branch: test/8", "Claim-Branch: test/7")
    .replace("Claim-Worktree: /worktree/8", "Claim-Worktree: /worktree/7");
  const result = analyzeCoordination({
    issues: [first, second],
    commentsByIssue: new Map(),
    local: EMPTY_LOCAL,
    nowMs: NOW,
  });

  assert(result.workItems.every((item) => item.questions.some(({ code }) => code === "duplicate-claim-locality")));
  assert(result.workItems.every((item) => item.triage === "question"));
});

function v2Body({ state = 'ready', overrides = {} } = {}) {
  const agentOwned = ['active', 'review'].includes(state);
  const blocked = state === 'blocked';
  const fields = {
    'Registry-Schema-Version': '2',
    'Parent-Plan': '#27',
    'Scope-Paths': 'tools/**',
    'Depends-On': 'none',
    'Dependency-Notes': 'none',
    'Integration-Owner': 'maintainer',
    'Reconciled-Claim-Comment-IDs': 'none',
    'Claim-State': state,
    'Claim-Harness': agentOwned ? 'pi' : 'unclaimed',
    'Claim-Run-ID': agentOwned ? 'run-v2' : 'unclaimed',
    'Claim-Agent': agentOwned ? 'agent-v2' : 'unclaimed',
    'Claim-Branch': agentOwned ? 'arch/v2' : 'unclaimed',
    'Claim-Host': agentOwned ? 'runner-01' : 'unclaimed',
    'Claimed-At': agentOwned ? '2026-08-29T18:00:00Z' : 'unclaimed',
    'Check-In-By': agentOwned ? '2026-08-29T21:00:00Z' : 'unclaimed',
    'Waiting-Since': blocked ? '2026-08-29T18:00:00Z' : 'unclaimed',
    'Checkpoint-Evidence-Version': '1',
    'Checkpoint-State': state,
    'Checkpoint-At': ['proposed', 'ready'].includes(state)
      ? 'unclaimed'
      : '2026-08-29T19:00:00Z',
    'Checkpoint-Commit': 'uncommitted',
    'Checkpoint-Changed-Path-Count': '0',
    'Checkpoint-Checks-Verdict': 'unavailable',
    'Checkpoint-CI-Run': 'unavailable',
    'Checkpoint-CI-Commit': 'unavailable',
    'Checkpoint-Security-Impact': 'unknown',
    'Checkpoint-Tenant-Impact': 'unknown',
    'Checkpoint-Provider-Impact': 'unknown',
    'Checkpoint-Deployment-Impact': 'unknown',
    'Checkpoint-Residual-Risk-Count': '0',
    'Next-Action': 'test',
    Blockers: 'none',
    ...overrides,
  };
  return `${Object.entries(fields).map(([name, value]) => `${name}: ${value}`).join('\n')}\n`;
}

test('explicit v2 ready records preserve existing candidate behavior without ranking', () => {
  const candidate = issue({ number: 70, state: 'ready', claimed: false });
  candidate.body = v2Body();
  const result = analyzeCoordination({
    issues: [candidate],
    commentsByIssue: new Map(),
    local: EMPTY_LOCAL,
    nowMs: NOW,
  });
  const item = result.workItems[0];

  assert.equal(item.registrySchema.version, '2');
  assert.equal(item.registrySchema.explicit, true);
  assert.equal(item.registrySchema.valid, true);
  assert.equal(item.triage, 'candidate');
  assert.deepEqual(item.scopePaths, ['tools/**']);
  assert.equal(item.claim['Claim-Worktree'], undefined);
  assert.equal(item.claim['Claim-Host'], 'unclaimed');
});

test('unsupported and unmanaged malformed v2 records stay visible and fail closed', () => {
  const unsupported = issue({ number: 71, state: 'ready', claimed: false });
  unsupported.body = v2Body().replace('Registry-Schema-Version: 2', 'Registry-Schema-Version: 44');
  const unmanaged = issue({ number: 72, state: 'active' });
  unmanaged.body = v2Body({ state: 'active', overrides: { 'Claim-Host': '/tmp/local' } });
  const result = analyzeCoordination({
    issues: [unsupported, unmanaged],
    commentsByIssue: new Map(),
    local: EMPTY_LOCAL,
    nowMs: NOW,
  });

  assert.equal(result.workItems.length, 2);
  assert(result.workItems.every(({ triage }) => triage === 'question'));
  assert(
    result.workItems
      .find(({ number }) => number === 71)
      .questions.some(({ code }) => code === 'unsupported-registry-schema'),
  );
  assert(
    result.workItems
      .find(({ number }) => number === 72)
      .questions.some(({ code }) => code === 'invalid-registry-schema'),
  );
});

test('v2 principal-waiting records surface Waiting-Since without inventing an agent deadline', () => {
  const blocked = issue({ number: 73, state: 'blocked', claimed: false });
  blocked.body = v2Body({ state: 'blocked' });
  const result = analyzeCoordination({
    issues: [blocked],
    commentsByIssue: new Map(),
    local: EMPTY_LOCAL,
    nowMs: NOW,
  });
  const item = result.workItems[0];

  assert.equal(item.registrySchema.valid, true);
  assert.equal(item.triage, 'blocked');
  assert.equal(item.deadline.status, 'unknown');
  assert.equal(item.waiting.value, '2026-08-29T18:00:00Z');
  assert(item.questions.every(({ code }) => !code.startsWith('check-in-')));
});

test('complete evidence headers are semantically validated while pre-header history remains immutable', () => {
  const active = issue({ number: 74, state: 'active' });
  active.body = v2Body({ state: 'active' });
  const currentFields = structuredFields(active.body, [
    'Claim-State',
    'Claim-Harness',
    'Claim-Run-ID',
    'Claim-Agent',
    'Claim-Branch',
    'Claim-Host',
    'Claimed-At',
    'Check-In-By',
    'Waiting-Since',
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
  ]).fields;
  const malformed = {
    id: 2,
    author: 'agent-v2',
    body: Object.entries({ ...currentFields, 'Checkpoint-Residual-Risk-Count': 'many' })
      .map(([name, value]) => `${name}: ${value}`)
      .join('\n'),
    createdAt: '2026-08-29T19:30:00Z',
    updatedAt: '2026-08-29T19:30:00Z',
  };
  const result = analyzeCoordination({
    issues: [active],
    commentsByIssue: new Map([[74, [malformed]]]),
    local: EMPTY_LOCAL,
    nowMs: NOW,
  });

  assert(
    result.workItems[0].questions.some(({ code }) => code === 'invalid-checkpoint-evidence'),
  );
  assert.equal(result.workItems[0].triage, 'question');
});

test('an interrupted v1-to-v2 comment transition surfaces recovery without reinterpreting history', () => {
  const active = issue({ number: 75, state: 'active' });
  active.body = v2Body({ state: 'active' });
  const fields = structuredFields(active.body, [
    'Claim-State',
    'Claim-Harness',
    'Claim-Run-ID',
    'Claim-Agent',
    'Claim-Branch',
    'Claim-Host',
    'Claimed-At',
    'Check-In-By',
    'Waiting-Since',
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
  ]).fields;
  const historicalBody = Object.entries(fields)
    .filter(([name]) => name !== 'Waiting-Since')
    .map(([name, value]) =>
      name === 'Claim-Host' ? 'Claim-Worktree: /historical/worktree' : `${name}: ${value}`,
    )
    .join('\n');
  const historical = {
    id: 3,
    author: 'agent-v2',
    body: historicalBody,
    createdAt: '2026-08-29T19:30:00Z',
    updatedAt: '2026-08-29T19:30:00Z',
  };
  const result = analyzeCoordination({
    issues: [active],
    commentsByIssue: new Map([[75, [historical]]]),
    local: EMPTY_LOCAL,
    nowMs: NOW,
  });
  const item = result.workItems[0];

  assert(item.questions.some(({ code }) => code === 'partial-schema-transition'));
  assert(item.questions.every(({ code }) => code !== 'invalid-checkpoint-evidence'));
  assert.equal(item.claimComments[0].structuredFields['Claim-Worktree'], '/historical/worktree');
});
