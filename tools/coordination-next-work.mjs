import {
  analyzeWorkItem,
  claimField,
  deadlineStatus,
  parseDependencies,
} from './coordination-lib.mjs';
import { isoInstantMilliseconds } from './coordination-schema.mjs';
import {
  compareUtf8,
  normalizeScopePaths,
  scopeSetsIntersect,
  scopeSetMatchesPath,
} from './coordination-scope.mjs';

const ownershipFields = [
  'Claim-Harness',
  'Claim-Run-ID',
  'Claim-Agent',
  'Claim-Branch',
  'Claim-Host',
  'Claim-Worktree',
];
const meaningful = (value) =>
  typeof value === 'string' && !['', 'unclaimed', 'missing', 'none'].includes(value);
const numeric = (values) => [...new Set(values)].sort((a, b) => a - b);
const reason = (code, message, issueNumber) => ({
  code,
  ...(issueNumber === undefined ? {} : { issueNumber }),
  message,
});
const sortReasons = (reasons) =>
  [...new Map(reasons.map((entry) => [JSON.stringify(entry), entry])).values()].sort(
    (a, b) =>
      compareUtf8(a.code, b.code) ||
      (a.issueNumber ?? 0) - (b.issueNumber ?? 0) ||
      compareUtf8(a.message, b.message),
  );

// Closed prerequisite comments are required evidence too; traverse through completed nodes.
export function dependencyIssueNumbers(issues) {
  const byNumber = new Map(issues.map((issue) => [issue.number, issue]));
  const pending = issues.filter(({ state }) => state === 'open').map(({ number }) => number);
  const seen = new Set();
  while (pending.length) {
    const number = pending.pop();
    if (seen.has(number)) continue;
    seen.add(number);
    const issue = byNumber.get(number);
    if (issue) pending.push(...parseDependencies(claimField(issue.body, 'Depends-On')).numbers);
  }
  return seen;
}

function categoryFor(item) {
  if (['active', 'review'].includes(item.claimState)) return 'agent-owed';
  if (item.claimState === 'blocked') {
    if (
      item.registrySchema.version === '1' &&
      ownershipFields.some((field) => meaningful(item.claim[field]))
    )
      return 'agent-owed';
    return 'principal-owed';
  }
  if (['proposed', 'ready'].includes(item.claimState)) return 'parked';
  if (['done', 'abandoned'].includes(item.claimState)) return 'terminal';
  return 'unknown';
}

function livenessFor(item, category, nowMs) {
  if (category === 'agent-owed') {
    return {
      kind: 'agent-deadline',
      status: deadlineStatus(item.deadline.value, nowMs),
      value: item.deadline.value,
      ageMs: null,
    };
  }
  if (category === 'principal-owed') {
    const value = item.waiting.value;
    const since = isoInstantMilliseconds(value);
    const status = !meaningful(value)
      ? 'unknown'
      : since === undefined || since > nowMs || !Number.isFinite(nowMs)
        ? 'invalid'
        : 'waiting';
    return {
      kind: 'principal-wait',
      status,
      value,
      ageMs: status === 'waiting' ? nowMs - since : null,
    };
  }
  return {
    kind: category === 'unknown' ? 'unknown' : 'none',
    status: category === 'unknown' ? 'unknown' : 'not-applicable',
    value: null,
    ageMs: null,
  };
}

function closureFor(root, nodes, issues, commentsByIssue, remoteClaims) {
  const numbers = new Set();
  const blocked = new Set();
  const unknown = new Set();
  const reasons = [];
  const visited = new Set();
  const visiting = new Set();
  function visit(number) {
    if (visiting.has(number)) {
      unknown.add(number);
      reasons.push(reason('dependency-cycle', `dependency cycle reaches #${number}`, number));
      return;
    }
    if (visited.has(number)) return;
    visited.add(number);
    visiting.add(number);
    const item = nodes.get(number);
    const issue = issues.get(number);
    if (!item || !issue || !commentsByIssue.has(number)) {
      unknown.add(number);
      reasons.push(
        reason(
          'dependency-evidence-missing',
          `record or complete comments unavailable for #${number}`,
          number,
        ),
      );
    } else {
      const remoteProblems = remoteClaims.questions.filter((entry) => entry.issueNumber === number);
      const refProblems = remoteClaims.refs.filter(
        (entry) =>
          entry.mapping?.issueNumber === number &&
          !['preserved-non-ownership', 'current-agent-claim-evidence'].includes(entry.disposition),
      );
      if (
        !item.registrySchema.valid ||
        item.reconciliation !== 'consistent' ||
        remoteProblems.length ||
        refProblems.length
      ) {
        unknown.add(number);
        reasons.push(
          reason(
            'record-unknown',
            `schema, reconciliation or remote evidence is uncertain for #${number}`,
            number,
          ),
        );
        reasons.push(...item.questions.map((entry) => ({ ...entry, issueNumber: number })));
        reasons.push(...remoteProblems);
      }
      if (number !== root) {
        if (issue.state === 'open') blocked.add(number);
        else if (
          item.claimState !== 'done' ||
          issue.labels.filter((label) => label.startsWith('work:')).join() !== 'work:done'
        ) {
          unknown.add(number);
          reasons.push(
            reason(
              'dependency-completion-unknown',
              `#${number} is not coherently closed as done`,
              number,
            ),
          );
        }
      }
      const parsed = parseDependencies(claimField(issue.body, 'Depends-On'));
      if (!['clear', 'declared'].includes(parsed.status)) {
        unknown.add(number);
        reasons.push(
          reason(
            'dependency-declaration-unknown',
            `Depends-On is unreadable for #${number}`,
            number,
          ),
        );
      }
      for (const dependency of numeric(parsed.numbers)) {
        numbers.add(dependency);
        visit(dependency);
      }
    }
    visiting.delete(number);
  }
  visit(root);
  for (const number of blocked)
    reasons.push(reason('dependency-open', `dependency #${number} remains open`, number));
  return {
    evidence: {
      status: unknown.size ? 'unknown' : blocked.size ? 'blocked' : 'clear',
      numbers: numeric(numbers),
      blocked: numeric(blocked),
      unknown: numeric(unknown),
    },
    reasons,
  };
}

function planningScopeFor(item, workItems, issues, scope, known) {
  const reasons = [];
  if (!known)
    return {
      status: 'unknown',
      reasons: [
        reason('planning-evidence-unknown', 'complete stable global scope evidence is unavailable'),
      ],
    };
  const declaration = normalizeScopePaths(
    claimField(issues.get(item.number)?.body ?? '', 'Scope-Paths'),
  );
  if (item.registrySchema.version !== '2' || !['declared', 'none'].includes(declaration.status)) {
    return {
      status: 'unknown',
      reasons: [
        reason(
          'planning-scope-unknown',
          'candidate lacks a supported scope declaration',
          item.number,
        ),
      ],
    };
  }
  let unknown = false;
  for (const other of workItems) {
    if (other.number === item.number) continue;
    const plausibleOwnership =
      ownershipFields.some((field) => meaningful(other.claim[field])) ||
      other.claimComments.some(
        (comment) =>
          comment.reconciliation === 'unresolved' &&
          (Object.keys(comment.structuredFields).length === 0 ||
            ownershipFields.some((field) => meaningful(comment.structuredFields[field]))),
      );
    if (!['active', 'review', 'blocked'].includes(other.claimState) && !plausibleOwnership)
      continue;
    const reservation = normalizeScopePaths(
      claimField(issues.get(other.number)?.body ?? '', 'Scope-Paths'),
    );
    const observed = scope.claims?.find(({ number }) => number === other.number)?.observed;
    if (scopeSetsIntersect(declaration.entries, reservation.entries ?? [])) {
      reasons.push(
        reason(
          'planning-reservation-overlap',
          `declaration overlaps reservation #${other.number}; future changes are not observed`,
          other.number,
        ),
      );
    }
    const hits = (observed?.paths ?? []).filter((path) =>
      scopeSetMatchesPath(declaration.entries, path),
    );
    if (hits.length)
      reasons.push(
        reason(
          'planning-observed-claim-overlap',
          `observed claim #${other.number} paths: ${hits.sort(compareUtf8).join(', ')}`,
          other.number,
        ),
      );
    if (
      declaration.entries.length &&
      (other.registrySchema.version !== '2' ||
        !other.registrySchema.valid ||
        other.reconciliation !== 'consistent' ||
        !['declared', 'none'].includes(reservation.status) ||
        (categoryFor(other) === 'agent-owed' && observed?.status !== 'complete'))
    ) {
      unknown = true;
      reasons.push(
        reason(
          'planning-reservation-unknown',
          `ownership or scope evidence for #${other.number} cannot prove disjointness`,
          other.number,
        ),
      );
    }
  }
  for (const pr of scope.pullRequests ?? []) {
    if (pr.observed?.status !== 'complete') {
      unknown = true;
      reasons.push(
        reason('planning-pr-unknown', `PR #${pr.number} lacks complete observed evidence`),
      );
    } else {
      const hits = pr.observed.paths.filter((path) =>
        scopeSetMatchesPath(declaration.entries, path),
      );
      if (hits.length)
        reasons.push(
          reason(
            'planning-pr-overlap',
            `PR #${pr.number} observed paths: ${hits.sort(compareUtf8).join(', ')}`,
          ),
        );
    }
  }
  return {
    status: unknown ? 'unknown' : reasons.length ? 'blocked' : 'clear',
    reasons: sortReasons(reasons),
  };
}

// Pure advisory computation. Never supplies observed candidate changes or operation clearance.
export function computeNextWork({
  issues,
  workItems,
  commentsByIssue,
  local,
  remoteClaims,
  scope,
  nowMs,
}) {
  const issueByNumber = new Map(issues.map((issue) => [issue.number, issue]));
  const duplicate =
    issueByNumber.size !== issues.length ||
    new Set(workItems.map(({ number }) => number)).size !== workItems.length;
  const known =
    !duplicate &&
    Number.isFinite(nowMs) &&
    scope.status === 'complete' &&
    !remoteClaims.questions.some((entry) => entry.issueNumber === undefined);
  const nodes = new Map(workItems.map((item) => [item.number, item]));
  for (const number of dependencyIssueNumbers(issues)) {
    if (!nodes.has(number) && issueByNumber.has(number))
      nodes.set(
        number,
        analyzeWorkItem(
          issueByNumber.get(number),
          commentsByIssue.get(number) ?? [],
          issueByNumber,
          local,
          nowMs,
        ),
      );
  }
  const diagnostics = [];
  if (!known)
    diagnostics.push(
      reason(
        'next-work-global-unknown',
        'global retrieval, identity or scope evidence cannot establish advisory opportunities',
      ),
    );
  const items = [...workItems]
    .sort((a, b) => a.number - b.number)
    .map((item) => {
      const category = categoryFor(item);
      const liveness = livenessFor(item, category, nowMs);
      const closure = closureFor(item.number, nodes, issueByNumber, commentsByIssue, remoteClaims);
      const planningScope =
        category === 'parked'
          ? planningScopeFor(item, workItems, issueByNumber, scope, known)
          : { status: 'not-applicable', reasons: [] };
      const reasons = [...closure.reasons, ...planningScope.reasons];
      if (category !== 'parked')
        reasons.push(
          reason(
            'work-not-parked',
            `${category} work is not available to a fresh agent`,
            item.number,
          ),
        );
      if (!known) reasons.push(reason('next-work-global-unknown', 'global evidence is uncertain'));
      if (
        ['invalid', 'unknown', 'overdue'].includes(liveness.status) &&
        ['agent-owed', 'principal-owed'].includes(category)
      ) {
        const entry = reason(
          'next-work-liveness',
          `${category} liveness is ${liveness.status}; no expiry or takeover authority is inferred`,
          item.number,
        );
        reasons.push(entry);
        diagnostics.push(entry);
      }
      if (closure.evidence.status === 'unknown')
        diagnostics.push(...closure.reasons.filter(({ code }) => code !== 'dependency-open'));
      const uncertain =
        !known || closure.evidence.status === 'unknown' || planningScope.status === 'unknown';
      return {
        number: item.number,
        category,
        availability: uncertain ? 'unknown' : reasons.length ? 'excluded' : 'available',
        rank: null,
        candidateSafety: 'not-established',
        exclusionReasons: sortReasons(reasons),
        dependencyClosure: closure.evidence,
        liveness,
        planningScope,
      };
    });
  const candidates = items.filter(({ availability }) => availability === 'available');
  candidates.forEach((item, index) => {
    item.rank = index + 1;
  });
  return {
    status: known ? 'complete' : 'unknown',
    order: 'issue-number-ascending',
    candidates: candidates.map(({ number }) => number),
    principalOwed: items
      .filter(({ category }) => category === 'principal-owed')
      .map(({ number }) => number),
    items,
    diagnostics: sortReasons(diagnostics),
  };
}
