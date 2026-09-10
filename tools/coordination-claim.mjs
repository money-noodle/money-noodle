#!/usr/bin/env node

// The deterministic ref is the mutex. Only a confirmed creator may do bookkeeping;
// all partial or ambiguous outcomes preserve the reservation for manual resolution.

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  bodyFields,
  FIELD_NAMES,
  claimBranch,
  claimRef,
  hasUnclaimedOwnership,
  isDelivered,
  isUnclaimed,
  lifecycle,
  normalizeIssue,
  parseDependsOn,
  parseScopePaths,
  readBodyField,
  setBodyField,
} from './coordination-fields.mjs';
export { claimBranch, claimRef, readBodyField, setBodyField } from './coordination-fields.mjs';

export const REPOSITORY = 'money-noodle/money-noodle';
export const CLAIMABLE_LABELS = ['work:proposed', 'work:ready'];
export const ACTIVE_LABEL = 'work:active';

export function applyClaimFields(body, { agent, branch, claimedAt }) {
  let updated = setBodyField(body, 'Claim-Agent', agent);
  updated = setBodyField(updated, 'Claim-Branch', branch);
  return setBodyField(updated, 'Claimed-At', claimedAt);
}

export function checkClaimable(issue) {
  if (!issue || typeof issue !== 'object') return 'issue could not be read';
  if (issue.pull_request) return 'record is a pull request, not a work issue';
  if (issue.state !== 'open') return `issue is ${issue.state}, not open`;
  const labels = Array.isArray(issue.labels) ? issue.labels : [];
  if (labels.includes('work:plan')) return 'shared plans are not claim candidates';
  if (!CLAIMABLE_LABELS.includes(`work:${lifecycle(labels)}`))
    return 'issue must carry one unambiguous proposed or ready lifecycle label';
  const fields = bodyFields(issue.body);
  for (const name of FIELD_NAMES) {
    if (fields.get(name).length > 1) return `${name} is duplicated`;
  }
  if (!hasUnclaimedOwnership(issue.body)) return 'ownership metadata is partial or not unclaimed';
  if (
    !['none', 'declared'].includes(parseScopePaths(readBodyField(issue.body, 'Scope-Paths')).status)
  )
    return 'Scope-Paths is missing or malformed';
  if (
    !['none', 'declared'].includes(parseDependsOn(readBodyField(issue.body, 'Depends-On')).status)
  )
    return 'Depends-On is missing or malformed';
  const owner = readBodyField(issue.body, 'Integration-Owner');
  if (owner !== undefined && (!owner || owner === '_No response_' || /[\r\n]/.test(owner)))
    return 'Integration-Owner is missing or malformed';
  const parent = readBodyField(issue.body, 'Parent-Plan');
  if (parent !== undefined && parent !== 'none' && !/^#[1-9]\d*$/.test(parent))
    return 'Parent-Plan is malformed';
  return undefined;
}

function validateInputs(issue, agent) {
  if (!Number.isSafeInteger(issue) || issue <= 0)
    throw new Error('--issue <positive safe integer> is required');
  if (
    typeof agent !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(agent) ||
    isUnclaimed(agent)
  )
    throw new Error(
      '--agent <label> is required (1–100 letters, digits, dots, underscores or hyphens; not an ownership sentinel)',
    );
}

export async function claim({ issue: issueNumber, agent, api, now = () => new Date() }) {
  validateInputs(issueNumber, agent);
  const branch = claimBranch(issueNumber);
  const ref = claimRef(issueNumber);
  let issue, sha;
  try {
    issue = await api.getIssue(issueNumber);
    if (issue?.number !== issueNumber) throw new Error('issue identity mismatch');
    const problem = checkClaimable(issue);
    if (problem) return { outcome: 'not-claimable', issue: issueNumber, detail: problem };
    for (const number of parseDependsOn(readBodyField(issue.body, 'Depends-On')).numbers) {
      if (number === issueNumber)
        return {
          outcome: 'not-claimable',
          issue: issueNumber,
          detail: 'Depends-On is self-referential',
        };
      const dependency = await api.getIssue(number);
      if (dependency?.number !== number || dependency.pull_request || !isDelivered(dependency))
        return {
          outcome: 'not-claimable',
          issue: issueNumber,
          detail: `prerequisite #${number} is not known delivered`,
        };
    }
    sha = await api.getMainSha();
    if (!/^[a-f0-9]{40}$/.test(sha ?? '')) throw new Error('main did not name a commit SHA');
  } catch (error) {
    return { outcome: 'read-failed', issue: issueNumber, detail: error.message };
  }

  // Resolve the timestamp before the sole ref attempt: local failure cannot orphan a ref.
  const claimedAt = now().toISOString();
  let created;
  try {
    created = await api.createRef({ ref, sha });
  } catch (error) {
    created = { statusCode: 0, message: error.message };
  }
  if (created?.statusCode === 422) {
    // Validation Failed also covers invalid requests. Only exact-ref evidence proves a reservation.
    const existing = await api.getRef(branch).catch(() => undefined);
    if (
      existing?.ref === ref &&
      existing.object?.type === 'commit' &&
      /^[a-f0-9]{40}$/.test(existing.object.sha ?? '')
    ) {
      const current = await api.getIssue(issueNumber).catch(() => undefined);
      return {
        outcome: 'already-claimed',
        issue: issueNumber,
        branch,
        holder: readBodyField(current?.body, 'Claim-Agent') ?? 'unknown',
        claimedAt: readBodyField(current?.body, 'Claimed-At') ?? 'unknown',
      };
    }
  }
  if (
    created?.statusCode !== 201 ||
    created.ref !== ref ||
    created.object?.type !== 'commit' ||
    created.object.sha !== sha
  ) {
    return {
      outcome: 'ref-create-failed',
      issue: issueNumber,
      branch,
      detail: `POST /git/refs answered ${created?.statusCode ?? 'unknown'} without confirmed creation${created?.message ? `: ${created.message}` : ''}`,
    };
  }

  try {
    // Preserve unrelated freshly observed changes. GitHub's ordinary body/labels PATCH is not
    // CAS: edits racing after this read can still collide; do not build a distributed writer.
    const current = await api.getIssue(issueNumber);
    const problem = checkClaimable(current);
    if (current?.number !== issueNumber || problem)
      throw new Error(`issue changed after reservation: ${problem ?? 'identity mismatch'}`);
    if (
      readBodyField(current.body, 'Depends-On') !== readBodyField(issue.body, 'Depends-On') ||
      readBodyField(current.body, 'Scope-Paths') !== readBodyField(issue.body, 'Scope-Paths')
    )
      throw new Error('scope or prerequisites changed after reservation; reconcile by hand');
    await api.updateIssue(issueNumber, {
      body: applyClaimFields(current.body, { agent, branch, claimedAt }),
      labels: [
        ...current.labels.filter((label) => !CLAIMABLE_LABELS.includes(label)),
        ACTIVE_LABEL,
      ],
    });
  } catch (error) {
    return {
      outcome: 'issue-update-failed',
      issue: issueNumber,
      branch,
      sha,
      claimedAt,
      agent,
      detail: error.message,
    };
  }
  return { outcome: 'claimed', issue: issueNumber, branch, sha, agent, claimedAt };
}

export function worktreeSetupCommand(issue, branch) {
  return `git worktree add "$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")/.worktrees/issue-${issue}" "${branch}"`;
}

export function renderResult(result) {
  const branch = result.branch;
  switch (result.outcome) {
    case 'claimed':
      return [
        `Claimed issue #${result.issue} as ${result.agent}.`,
        `Branch: ${branch} (at ${result.sha})`,
        '',
        `git fetch --no-tags origin "${branch}"`,
        worktreeSetupCommand(result.issue, branch),
      ].join('\n');
    case 'already-claimed':
      return `Issue #${result.issue} is reserved by ${branch}; recorded holder ${result.holder} (since ${result.claimedAt}). This attempt made no issue mutation. Do not adopt or delete the ref.`;
    case 'not-claimable':
      return `Issue #${result.issue} is not claimable: ${result.detail}. Nothing was changed.`;
    case 'ref-create-failed':
      return `Claim outcome unknown for issue #${result.issue}: ${result.detail}. The ref may exist; inspect ${branch} and reconcile manually. Do not retry, adopt, or delete it. No issue mutation was attempted.`;
    case 'read-failed':
      return `Coordination unknown for issue #${result.issue}: ${result.detail}. No mutation was attempted.`;
    case 'issue-update-failed':
      return [
        `You own ${branch} — the ref was created. Updating the issue failed: ${result.detail}`,
        'Preserve the reservation. Inspect the current issue before finishing by hand (the PATCH may have applied):',
        `  gh issue edit ${result.issue} --add-label ${ACTIVE_LABEL} --remove-label work:ready --remove-label work:proposed`,
        `  set Claim-Agent: ${result.agent}, Claim-Branch: ${branch}, Claimed-At: ${result.claimedAt}`,
        'Do not delete the ref.',
      ].join('\n');
    default:
      return `Unknown outcome: ${result.outcome}`;
  }
}

function gh(args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn('gh', args, { stdio: ['pipe', 'pipe', 'pipe'], timeout: 60_000 });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('error', reject);
    child.stdin.on('error', reject);
    child.on('close', (status, signal) =>
      resolve({
        status,
        stdout,
        stderr: stderr || (signal ? `gh ended with ${signal}; request outcome may be unknown` : ''),
      }),
    );
    child.stdin.end(input);
  });
}

async function ghJson(args, context) {
  const response = await gh(args);
  if (response.status !== 0) throw new Error(`${context}: ${response.stderr.trim()}`);
  try {
    return JSON.parse(response.stdout);
  } catch (error) {
    throw new Error(`${context}: invalid JSON (${error.message})`);
  }
}

export function githubApi(root = `repos/${REPOSITORY}`) {
  return {
    async getIssue(number) {
      const record = await ghJson(['api', `${root}/issues/${number}`], `read issue #${number}`);
      return normalizeIssue(record);
    },
    async getRef(branch) {
      return ghJson(['api', `${root}/git/ref/heads/${branch}`], 'read claim ref');
    },
    async getMainSha() {
      const record = await ghJson(['api', `${root}/git/ref/heads/main`], 'read main');
      if (record.ref !== 'refs/heads/main' || record.object?.type !== 'commit')
        throw new Error('malformed main ref response');
      return record.object.sha;
    },
    async createRef({ ref, sha }) {
      const response = await gh(
        ['api', '--include', '--method', 'POST', `${root}/git/refs`, '--input', '-'],
        JSON.stringify({ ref, sha }),
      );
      const status = response.stdout.match(/^HTTP\/\S+\s+(\d{3})/);
      let record;
      try {
        record = JSON.parse(
          response.stdout
            .split(/\r?\n\r?\n/)
            .slice(1)
            .join('\n\n'),
        );
      } catch {
        /* Unconfirmed response: never adopt. */
      }
      return {
        statusCode: status ? Number(status[1]) : 0,
        ref: record?.ref,
        object: record?.object,
        message: response.stderr.trim(),
      };
    },
    async updateIssue(number, { body, labels }) {
      const response = await gh(
        ['api', '--method', 'PATCH', `${root}/issues/${number}`, '--input', '-'],
        JSON.stringify({ body, labels }),
      );
      if (response.status !== 0) throw new Error(response.stderr.trim());
      const updated = normalizeIssue(JSON.parse(response.stdout));
      if (
        updated.number !== number ||
        updated.state !== 'open' ||
        updated.body !== body ||
        [...updated.labels].sort().join('\n') !== [...labels].sort().join('\n')
      ) {
        throw new Error(
          'issue update response differs from the requested bookkeeping; inspect current state',
        );
      }
    },
  };
}

export function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--issue') {
      if (options.issue !== undefined || !/^[1-9]\d*$/.test(argv[index + 1] ?? ''))
        throw new Error('--issue must be one canonical positive integer');
      options.issue = Number(argv[(index += 1)]);
    } else if (argv[index] === '--agent') {
      if (options.agent !== undefined) throw new Error('duplicate --agent');
      options.agent = argv[(index += 1)];
    } else throw new Error(`unknown argument ${argv[index]}`);
  }
  validateInputs(options.issue, options.agent);
  return options;
}

export async function main(argv = process.argv.slice(2), api = githubApi()) {
  const result = await claim({ ...parseArguments(argv), api });
  process.stdout.write(`${renderResult(result)}\n`);
  return result.outcome === 'claimed' ? 0 : 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
    },
  );
}
