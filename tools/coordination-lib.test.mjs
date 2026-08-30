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

const EMPTY_LOCAL = { branches: [], worktrees: [], status: "" };

test("structured fields read exact portable names and report duplicates", () => {
  const body = "Claim-State: ready\nClaim-Agent: first\nClaim-Agent: second\n";
  const record = structuredFields(body);

  assert.equal(claimField(body, "Claim-State"), "ready");
  assert.equal(record.fields["Claim-Agent"], "second");
  assert.deepEqual(record.duplicates, ["Claim-Agent"]);
  assert.equal(claimField(body, "Claim-Run-ID"), "missing");
});

test("deadlines distinguish current, overdue, unknown, and invalid", () => {
  assert.equal(deadlineStatus("2026-08-29T21:00:00Z", NOW), "current");
  assert.equal(deadlineStatus("2026-08-29T19:00:00Z", NOW), "overdue");
  assert.equal(deadlineStatus("unclaimed", NOW), "unknown");
  assert.equal(deadlineStatus("tomorrowish", NOW), "invalid");
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

test("claim signals without structured fields remain ambiguous", () => {
  assert.equal(hasClaimSignal("Claimed by another session; checkpoint pending."), true);
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
