import assert from "node:assert/strict";
import test from "node:test";

import {
  analyzeCoordination,
  authoritativeCommitRelationship,
  claimField,
  classifyCommitRelationship,
  classifyIntegrationCheckout,
  classifyRemoteClaimEvidence,
  classifyRemoteClaimLifecycle,
  deadlineStatus,
  evaluateIntegrationHolds,
  hasClaimSignal,
  isCoordinatedIssue,
  parseDependencies,
  reconcileRemoteClaims,
  staleClaimReason,
  validateClaimBootstrapEvidence,
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

function remoteItem(number, branch, state = 'active') {
  return {
    number,
    claimState: state,
    registrySchema: { version: '2', valid: true },
    claim: { 'Claim-Branch': branch },
    checkpoint: { 'Checkpoint-Commit': 'a'.repeat(40) },
    questions: [],
    reconciliation: 'consistent',
    triage: state === 'active' ? 'claimed' : 'review',
  };
}

test('remote claim reconciliation accepts exact derived refs and fails closed on absence', () => {
  const present = remoteItem(73, 'claim-v1/issue-73');
  const withRef = reconcileRemoteClaims({
    issues: [],
    workItems: [present],
    reservedRefs: [
      {
        ref: 'refs/heads/claim-v1/issue-73',
        objectType: 'commit',
        sha: 'a'.repeat(40),
      },
    ],
  });
  assert.equal(present.remoteClaim.branchStatus, 'derived');
  assert.equal(present.remoteClaim.matchingRefs.length, 1);
  assert.equal(present.questions.length, 0);
  assert.equal(withRef.refs[0].mapping.issueNumber, 73);

  const absent = remoteItem(74, 'claim-v1/issue-74');
  reconcileRemoteClaims({ issues: [], workItems: [absent], reservedRefs: [] });
  assert(absent.questions.some(({ code }) => code === 'derived-claim-ref-missing'));
  assert.equal(absent.remoteClaim.lifecycle.status, 'missing-branch');
  assert.equal(absent.reconciliation, 'question');
});

test('schema-v2 blocked and unowned terminal refs are preserved without claim authority', () => {
  const blocked = issue({ number: 75, state: 'blocked', claimed: false });
  blocked.body = v2Body({ state: 'blocked' });
  const done = issue({ number: 76, state: 'done', claimed: false });
  done.body = v2Body({ state: 'done' });
  done.state = 'closed';
  const abandoned = issue({ number: 77, state: 'abandoned', claimed: false });
  abandoned.body = v2Body({ state: 'abandoned' });
  abandoned.state = 'closed';
  const reservedRefs = [75, 76, 77].map((number) => ({
    ref: `refs/heads/claim-v1/issue-${number}`,
    objectType: 'commit',
    sha: `${number - 74}`.repeat(40),
  }));

  const result = analyzeCoordination({
    issues: [blocked, done, abandoned],
    commentsByIssue: new Map(),
    local: EMPTY_LOCAL,
    reservedRefs,
    nowMs: NOW,
  });
  const blockedItem = result.workItems.find(({ number }) => number === 75);

  assert.equal(blockedItem.reconciliation, 'consistent');
  assert.equal(blockedItem.triage, 'blocked');
  for (const field of [
    'Claim-Harness',
    'Claim-Run-ID',
    'Claim-Agent',
    'Claim-Branch',
    'Claim-Host',
    'Claimed-At',
    'Check-In-By',
  ]) {
    assert.equal(blockedItem.claim[field], 'unclaimed', field);
  }
  assert.deepEqual(blockedItem.remoteClaim, {
    disposition: 'preserved-non-ownership',
    expectedBranch: 'claim-v1/issue-75',
    matchingRefs: [
      {
        ref: 'refs/heads/claim-v1/issue-75',
        objectType: 'commit',
        sha: '1'.repeat(40),
        mapping: {
          status: 'supported',
          version: 1,
          issueNumber: 75,
          branch: 'claim-v1/issue-75',
          ref: 'refs/heads/claim-v1/issue-75',
        },
        issueNumber: 75,
        disposition: 'preserved-non-ownership',
        currentOwnership: false,
        lifecycleMonitoring: false,
      },
    ],
    currentOwnership: false,
    lifecycle: { status: 'not-applicable', monitoring: false },
  });
  assert.equal(result.remoteClaims.questions.length, 0);
  assert.deepEqual(
    result.remoteClaims.refs.map(({ mapping, ...remote }) => ({ ...remote, mapping: mapping.status })),
    reservedRefs.map((remote) => ({
      ...remote,
      issueNumber: Number(remote.ref.split('-').at(-1)),
      disposition: 'preserved-non-ownership',
      currentOwnership: false,
      lifecycleMonitoring: false,
      mapping: 'supported',
    })),
  );
});

test('implicit-v1 blocked and unowned terminal refs retain fail-closed branch mismatch semantics', () => {
  const records = ['blocked', 'done', 'abandoned'].map((state, index) => {
    const record = issue({ number: 78 + index, state, claimed: false });
    if (state !== 'blocked') record.state = 'closed';
    return record;
  });
  const reservedRefs = records.map(({ number }) => ({
    ref: `refs/heads/claim-v1/issue-${number}`,
    objectType: 'commit',
    sha: 'd'.repeat(40),
  }));

  const result = analyzeCoordination({
    issues: records,
    commentsByIssue: new Map(),
    local: EMPTY_LOCAL,
    reservedRefs,
    nowMs: NOW,
  });
  const blocked = result.workItems.find(({ number }) => number === 78);

  assert.equal(blocked.registrySchema.version, '1');
  assert.equal(blocked.remoteClaim, undefined);
  assert.equal(blocked.triage, 'blocked');
  assert.deepEqual(
    result.remoteClaims.questions.map(({ code }) => code),
    records.map(() => 'claim-ref-branch-mismatch'),
  );
  assert(
    result.remoteClaims.refs.every(
      ({ disposition }) => disposition === 'question' && disposition !== 'preserved-non-ownership',
    ),
  );
});

test('remote claim reconciliation exposes lag and fails closed on ancestry uncertainty', () => {
  const remote = 'b'.repeat(40);
  for (const [number, relationship, expected, warns] of [
    [80, 'left-ahead', 'local-ahead', false],
    [81, 'right-ahead', 'remote-ahead', true],
    [82, 'divergence', 'divergence', true],
    [83, 'unavailable', 'unavailable', true],
  ]) {
    const item = remoteItem(number, `claim-v1/issue-${number}`);
    reconcileRemoteClaims({
      issues: [],
      workItems: [item],
      reservedRefs: [{
        ref: `refs/heads/claim-v1/issue-${number}`,
        objectType: 'commit',
        sha: remote,
      }],
      claimRelationships: new Map([[number, relationship]]),
    });
    assert.equal(item.remoteClaim.lifecycle.status, expected);
    assert.equal(
      item.questions.some(({ code }) => code === `claim-lifecycle-${expected}`),
      warns,
    );
  }
});

test('the exact #42 bootstrap is sole and every competing active claim blocks rollout', () => {
  const bootstrap = remoteItem(42, 'arch/remote-reference-claim-primitive');
  const competing = remoteItem(73, 'claim-v1/issue-73');
  const legacyCompeting = remoteItem(74, 'arch/legacy-active');
  legacyCompeting.registrySchema.version = '1';
  reconcileRemoteClaims({
    issues: [],
    workItems: [bootstrap, competing, legacyCompeting],
    reservedRefs: [
      {
        ref: 'refs/heads/claim-v1/issue-73',
        objectType: 'commit',
        sha: 'a'.repeat(40),
      },
    ],
  });
  assert.equal(bootstrap.remoteClaim.branchStatus, 'bootstrap');
  assert(bootstrap.questions.some(({ code }) => code === 'claim-primitive-rollout-blocked'));
  assert(competing.questions.some(({ code }) => code === 'claim-primitive-rollout-blocked'));
  assert(
    legacyCompeting.questions.some(({ code }) => code === 'claim-primitive-rollout-blocked'),
  );
  assert.equal(
    bootstrap.questions.filter(({ code }) => code === 'claim-primitive-rollout-blocked').length,
    2,
  );
});

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

test('commit relationships map to all integration and remote lifecycle states', () => {
  const left = 'a'.repeat(40);
  const right = 'b'.repeat(40);
  const relationships = {
    equal: classifyCommitRelationship({ left, right: left, available: true }),
    'right-ahead': classifyCommitRelationship({
      left,
      right,
      leftIsAncestor: true,
      rightIsAncestor: false,
    }),
    'left-ahead': classifyCommitRelationship({
      left,
      right,
      leftIsAncestor: false,
      rightIsAncestor: true,
    }),
    divergence: classifyCommitRelationship({
      left,
      right,
      leftIsAncestor: false,
      rightIsAncestor: false,
    }),
    unavailable: classifyCommitRelationship({ left, right, available: false }),
  };

  assert.deepEqual(relationships, {
    equal: 'equal',
    'right-ahead': 'right-ahead',
    'left-ahead': 'left-ahead',
    divergence: 'divergence',
    unavailable: 'unavailable',
  });
  assert.deepEqual(
    ['equal', 'right-ahead', 'left-ahead', 'divergence', 'unavailable'].map((relationship) =>
      classifyIntegrationCheckout({
        symbolicBranch: 'main',
        clean: true,
        inProgress: false,
        localHead: left,
        remoteHead: relationship === 'equal' ? left : right,
        relationship,
      }),
    ),
    ['mirrored', 'fast-forward-lag', 'local-ahead', 'divergence', 'unavailable'],
  );
  assert.equal(
    classifyIntegrationCheckout({
      symbolicBranch: 'main',
      clean: false,
      inProgress: false,
      localHead: left,
      remoteHead: left,
      relationship: 'equal',
    }),
    'dirty-or-in-progress',
  );
  assert.equal(
    classifyIntegrationCheckout({
      symbolicBranch: 'main',
      clean: true,
      inProgress: true,
      localHead: left,
      remoteHead: left,
      relationship: 'equal',
    }),
    'dirty-or-in-progress',
  );
  assert.equal(
    classifyIntegrationCheckout({
      symbolicBranch: 'main',
      clean: true,
      inProgress: false,
      localHead: left,
      remoteHead: right,
      relationship: 'equal',
    }),
    'unavailable',
  );
  assert.deepEqual(
    [
      classifyRemoteClaimLifecycle({ checkpointCommit: left, remoteHead: left, relationship: 'equal' }),
      classifyRemoteClaimLifecycle({ checkpointCommit: left, remoteHead: right, relationship: 'left-ahead' }),
      classifyRemoteClaimLifecycle({ checkpointCommit: left, remoteHead: right, relationship: 'right-ahead' }),
      classifyRemoteClaimLifecycle({ checkpointCommit: left, remoteHead: null, relationship: 'unavailable' }),
      classifyRemoteClaimLifecycle({ checkpointCommit: left, remoteHead: right, relationship: 'divergence' }),
      classifyRemoteClaimLifecycle({ checkpointCommit: left, remoteHead: right, relationship: 'unavailable' }),
    ],
    ['matched', 'local-ahead', 'remote-ahead', 'missing-branch', 'divergence', 'unavailable'],
  );
  assert.equal(
    classifyRemoteClaimLifecycle({
      checkpointCommit: left,
      remoteHead: right,
      relationship: 'equal',
    }),
    'unavailable',
  );
});

function directClaimRef(status = 'found', sha = 'b'.repeat(40)) {
  return status === 'found'
    ? {
        status,
        ref: 'refs/heads/claim-v1/issue-61',
        objectType: 'commit',
        sha,
      }
    : { status };
}

function compareEvidence(relationship, key = relationship) {
  return { status: 'available', relationship, evidenceKey: key };
}

test('authoritative lifecycle uses stable compare evidence and contained local fallback', () => {
  const checkpoint = 'a'.repeat(40);
  const remote = 'b'.repeat(40);
  assert.equal(
    authoritativeCommitRelationship({
      left: checkpoint,
      right: remote,
      compareBefore: compareEvidence('right-ahead', 'stable'),
      compareAfter: compareEvidence('right-ahead', 'stable'),
      localRelationship: 'unavailable',
    }),
    'right-ahead',
    'host compare classifies an unseen remote commit without requiring its local object',
  );
  assert.equal(
    authoritativeCommitRelationship({
      left: checkpoint,
      right: remote,
      compareBefore: compareEvidence('right-ahead', 'before'),
      compareAfter: compareEvidence('right-ahead', 'after'),
      localRelationship: 'unavailable',
    }),
    'unavailable',
  );

  const common = {
    checkpointCommit: checkpoint,
    expectedRef: 'refs/heads/claim-v1/issue-61',
    enumeratedRemoteHead: remote,
    directRefBefore: directClaimRef('found', remote),
    directRefAfter: directClaimRef('found', remote),
  };
  assert.equal(
    classifyRemoteClaimEvidence({
      ...common,
      compareBefore: compareEvidence('right-ahead', 'stable'),
      compareAfter: compareEvidence('right-ahead', 'stable'),
      localContainment: { status: 'missing', relationship: 'unavailable' },
    }).status,
    'remote-ahead',
  );
  assert.equal(
    classifyRemoteClaimEvidence({
      ...common,
      compareBefore: { status: 'missing' },
      compareAfter: { status: 'missing' },
      localContainment: { status: 'contained', relationship: 'left-ahead' },
    }).status,
    'local-ahead',
  );
  for (const evidence of [
    { ...common, directRefBefore: { status: 'malformed' } },
    { ...common, directRefAfter: { status: 'unavailable' } },
    {
      ...common,
      directRefAfter: directClaimRef('found', 'c'.repeat(40)),
    },
    {
      ...common,
      compareBefore: { status: 'missing' },
      compareAfter: { status: 'missing' },
      localContainment: { status: 'behind', relationship: 'right-ahead' },
    },
  ]) {
    assert.equal(classifyRemoteClaimEvidence(evidence).status, 'unavailable');
  }
  assert.equal(
    classifyRemoteClaimEvidence({
      ...common,
      enumeratedRemoteHead: null,
      directRefBefore: { status: 'missing' },
      directRefAfter: { status: 'missing' },
    }).status,
    'missing-branch',
  );
});

function validBootstrapEvidence() {
  const sha = 'a'.repeat(40);
  const ref = 'refs/heads/claim-v1/issue-61';
  const direct = { status: 'found', ref, objectType: 'commit', sha };
  const integration = {
    symbolicRef: 'refs/heads/main',
    head: 'b'.repeat(40),
    clean: true,
    inProgress: false,
  };
  return {
    issueNumber: 61,
    checkpointCommit: sha,
    directRefBefore: direct,
    directRefAfter: { ...direct },
    preexisting: {
      localBranch: false,
      worktreePath: false,
      branchWorktree: false,
      remoteTracking: 'missing',
    },
    fetch: {
      status: 'succeeded',
      remote: 'origin',
      sourceRef: ref,
      destinationRef: 'refs/remotes/origin/claim-v1/issue-61',
      tags: false,
      force: false,
      writeFetchHead: false,
      recurseSubmodules: false,
      autoMaintenance: false,
    },
    pushCount: 0,
    remoteTrackingHead: sha,
    localBranchHead: sha,
    branchRemote: 'origin',
    branchMerge: ref,
    claimWorktree: {
      head: sha,
      branch: ref,
      symbolicRef: ref,
      countForBranch: 1,
      locked: false,
      prunable: false,
      clean: true,
    },
    integrationBefore: integration,
    integrationAfter: { ...integration },
  };
}

test('pure bootstrap validation accepts only exact complete preserved evidence', () => {
  assert.deepEqual(validateClaimBootstrapEvidence(validBootstrapEvidence()), {
    valid: true,
    status: 'matched',
    errors: [],
  });
  const variants = [
    { preexisting: { ...validBootstrapEvidence().preexisting, localBranch: true } },
    { preexisting: { ...validBootstrapEvidence().preexisting, worktreePath: true } },
    { preexisting: { ...validBootstrapEvidence().preexisting, branchWorktree: true } },
    { preexisting: { ...validBootstrapEvidence().preexisting, remoteTracking: 'matching' } },
    { fetch: { ...validBootstrapEvidence().fetch, force: true } },
    { fetch: { ...validBootstrapEvidence().fetch, tags: true } },
    { fetch: { ...validBootstrapEvidence().fetch, status: 'non-fast-forward-refused' } },
    { pushCount: 1 },
    { directRefBefore: { status: 'missing' } },
    { directRefAfter: { status: 'malformed' } },
    { directRefAfter: directClaimRef('found', 'c'.repeat(40)) },
    { localBranchHead: null },
    { claimWorktree: null },
    { claimWorktree: { ...validBootstrapEvidence().claimWorktree, clean: false } },
    { integrationAfter: { ...validBootstrapEvidence().integrationAfter, head: 'c'.repeat(40) } },
  ];
  for (const changes of variants) {
    const result = validateClaimBootstrapEvidence({ ...validBootstrapEvidence(), ...changes });
    assert.equal(result.valid, false);
    assert.equal(result.status, 'question');
    assert(result.errors.length > 0);
  }
});

function integrationHoldComment({
  id,
  action = 'acquire',
  pr = '61',
  head = 'a'.repeat(40),
  base = 'b'.repeat(40),
  attempt = '1',
  principal = 'maintainer',
  acquiredAt = '2026-09-03T05:00:00.000Z',
  eventAt = acquiredAt,
  outcome = action === 'acquire' ? 'unclaimed' : 'integrated',
  author = principal,
  createdAt = eventAt,
  updatedAt = createdAt,
} = {}) {
  const holdId = `pr-${pr}-head-${head}-base-${base}-attempt-${attempt}`;
  return {
    id,
    author,
    createdAt,
    updatedAt,
    body: [
      '## Integration hold evidence',
      'Integration-Hold-Evidence-Version: 1',
      `Integration-Hold-Action: ${action}`,
      `Integration-Hold-ID: ${holdId}`,
      `Integration-Hold-Principal: ${principal}`,
      `Integration-Hold-PR: ${pr}`,
      `Integration-Hold-Head: ${head}`,
      `Integration-Hold-Base: ${base}`,
      `Integration-Hold-Attempt: ${attempt}`,
      `Integration-Hold-Scratch-Branch: test/integration-pr-${pr}-base-${base.slice(0, 12)}-attempt-${attempt}`,
      `Integration-Hold-Acquired-At: ${acquiredAt}`,
      `Integration-Hold-Event-At: ${eventAt}`,
      `Integration-Hold-Outcome: ${outcome}`,
    ].join('\n'),
  };
}

test('integration holds are clear, held, or released without expiry', () => {
  assert.equal(evaluateIntegrationHolds([]).status, 'clear');
  const acquisition = integrationHoldComment({ id: 1 });
  const held = evaluateIntegrationHolds([acquisition]);
  assert.equal(held.status, 'held');
  assert.equal(held.active.commentId, 1);
  assert.equal(held.questions.length, 0);

  const release = integrationHoldComment({
    id: 2,
    action: 'release',
    eventAt: '2026-09-03T06:00:00.000Z',
  });
  const clear = evaluateIntegrationHolds([acquisition, release]);
  assert.equal(clear.status, 'clear');
  assert.equal(clear.active, null);
  assert.equal(clear.questions.length, 0);
});

test('integration-hold replay rejects overlap and integrated sequence reuse globally', () => {
  const first = integrationHoldComment({ id: 1 });
  const second = integrationHoldComment({
    id: 2,
    pr: '62',
    acquiredAt: '2026-09-03T05:30:00.000Z',
  });
  const firstRelease = integrationHoldComment({
    id: 3,
    action: 'release',
    eventAt: '2026-09-03T06:00:00.000Z',
  });
  const secondRelease = integrationHoldComment({
    id: 4,
    action: 'release',
    pr: '62',
    acquiredAt: '2026-09-03T05:30:00.000Z',
    eventAt: '2026-09-03T06:30:00.000Z',
  });
  const fullyReleasedOverlap = evaluateIntegrationHolds([
    first,
    second,
    firstRelease,
    secondRelease,
  ]);
  assert.equal(fullyReleasedOverlap.status, 'question');
  assert(fullyReleasedOverlap.questions.some(({ code }) => code === 'integration-hold-overlap'));

  const abortedRelease = integrationHoldComment({
    id: 5,
    action: 'release',
    eventAt: '2026-09-03T06:00:00.000Z',
    outcome: 'aborted',
  });
  assert.equal(evaluateIntegrationHolds([first, second, abortedRelease]).status, 'question');
  const afterAbort = integrationHoldComment({
    id: 6,
    attempt: '2',
    acquiredAt: '2026-09-03T06:30:00.000Z',
  });
  assert.equal(evaluateIntegrationHolds([first, abortedRelease, afterAbort]).status, 'held');
  const reusedAttempt = integrationHoldComment({
    id: 8,
    head: 'c'.repeat(40),
    acquiredAt: '2026-09-03T06:30:00.000Z',
  });
  assert.equal(evaluateIntegrationHolds([first, abortedRelease, reusedAttempt]).status, 'question');

  const integratedReuse = integrationHoldComment({
    id: 7,
    attempt: '2',
    acquiredAt: '2026-09-03T06:30:00.000Z',
  });
  assert.equal(evaluateIntegrationHolds([first, firstRelease, integratedReuse]).status, 'question');
});

test('integration-hold grammar, author, edit, pairing, and singleton rules fail closed', () => {
  const malformed = integrationHoldComment({ id: 1, author: 'other-principal' });
  const missingHeading = integrationHoldComment({ id: 10 });
  missingHeading.body = missingHeading.body.replace('## Integration hold evidence\n', '');
  const edited = integrationHoldComment({
    id: 2,
    updatedAt: '2026-09-03T05:01:00.000Z',
  });
  const orphanRelease = integrationHoldComment({
    id: 3,
    action: 'release',
    eventAt: '2026-09-03T06:00:00.000Z',
  });
  const reordered = integrationHoldComment({ id: 6 });
  reordered.body = reordered.body.replace(
    'Integration-Hold-Action: acquire\nIntegration-Hold-ID:',
    'Integration-Hold-ID:',
  ).replace(
    'Integration-Hold-Principal: maintainer',
    'Integration-Hold-Principal: maintainer\nIntegration-Hold-Action: acquire',
  );
  const multiple = [
    integrationHoldComment({ id: 4 }),
    integrationHoldComment({ id: 5, pr: '62' }),
  ];
  const unsafeInteger = integrationHoldComment({ id: 7, attempt: '9007199254740992' });
  const releaseBeforeAcquisition = [
    integrationHoldComment({ id: 9, createdAt: '2026-09-03T05:30:00.000Z' }),
    integrationHoldComment({
      id: 8,
      action: 'release',
      createdAt: '2026-09-03T04:30:00.000Z',
      eventAt: '2026-09-03T06:00:00.000Z',
    }),
  ];

  for (const comments of [
    [malformed],
    [missingHeading],
    [edited],
    [orphanRelease],
    [reordered],
    multiple,
    [unsafeInteger],
    releaseBeforeAcquisition,
  ]) {
    const result = evaluateIntegrationHolds(comments);
    assert.equal(result.status, 'question');
    assert(result.questions.length > 0);
    assert(result.questions.every(({ code }) => code.startsWith('integration-hold-')));
  }
});
