#!/usr/bin/env node

import { spawnSync } from "node:child_process";

import {
  claimField as field,
  deadlineStatus as isoStatus,
  staleClaimReason,
} from "./coordination-lib.mjs";

const REQUIRED_LABELS = [
  "work:plan",
  "work:proposed",
  "work:ready",
  "work:active",
  "work:blocked",
  "work:review",
  "work:done",
  "work:abandoned",
];
const OPEN_WORK_LABELS = new Set([
  "work:plan",
  "work:proposed",
  "work:ready",
  "work:active",
  "work:blocked",
  "work:review",
]);

function run(command, args, { allowFailure = false } = {}) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.error || (!allowFailure && result.status !== 0)) {
    const detail =
      result.error?.message ||
      result.stderr?.trim() ||
      (result.signal ? `terminated by ${result.signal}` : `exit status ${result.status}`);
    throw new Error(`${command} ${args.join(" ")} failed: ${detail}`);
  }
  return result;
}

function labels(issue) {
  return issue.labels.map((label) => label.name);
}

function section(title) {
  process.stdout.write(`\n## ${title}\n`);
}

let hasWarning = false;

try {
  section("Local Git state");
  const status = run("git", ["status", "--short", "--branch"]).stdout.trim();
  console.log(status || "clean");

  section("Local worktrees");
  console.log(run("git", ["worktree", "list"]).stdout.trim() || "none");

  const ghVersion = run("gh", ["--version"], { allowFailure: true });
  if (ghVersion.status !== 0) {
    throw new Error("GitHub CLI is unavailable; the shared registry cannot be verified");
  }
  const auth = run("gh", ["auth", "status"], { allowFailure: true });
  if (auth.status !== 0) {
    throw new Error("GitHub CLI is not authenticated; the shared registry cannot be verified");
  }

  const repository = run("gh", ["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"]).stdout.trim();
  section("Shared registry");
  console.log(repository);

  const availableLabels = new Set(
    JSON.parse(run("gh", ["label", "list", "--limit", "200", "--json", "name"]).stdout).map((entry) => entry.name),
  );
  const missingLabels = REQUIRED_LABELS.filter((label) => !availableLabels.has(label));
  if (missingLabels.length > 0) {
    hasWarning = true;
    console.log(`WARNING missing coordination labels: ${missingLabels.join(", ")}`);
  }

  const issues = JSON.parse(
    run("gh", [
      "issue",
      "list",
      "--state",
      "open",
      "--limit",
      "200",
      "--json",
      "number,title,body,labels,updatedAt,url",
    ]).stdout,
  ).filter((issue) => labels(issue).some((label) => OPEN_WORK_LABELS.has(label)));

  const plans = issues.filter((issue) => labels(issue).includes("work:plan"));
  section("Shared plans");
  if (plans.length === 0) console.log("none");
  for (const issue of plans) {
    console.log(`#${issue.number} [${field(issue.body, "Plan-State")}] ${issue.title} (${issue.url})`);
    console.log(`  updated=${issue.updatedAt} integration-owner=${field(issue.body, "Integration-Owner")}`);
  }

  const workItems = issues.filter((issue) => !labels(issue).includes("work:plan"));
  section("Open work claims");
  if (workItems.length === 0) console.log("none");
  const now = Date.now();
  const stale = [];
  for (const issue of workItems) {
    const state = field(issue.body, "Claim-State");
    const checkIn = field(issue.body, "Check-In-By");
    const deadlineStatus = isoStatus(checkIn, now);
    const summary = `#${issue.number} [${state}] ${issue.title}`;
    console.log(`${summary} (${issue.url})`);
    console.log(
      `  parent=${field(issue.body, "Parent-Plan")} harness=${field(issue.body, "Claim-Harness")} agent=${field(issue.body, "Claim-Agent")}`,
    );
    console.log(
      `  branch=${field(issue.body, "Claim-Branch")} worktree=${field(issue.body, "Claim-Worktree")} check-in=${checkIn} (${deadlineStatus})`,
    );
    const staleReason = staleClaimReason(state, checkIn, now);
    if (staleReason) stale.push({ issue, reason: staleReason });
  }

  const prs = JSON.parse(
    run("gh", ["pr", "list", "--state", "open", "--limit", "100", "--json", "number,title,headRefName,baseRefName,updatedAt,url"]).stdout,
  );
  section("Open pull requests");
  if (prs.length === 0) console.log("none");
  for (const pr of prs) {
    console.log(`#${pr.number} ${pr.headRefName} -> ${pr.baseRefName}: ${pr.title} (${pr.url}) updated=${pr.updatedAt}`);
  }

  section("Suspected cleanup or stale work");
  if (stale.length === 0) console.log("none detected from registry deadlines");
  for (const item of stale) {
    hasWarning = true;
    console.log(`ASK MAINTAINER: #${item.issue.number} ${item.reason}; do not take over or clean automatically`);
  }

  if (issues.length === 0 && prs.length === 0) {
    console.log("Registry currently has no open coordinated work. Confirm this is expected before editing shared scope.");
  }
} catch (error) {
  hasWarning = true;
  console.error(`\nCOORDINATION UNKNOWN: ${error.message}`);
  console.error("Do not assume work is unclaimed. Inspect Git/worktrees and ask the maintainer before overlapping work.");
}

process.exitCode = hasWarning ? 2 : 0;
