#!/usr/bin/env node

// Read-only view of the coordination registry: what is being worked on, what can start now, what
// is waiting, and what looks wrong. It changes nothing and it never fails as a policy signal —
// a nonzero exit means the registry could not be read, not that the board disliked what it saw.

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  bodyFields,
  FIELD_NAMES,
  hasUnclaimedOwnership,
  isDelivered,
  isUnclaimed,
  lifecycle,
  normalizeIssue,
  parseDependsOn,
  parseScopePaths,
  readBodyField,
  claimBranch,
} from './coordination-fields.mjs';
export { parseDependsOn, parseScopePath, parseScopePaths } from './coordination-fields.mjs';

export const REPOSITORY = 'money-noodle/money-noodle';
export const STALE_CLAIM_DAYS = 3;
const CLAIM_BRANCH = /^claim-v1\/issue-([1-9]\d*)$/;

// Node's default child-process buffer is 1 MiB and a growing registry silently blew past it
// (issue #110). Read one bounded page at a time with an explicit ceiling, cap the number of pages,
// and cap what is printed, so neither the read nor the output can grow without limit.
export const MAX_BUFFER_BYTES = 16 * 1024 * 1024;
export const MAX_PAGES = 20;
export const PAGE_SIZE = 100;
const MAX_LISTED = 40;

/* ------------------------------------------------------------------ parsing */

export function scopeEntriesIntersect(left, right) {
  if (left.kind === 'root' || right.kind === 'root') return true;
  if (left.kind === 'exact' && right.kind === 'exact') return left.path === right.path;
  if (left.kind === 'exact') return left.path.startsWith(`${right.prefix}/`);
  if (right.kind === 'exact') return right.path.startsWith(`${left.prefix}/`);
  return (
    left.prefix === right.prefix ||
    left.prefix.startsWith(`${right.prefix}/`) ||
    right.prefix.startsWith(`${left.prefix}/`)
  );
}

export function scopeOverlap(left, right) {
  const shared = [];
  for (const leftEntry of left) {
    for (const rightEntry of right) {
      if (scopeEntriesIntersect(leftEntry, rightEntry)) {
        if (!shared.includes(leftEntry.value)) shared.push(leftEntry.value);
        if (!shared.includes(rightEntry.value)) shared.push(rightEntry.value);
      }
    }
  }
  return shared;
}

export const readField = readBodyField;

const isIsoInstant = (value) =>
  typeof value === 'string' && !Number.isNaN(Date.parse(value)) && /\d{4}-\d{2}-\d{2}T/.test(value);

// A body that is missing or malformed never throws; it yields warnings and the item still shows up.
export function parseWorkItem(issue) {
  const body = typeof issue?.body === 'string' ? issue.body : '';
  const labels = Array.isArray(issue?.labels) ? issue.labels : [];
  const state = lifecycle(labels);
  const plan = labels.includes('work:plan');
  const fields = bodyFields(body);
  const scope = parseScopePaths(readField(body, 'Scope-Paths'));
  const dependsOn = parseDependsOn(readField(body, 'Depends-On'));
  const claimedAt = readField(body, 'Claimed-At');
  const warnings = [];
  if (!state) warnings.push('lifecycle label is missing or contradictory; reconcile labels');
  for (const name of FIELD_NAMES) {
    if (fields.get(name).length > 1) warnings.push(`${name} is duplicated; reconcile the body`);
  }
  if (!plan) {
    if (scope.status === 'invalid') warnings.push('Scope-Paths is malformed; overlap is unknown');
    if (scope.status === 'missing') warnings.push('Scope-Paths is absent; overlap is unknown');
    if (dependsOn.status === 'invalid') warnings.push('Depends-On is malformed');
    if (dependsOn.status === 'missing') warnings.push('Depends-On is absent');
    for (const name of ['Claim-Agent', 'Claim-Branch', 'Claimed-At', 'Integration-Owner']) {
      const value = readField(body, name);
      if (
        (value === undefined &&
          name !== 'Integration-Owner' &&
          ['active', 'review'].includes(state)) ||
        (value !== undefined && (!value || value === '_No response_' || /[\r\n]/.test(value)))
      )
        warnings.push(`${name} is missing or malformed`);
    }
    if (['active', 'review'].includes(state) && !isIsoInstant(claimedAt))
      warnings.push('Claimed-At is not an ISO instant; age unknown');
    if (
      ['active', 'review'].includes(state) &&
      (isUnclaimed(readField(body, 'Claim-Agent')) ||
        readField(body, 'Claim-Branch') !== claimBranch(issue.number))
    )
      warnings.push('active/review ownership is incomplete or contradicts the reserved branch');
    if (['proposed', 'ready'].includes(state) && !hasUnclaimedOwnership(body))
      warnings.push('parked issue has missing or conflicting ownership; reconcile before claiming');
  }
  const parentPlan = readField(body, 'Parent-Plan');
  if (parentPlan !== undefined && parentPlan !== 'none' && !/^#[1-9]\d*$/.test(parentPlan))
    warnings.push('Parent-Plan is malformed');
  return {
    number: issue?.number,
    title: issue?.title ?? '',
    open: issue?.state === 'open',
    labels,
    state: state ?? 'unknown',
    plan,
    agent: readField(body, 'Claim-Agent') ?? 'unknown',
    branch: readField(body, 'Claim-Branch') ?? 'unknown',
    claimedAt: isIsoInstant(claimedAt) ? claimedAt : null,
    ageDays: null,
    integrationOwner: readField(body, 'Integration-Owner') ?? 'maintainer',
    parentPlan: parentPlan ?? null,
    dependencyNotes: readField(body, 'Dependency-Notes') ?? null,
    scopeStatus: scope.status,
    scopePaths: scope.entries.map((entry) => entry.value),
    scopeEntries: scope.entries,
    dependencyStatus: dependsOn.status,
    dependsOn: dependsOn.numbers,
    delivered: isDelivered({ ...issue, labels }),
    warnings,
  };
}

/* ------------------------------------------------------------------- report */

export function buildReport({ issues, claimBranches, now = new Date() }) {
  if (!Array.isArray(issues) || !Array.isArray(claimBranches))
    throw new Error('registry input missing; coordination unknown');
  const items = issues.filter((issue) => !issue.pull_request).map(parseWorkItem);
  if (
    items.some((item) => !Number.isSafeInteger(item.number)) ||
    new Set(items.map((item) => item.number)).size !== items.length
  )
    throw new Error('invalid or duplicate issue identity; coordination unknown');
  const byNumber = new Map(items.map((item) => [item.number, item]));
  const warnings = [];
  const claimedNumbers = new Set();
  for (const branch of claimBranches) {
    const match = String(branch).match(CLAIM_BRANCH);
    if (!match || !Number.isSafeInteger(Number(match[1]))) {
      warnings.push(`${branch}: unrecognized reserved ref; inspect ownership manually`);
      continue;
    }
    const number = Number(match[1]);
    claimedNumbers.add(number);
    const item = byNumber.get(number);
    if (!item)
      warnings.push(`${branch} exists but issue #${number} is unknown; inspect the reservation`);
    else if (item.open && !['active', 'review'].includes(item.state))
      item.warnings.push(
        `${branch} reserves this issue despite incomplete bookkeeping; finish by hand, do not reclaim`,
      );
  }

  // A small graph walk detects cycles, including cycles through closed prerequisites.
  const cyclic = new Set();
  const visited = new Set();
  const visiting = [];
  function visit(number) {
    const start = visiting.indexOf(number);
    if (start !== -1) {
      visiting.slice(start).forEach((entry) => cyclic.add(entry));
      return;
    }
    if (visited.has(number)) return;
    visiting.push(number);
    for (const dependency of byNumber.get(number)?.dependsOn ?? []) visit(dependency);
    visiting.pop();
    visited.add(number);
  }
  for (const item of items) visit(item.number);

  const report = {
    generatedAt: now.toISOString(),
    coordinationKnown: true,
    plans: [],
    items: [],
    active: [],
    review: [],
    ready: [],
    blocked: [],
    proposed: [],
    done: [],
    abandoned: [],
    unknown: [],
    reservations: [],
    overlaps: [],
    warnings,
  };
  for (const item of items) {
    item.reserved = claimedNumbers.has(item.number);
    item.ageDays = item.claimedAt
      ? Math.round(((now.getTime() - Date.parse(item.claimedAt)) / 86_400_000) * 10) / 10
      : null;
    if (item.open && !item.plan && ['active', 'review'].includes(item.state)) {
      if (!item.reserved)
        item.warnings.push(`${claimBranch(item.number)} does not exist; inspect ownership`);
      if (item.ageDays > STALE_CLAIM_DAYS)
        item.warnings.push(
          `claimed ${Math.floor(item.ageDays)} days ago by ${item.agent}; check progress, never auto-release`,
        );
      if (item.ageDays < 0) item.warnings.push('Claimed-At is in the future; age is unreliable');
    }
    item.blockedBy = [];
    item.blockReasons = [];
    if (!item.plan) {
      if (!['none', 'declared'].includes(item.dependencyStatus))
        item.blockReasons.push('dependency declaration unknown');
      if (cyclic.has(item.number)) {
        item.blockReasons.push('dependency cycle or self-reference');
        item.warnings.push('dependency cycle or self-reference; correct Depends-On');
      }
      for (const number of item.dependsOn) {
        const dependency = byNumber.get(number);
        if (!dependency || !dependency.delivered || cyclic.has(number)) {
          item.blockedBy.push(number);
          if (!dependency)
            item.warnings.push(
              `Depends-On names #${number}, which is not in the registry; verify the prerequisite`,
            );
          else if (!dependency.open)
            item.warnings.push(
              `Depends-On #${number} is not known delivered or has a cycle; reconcile completion`,
            );
        }
      }
      if (item.state === 'blocked')
        item.blockReasons.push('explicit work:blocked; consult Integration-Owner');
      if (item.reserved && !['active', 'review'].includes(item.state) && item.open)
        item.blockReasons.push('reserved claim ref');
      if (item.warnings.length && ['ready', 'proposed', 'unknown'].includes(item.state))
        item.blockReasons.push('record needs reconciliation');
    }
    item.dependenciesClear =
      item.blockedBy.length === 0 &&
      !item.blockReasons.includes('dependency declaration unknown') &&
      !cyclic.has(item.number);
    const { scopeEntries, delivered, ...row } = item;
    if (item.plan) report.plans.push(row);
    else {
      report.items.push(row);
      if (item.reserved || (item.open && ['active', 'review'].includes(item.state)))
        report.reservations.push(row);
      if (!item.open) {
        if (['done', 'abandoned'].includes(item.state)) report[item.state].push(row);
      } else if (item.state === 'ready') {
        report[item.blockedBy.length || item.blockReasons.length ? 'blocked' : 'ready'].push(row);
      } else {
        report[item.state].push(row);
        if (item.state === 'proposed' && (item.blockedBy.length || item.blockReasons.length))
          report.blocked.push(row);
      }
    }
    if (item.open)
      for (const warning of item.warnings) warnings.push(`#${item.number}: ${warning}`);
  }

  const current = items.filter(
    (item) =>
      !item.plan && item.open && (['active', 'review'].includes(item.state) || item.reserved),
  );
  for (let left = 0; left < current.length; left += 1) {
    for (let right = left + 1; right < current.length; right += 1) {
      const shared = scopeOverlap(current[left].scopeEntries, current[right].scopeEntries);
      if (shared.length)
        report.overlaps.push({
          issues: [current[left].number, current[right].number],
          paths: shared,
        });
    }
  }
  for (const key of [
    'plans',
    'items',
    'active',
    'review',
    'ready',
    'blocked',
    'proposed',
    'done',
    'abandoned',
    'unknown',
    'reservations',
  ])
    report[key].sort((a, b) => a.number - b.number);
  return report;
}

/* ------------------------------------------------------------------ render */

const trim = (text, limit = 72) => (text.length > limit ? `${text.slice(0, limit - 1)}…` : text);

function section(lines, heading, entries, format) {
  lines.push(`${heading} (${entries.length})`);
  if (entries.length === 0) {
    lines.push('  none');
  } else {
    for (const entry of entries.slice(0, MAX_LISTED)) lines.push(`  ${trim(format(entry), 500)}`);
    if (entries.length > MAX_LISTED) lines.push(`  … and ${entries.length - MAX_LISTED} more`);
  }
  lines.push('');
}

export function renderReport(report) {
  const lines = [`Coordination status — ${report.generatedAt}`, ''];
  section(
    lines,
    'Shared plans',
    report.plans,
    (entry) =>
      `#${entry.number} ${trim(entry.title)} — ${entry.state}; editor/integration owner: ${entry.integrationOwner}`,
  );
  for (const state of ['active', 'review'])
    section(lines, state === 'active' ? 'Active' : 'Review', report[state], (entry) => {
      const age = entry.ageDays === null ? 'age unknown' : `${entry.ageDays}d`;
      const scope =
        entry.scopePaths.length > 0
          ? entry.scopePaths.join(', ')
          : entry.scopeStatus === 'none'
            ? 'none'
            : 'unknown';
      return `#${entry.number} ${trim(entry.title)} — ${entry.agent} on ${entry.branch} (${age})\n      scope: ${trim(scope, 90)}`;
    });
  section(
    lines,
    'Ready (dependencies clear)',
    report.ready,
    (e) => `#${e.number} ${trim(e.title)}`,
  );
  section(
    lines,
    'Blocked',
    report.blocked,
    (e) =>
      `#${e.number} ${trim(e.title)} — ${[e.blockedBy.length ? `waiting on ${e.blockedBy.map((n) => `#${n}`).join(', ')}` : '', ...e.blockReasons].filter(Boolean).join('; ')}`,
  );
  section(lines, 'Proposed', report.proposed, (e) => `#${e.number} ${trim(e.title)}`);
  for (const state of ['done', 'abandoned', 'unknown'])
    section(lines, state, report[state], (e) => `#${e.number} ${trim(e.title)}`);
  section(
    lines,
    'Overlaps (warning only)',
    report.overlaps,
    (e) => `#${e.issues[0]} and #${e.issues[1]} both declare ${trim(e.paths.join(', '), 90)}`,
  );
  section(lines, 'Warnings', report.warnings, (warning) => trim(warning, 110));
  return lines.join('\n');
}

/* --------------------------------------------------------------- gh access */

function gh(args) {
  const result = spawnSync('gh', args, {
    encoding: 'utf8',
    timeout: 60_000,
    maxBuffer: MAX_BUFFER_BYTES,
  });
  if (result.error?.code === 'ENOBUFS') {
    throw new Error(
      `gh ${args.join(' ')} produced more than ${MAX_BUFFER_BYTES} bytes; the registry read failed`,
    );
  }
  if (result.error) throw new Error(`gh ${args.join(' ')} failed: ${result.error.message}`);
  if (result.status !== 0) {
    throw new Error(
      `gh ${args.join(' ')} failed: ${result.stderr.trim() || `exit ${result.status}`}`,
    );
  }
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(`gh ${args.join(' ')} returned invalid JSON: ${error.message}`);
  }
}

export function pages(endpoint, request = gh) {
  const collected = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const separator = endpoint.includes('?') ? '&' : '?';
    const batch = request(['api', `${endpoint}${separator}per_page=${PAGE_SIZE}&page=${page}`]);
    if (!Array.isArray(batch)) throw new Error(`gh api ${endpoint} did not return an array`);
    collected.push(...batch);
    if (batch.length < PAGE_SIZE) return collected;
  }
  throw new Error(`gh api ${endpoint} exceeded ${MAX_PAGES} pages; narrow the query`);
}

export function readRegistry(root = `repos/${REPOSITORY}`, request = gh) {
  const issues = pages(`${root}/issues?state=all`, request)
    .map(normalizeIssue)
    .filter((record) => !record.pull_request);
  const claimBranches = pages(`${root}/git/matching-refs/heads/claim-v`, request).map((record) => {
    if (
      typeof record?.ref !== 'string' ||
      !record.ref.startsWith('refs/heads/claim-v') ||
      record.object?.type !== 'commit' ||
      !/^[a-f0-9]{40}$/.test(record.object?.sha ?? '')
    )
      throw new Error('malformed claim ref response; coordination unknown');
    return record.ref.replace(/^refs\/heads\//, '');
  });
  return { issues, claimBranches };
}

export function main(argv = process.argv.slice(2), read = readRegistry) {
  const json = argv.includes('--json');
  const unknown = argv.filter((argument) => argument !== '--json');
  if (unknown.length > 0) {
    process.stderr.write(`unknown argument ${unknown[0]}\n`);
    return 2;
  }
  try {
    const report = buildReport({ ...read(), now: new Date() });
    process.stdout.write(
      json ? `${JSON.stringify(report, null, 2)}\n` : `${renderReport(report)}\n`,
    );
    return 0;
  } catch (error) {
    const message = `Coordination unknown: ${error.message}`;
    if (json)
      process.stdout.write(`${JSON.stringify({ coordinationKnown: false, error: message })}\n`);
    process.stderr.write(`${message}\n`);
    return 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
