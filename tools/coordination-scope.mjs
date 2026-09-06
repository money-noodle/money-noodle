const FULL_COMMIT = /^[0-9a-f]{40}$/;
const PORTABLE_OPERATION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SCOPE_GATE = /^(claim|publication|checkpoint|integration-pr):([1-9]\d*)$/;
const GLOB_CHARACTERS = /[*?\[\]{}!]/u;
const CONTROL_OR_WHITESPACE = /[\p{Cc}\p{White_Space}]/u;
const TREE_TYPES = new Set(['blob', 'tree', 'commit']);

export function compareUtf8(left, right) {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function containsOnlyUnicodeScalars(value) {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return false;
  }
  return true;
}

function asciiCaseFold(value) {
  return value.replace(/[A-Z]/g, (character) => character.toLowerCase());
}

function literalSegments(value) {
  if (
    value === '' ||
    value.startsWith('/') ||
    value.startsWith('~/') ||
    /^[A-Za-z]:\//.test(value) ||
    value.endsWith('/') ||
    value.includes('\\') ||
    value.includes(',') ||
    value.normalize('NFC') !== value ||
    !containsOnlyUnicodeScalars(value) ||
    CONTROL_OR_WHITESPACE.test(value) ||
    GLOB_CHARACTERS.test(value)
  ) {
    return null;
  }
  const segments = value.split('/');
  if (
    segments.some((segment) => segment === '' || segment === '.' || segment === '..') ||
    asciiCaseFold(segments[0]) === '.git'
  ) {
    return null;
  }
  return segments;
}

export function parseScopePath(value, { exactOnly = false } = {}) {
  if (typeof value !== 'string' || value === '') return { status: 'invalid', value };
  if (!exactOnly && value === '**') return { status: 'valid', kind: 'root', value };
  if (!exactOnly && value.endsWith('/**')) {
    const prefix = value.slice(0, -3);
    return literalSegments(prefix)
      ? { status: 'valid', kind: 'prefix', value, prefix }
      : { status: 'invalid', value };
  }
  return literalSegments(value)
    ? { status: 'valid', kind: 'exact', value, path: value }
    : { status: 'invalid', value };
}

export function parseScopePathList(paths, { allowEmpty = false, exactOnly = false } = {}) {
  if (!Array.isArray(paths) || (!allowEmpty && paths.length === 0)) {
    return {
      status: 'invalid',
      paths: [],
      entries: [],
      errors: ['scope list is empty or not an array'],
    };
  }
  const entries = paths.map((path) => parseScopePath(path, { exactOnly }));
  const errors = [];
  entries.forEach((entry, index) => {
    if (entry.status !== 'valid') errors.push(`scope entry ${index + 1} is invalid`);
  });
  if (errors.length === 0) {
    for (let index = 1; index < paths.length; index += 1) {
      if (compareUtf8(paths[index - 1], paths[index]) >= 0) {
        errors.push('scope entries must be unique and strictly increasing by unsigned UTF-8 bytes');
        break;
      }
    }
  }
  return {
    status: errors.length === 0 ? 'valid' : 'invalid',
    paths: errors.length === 0 ? [...paths] : [],
    entries: errors.length === 0 ? entries : [],
    errors,
  };
}

export function normalizeScopePaths(value) {
  if (typeof value !== 'string') return { status: 'invalid', paths: [], entries: [] };
  if (value === 'none') return { status: 'none', paths: [], entries: [] };
  if (value === '' || value.trim() !== value || value.includes('\r')) {
    return { status: 'invalid', paths: [], entries: [] };
  }
  let paths;
  if (value.includes('\n')) {
    if (value.includes(',')) return { status: 'invalid', paths: [], entries: [] };
    paths = value.split('\n');
  } else {
    paths = value.split(', ');
    if (paths.join(', ') !== value) return { status: 'invalid', paths: [], entries: [] };
  }
  const parsed = parseScopePathList(paths);
  if (paths.includes('none')) return { status: 'invalid', paths: [], entries: [] };
  return parsed.status === 'valid'
    ? { status: 'declared', paths: parsed.paths, entries: parsed.entries }
    : { status: 'invalid', paths: [], entries: [], errors: parsed.errors };
}

export function scopeEntryIntersects(left, right) {
  if (left.status !== 'valid' || right.status !== 'valid') return false;
  if (left.kind === 'root' || right.kind === 'root') return true;
  if (left.kind === 'exact' && right.kind === 'exact') return left.path === right.path;
  if (left.kind === 'exact' && right.kind === 'prefix') {
    return left.path.startsWith(`${right.prefix}/`);
  }
  if (left.kind === 'prefix' && right.kind === 'exact') {
    return right.path.startsWith(`${left.prefix}/`);
  }
  return (
    left.prefix === right.prefix ||
    left.prefix.startsWith(`${right.prefix}/`) ||
    right.prefix.startsWith(`${left.prefix}/`)
  );
}

export function scopeSetsIntersect(left, right) {
  return left.some((leftEntry) =>
    right.some((rightEntry) => scopeEntryIntersects(leftEntry, rightEntry)),
  );
}

export function scopeEntryMatchesPath(entry, path) {
  const exact = parseScopePath(path, { exactOnly: true });
  if (entry.status !== 'valid' || exact.status !== 'valid') return false;
  return (
    entry.kind === 'root' ||
    (entry.kind === 'exact' && entry.path === path) ||
    (entry.kind === 'prefix' && path.startsWith(`${entry.prefix}/`))
  );
}

export function scopeSetMatchesPath(entries, path) {
  return entries.some((entry) => scopeEntryMatchesPath(entry, path));
}

function strictJsonDuplicateKeys(source) {
  const duplicates = [];
  const stack = [];
  let index = 0;
  let expectingKey = false;
  function skipSpace() {
    while (/[\t\n\r ]/.test(source[index] ?? '')) index += 1;
  }
  function stringToken() {
    const start = index;
    index += 1;
    let escaped = false;
    while (index < source.length) {
      const character = source[index++];
      if (!escaped && character === '"') return source.slice(start, index);
      if (!escaped && character === '\\') escaped = true;
      else escaped = false;
    }
    throw new SyntaxError('unterminated JSON string');
  }
  while (index < source.length) {
    skipSpace();
    const character = source[index];
    if (character === '{') {
      stack.push({ type: 'object', keys: new Set() });
      expectingKey = true;
      index += 1;
    } else if (character === '[') {
      stack.push({ type: 'array' });
      expectingKey = false;
      index += 1;
    } else if (character === '}' || character === ']') {
      stack.pop();
      expectingKey = stack.at(-1)?.type === 'object';
      index += 1;
    } else if (character === ',') {
      expectingKey = stack.at(-1)?.type === 'object';
      index += 1;
    } else if (character === '"') {
      const token = stringToken();
      skipSpace();
      if (expectingKey && stack.at(-1)?.type === 'object' && source[index] === ':') {
        const key = JSON.parse(token);
        if (stack.at(-1).keys.has(key)) duplicates.push(key);
        stack.at(-1).keys.add(key);
        expectingKey = false;
        index += 1;
      }
    } else {
      index += 1;
    }
  }
  return duplicates;
}

export function parseJsonWithUniqueKeys(source) {
  if (typeof source !== 'string') return { status: 'invalid', code: 'not-text' };
  try {
    const duplicates = strictJsonDuplicateKeys(source);
    if (duplicates.length > 0) {
      return { status: 'invalid', code: 'duplicate-key', duplicateKeys: duplicates };
    }
    return { status: 'valid', value: JSON.parse(source) };
  } catch (error) {
    return { status: 'invalid', code: 'invalid-json', message: error.message };
  }
}

export function parseSerializingConfiguration(source) {
  const fail = (code, message) => ({
    status: 'invalid',
    code,
    message,
    version: null,
    paths: [],
    entries: [],
  });
  if (typeof source !== 'string')
    return fail('not-text', 'serializing configuration must be UTF-8 text');
  if (
    source.startsWith('\ufeff') ||
    source.includes('\r') ||
    !source.endsWith('\n') ||
    source.endsWith('\n\n')
  ) {
    return fail(
      'non-canonical-bytes',
      'serializing configuration must use LF, no BOM, and exactly one terminal LF',
    );
  }
  const parsedJson = parseJsonWithUniqueKeys(source);
  if (parsedJson.status !== 'valid') {
    return fail(
      parsedJson.code,
      parsedJson.code === 'duplicate-key'
        ? `duplicate JSON key ${parsedJson.duplicateKeys[0]}`
        : parsedJson.message,
    );
  }
  const value = parsedJson.value;
  if (!value || Array.isArray(value) || typeof value !== 'object')
    return fail('invalid-shape', 'top level must be an object');
  if (JSON.stringify(Object.keys(value)) !== JSON.stringify(['version', 'paths'])) {
    return fail('invalid-keys', 'top-level keys must be exactly version and paths in that order');
  }
  if (value.version !== 1 || !Number.isInteger(value.version))
    return fail('invalid-version', 'version must be integer 1');
  const parsed = parseScopePathList(value.paths);
  if (parsed.status !== 'valid') return fail('invalid-paths', parsed.errors.join('; '));
  if (`${JSON.stringify(value, null, 2)}\n` !== source)
    return fail('non-canonical-json', 'canonical two-space JSON bytes are required');
  return { status: 'valid', version: 1, paths: parsed.paths, entries: parsed.entries };
}

function validateTreeEntries(entries, context) {
  if (!Array.isArray(entries))
    return { status: 'unavailable', reason: `${context} tree entries are unavailable` };
  const paths = new Set();
  const types = new Map();
  const map = new Map();
  for (const [index, entry] of entries.entries()) {
    const parsed = parseScopePath(entry?.path, { exactOnly: true });
    if (
      parsed.status !== 'valid' ||
      !/^[0-7]{6}$/.test(entry?.mode ?? '') ||
      !TREE_TYPES.has(entry?.type) ||
      !(
        (entry.type === 'tree' && entry.mode === '040000') ||
        (entry.type === 'blob' && ['100644', '100755', '120000'].includes(entry.mode)) ||
        (entry.type === 'commit' && entry.mode === '160000')
      ) ||
      !FULL_COMMIT.test(entry?.sha ?? '') ||
      paths.has(entry.path)
    ) {
      return {
        status: 'unavailable',
        reason: `${context} tree entry ${index + 1} is malformed or duplicated`,
      };
    }
    paths.add(entry.path);
    types.set(entry.path, entry.type);
    if (entry.type !== 'tree') map.set(entry.path, `${entry.mode}\0${entry.type}\0${entry.sha}`);
  }
  for (const path of paths) {
    const segments = path.split('/');
    for (let length = 1; length < segments.length; length += 1) {
      if (types.get(segments.slice(0, length).join('/')) !== 'tree') {
        return {
          status: 'unavailable',
          reason: `${context} tree path ${path} has a missing or non-tree ancestor`,
        };
      }
    }
  }
  return { status: 'complete', map };
}

export function changedPathsFromTrees(base, head) {
  if (
    !base ||
    !head ||
    base.truncated !== false ||
    head.truncated !== false ||
    !FULL_COMMIT.test(base.commitSha ?? '') ||
    !FULL_COMMIT.test(head.commitSha ?? '') ||
    !FULL_COMMIT.test(base.treeSha ?? '') ||
    !FULL_COMMIT.test(head.treeSha ?? '')
  ) {
    return {
      status: 'unavailable',
      paths: [],
      count: null,
      reason: 'tree identity is missing, malformed, or truncated',
    };
  }
  const left = validateTreeEntries(base.entries, 'base');
  const right = validateTreeEntries(head.entries, 'head');
  if (left.status !== 'complete') return { ...left, paths: [], count: null };
  if (right.status !== 'complete') return { ...right, paths: [], count: null };
  const paths = [...new Set([...left.map.keys(), ...right.map.keys()])]
    .filter((path) => left.map.get(path) !== right.map.get(path))
    .sort(compareUtf8);
  return {
    status: 'complete',
    paths,
    count: paths.length,
    baseCommit: base.commitSha,
    baseTree: base.treeSha,
    headCommit: head.commitSha,
    headTree: head.treeSha,
  };
}

function singleLineField(body, name) {
  const matches = [...body.matchAll(new RegExp(`^${name}: (.*)$`, 'gm'))];
  return matches.length === 1 ? matches[0][1] : null;
}

export function recoverInitialClaimBase(issue, comments) {
  if (!issue || !Array.isArray(comments)) {
    return { status: 'unavailable', reason: 'claim history is unavailable' };
  }
  const identityFields = [
    'Claim-Harness',
    'Claim-Run-ID',
    'Claim-Agent',
    'Claim-Branch',
    'Claim-Host',
    'Claimed-At',
  ];
  const current = Object.fromEntries(
    identityFields.map((field) => [field, singleLineField(issue.body, field)]),
  );
  if (Object.values(current).some((value) => value === null || value === 'unclaimed')) {
    return { status: 'unavailable', reason: 'current claim identity is incomplete' };
  }
  const reconciledValue = singleLineField(issue.body, 'Reconciled-Claim-Comment-IDs');
  const reconciled = new Set(
    reconciledValue && reconciledValue !== 'none' ? reconciledValue.split(', ').map(Number) : [],
  );
  const completeFields = [
    ...identityFields,
    'Claim-State',
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
  ];
  const candidates = comments
    .filter(({ id, body, createdAt, updatedAt }) => {
      if (
        typeof body !== 'string' ||
        createdAt !== updatedAt ||
        reconciled.has(id) ||
        !PORTABLE_OPERATION_ID.test(singleLineField(body, 'Coordination-Write-ID') ?? '')
      )
        return false;
      if (
        singleLineField(body, 'Registry-Schema-Version') !== null &&
        singleLineField(body, 'Registry-Schema-Version') !== '2'
      )
        return false;
      if (completeFields.some((field) => singleLineField(body, field) === null)) return false;
      if (
        singleLineField(body, 'Claim-State') !== 'active' ||
        singleLineField(body, 'Checkpoint-State') !== 'active' ||
        singleLineField(body, 'Checkpoint-Evidence-Version') !== '1' ||
        singleLineField(body, 'Checkpoint-At') !== current['Claimed-At'] ||
        singleLineField(body, 'Waiting-Since') !== 'unclaimed' ||
        singleLineField(body, 'Checkpoint-Checks-Verdict') !== 'unavailable' ||
        singleLineField(body, 'Checkpoint-CI-Run') !== 'unavailable' ||
        singleLineField(body, 'Checkpoint-CI-Commit') !== 'unavailable' ||
        !/^(?:none|present|unknown)$/.test(
          singleLineField(body, 'Checkpoint-Security-Impact') ?? '',
        ) ||
        !/^(?:none|present|unknown)$/.test(
          singleLineField(body, 'Checkpoint-Tenant-Impact') ?? '',
        ) ||
        !/^(?:none|present|unknown)$/.test(
          singleLineField(body, 'Checkpoint-Provider-Impact') ?? '',
        ) ||
        !/^(?:none|present|unknown)$/.test(
          singleLineField(body, 'Checkpoint-Deployment-Impact') ?? '',
        ) ||
        !/^(?:0|[1-9]\d*)$/.test(singleLineField(body, 'Checkpoint-Residual-Risk-Count') ?? '')
      )
        return false;
      return identityFields.every((field) => singleLineField(body, field) === current[field]);
    })
    .map((comment) => ({
      commentId: comment.id,
      createdAt: comment.createdAt,
      commit: singleLineField(comment.body, 'Checkpoint-Commit'),
      changedPathCount: singleLineField(comment.body, 'Checkpoint-Changed-Path-Count'),
    }))
    .filter(
      ({ commentId, createdAt, commit, changedPathCount }) =>
        Number.isSafeInteger(commentId) &&
        typeof createdAt === 'string' &&
        FULL_COMMIT.test(commit ?? '') &&
        changedPathCount === '0',
    )
    .sort(
      (left, right) =>
        compareUtf8(left.createdAt, right.createdAt) || left.commentId - right.commentId,
    );
  if (candidates.length !== 1) {
    return {
      status: 'unavailable',
      reason:
        candidates.length === 0
          ? 'no complete active establishment comment matches current identity'
          : 'duplicate active establishment comments match current identity',
    };
  }
  return {
    status: 'recovered',
    baseCommit: candidates[0].commit,
    commentId: candidates[0].commentId,
  };
}

export function provisionalEmptyObservedEvidence() {
  return { status: 'provisional-empty-before-ref', paths: [], count: null };
}

export function completeObservedEvidence(paths, detail = {}) {
  const parsed = parseScopePathList(paths, { allowEmpty: true, exactOnly: true });
  return parsed.status === 'valid'
    ? { ...detail, status: 'complete', paths: parsed.paths, count: parsed.paths.length }
    : { status: 'unavailable', paths: [], count: null, reason: parsed.errors.join('; ') };
}

function observedUsable(observed, { provisional = false } = {}) {
  return (
    observed?.status === 'complete' ||
    (provisional && observed?.status === 'provisional-empty-before-ref')
  );
}

function observedProblems(claim, { provisional = false } = {}) {
  const problems = [];
  if (!observedUsable(claim.observed, { provisional }))
    problems.push('observed evidence is unavailable');
  if (
    claim.observed?.status === 'complete' &&
    (claim.observed.count !== claim.observed.paths.length ||
      (claim.checkpointChangedPathCount !== undefined &&
        claim.checkpointChangedPathCount !== claim.observed.paths.length))
  ) {
    problems.push('changed-path count disagrees with the complete observed set');
  }
  if (
    claim.observed?.status === 'complete' &&
    claim.observed.paths.some((path) => !scopeSetMatchesPath(claim.declaredEntries, path))
  ) {
    problems.push('observed paths exceed declared scope');
  }
  return problems;
}

function exactCollisions(left, right) {
  const values = new Set(right.filter(({ kind }) => kind === 'exact').map(({ path }) => path));
  return left
    .filter(({ kind, path }) => kind === 'exact' && values.has(path))
    .map(({ path }) => path);
}

function pathIntersection(left, right) {
  const values = new Set(right);
  return left.filter((path) => values.has(path)).sort(compareUtf8);
}

function serializingPathHits(paths, serializingEntries) {
  return paths.filter((path) => scopeSetMatchesPath(serializingEntries, path)).sort(compareUtf8);
}

function tripleDeclaredSerializes(left, right, serializingEntries) {
  return left.some((a) =>
    right.some((b) =>
      serializingEntries.some(
        (s) =>
          scopeEntryIntersects(a, b) && scopeEntryIntersects(a, s) && scopeEntryIntersects(b, s),
      ),
    ),
  );
}

export function classifyClaimPair(
  left,
  right,
  serializingEntries,
  { leftProvisional = false, rightProvisional = false, includeIntrinsic = true } = {},
) {
  const blockers = [];
  const paths = new Set();
  if (includeIntrinsic) {
    for (const message of observedProblems(left, { provisional: leftProvisional }))
      blockers.push(message);
    for (const message of observedProblems(right, { provisional: rightProvisional }))
      blockers.push(message);
  }
  for (const path of exactCollisions(left.declaredEntries, right.declaredEntries)) {
    blockers.push('exact declared-file collision');
    paths.add(path);
  }
  const observedIntersection =
    observedUsable(left.observed, { provisional: leftProvisional }) &&
    observedUsable(right.observed, { provisional: rightProvisional })
      ? pathIntersection(left.observed.paths, right.observed.paths)
      : [];
  if (observedIntersection.length > 0) {
    blockers.push('observed same-path collision');
    observedIntersection.forEach((path) => paths.add(path));
  }
  const serializedObserved = serializingPathHits(observedIntersection, serializingEntries);
  if (
    tripleDeclaredSerializes(left.declaredEntries, right.declaredEntries, serializingEntries) ||
    serializedObserved.length > 0
  ) {
    blockers.push('serializing-path collision');
    serializedObserved.forEach((path) => paths.add(path));
  }
  const declaredOverlap = scopeSetsIntersect(left.declaredEntries, right.declaredEntries);
  const advisory = declaredOverlap && blockers.length === 0 && observedIntersection.length === 0;
  return {
    status: blockers.length > 0 ? 'blocked' : advisory ? 'advisory' : 'clear',
    blockers: [...new Set(blockers)],
    paths: [...paths].sort(compareUtf8),
    advisory: advisory ? 'broad declared overlap has complete disjoint observed evidence' : null,
  };
}

function finding(kind, claimNumbers, pullRequestNumbers, paths) {
  const sortedPaths = [...new Set(paths)].sort(compareUtf8);
  if (kind === 'claim-pr') {
    const [issue] = claimNumbers;
    const [pr] = pullRequestNumbers;
    return {
      version: 1,
      id: `scope-v1:claim-pr:${issue}:${pr}`,
      kind,
      claimNumbers: [issue],
      pullRequestNumbers: [pr],
      paths: sortedPaths,
      routes: [
        { gate: 'claim', target: issue },
        { gate: 'publication', target: issue },
        { gate: 'checkpoint', target: issue },
        { gate: 'integration-pr', target: pr },
      ],
      globalPublicationBlock: false,
      message: `claim #${issue} and PR #${pr} have declared/observed path collisions`,
    };
  }
  const [lower, higher] = [...pullRequestNumbers].sort((a, b) => a - b);
  return {
    version: 1,
    id: `scope-v1:pr-pr:${lower}:${higher}`,
    kind,
    claimNumbers: [],
    pullRequestNumbers: [lower, higher],
    paths: sortedPaths,
    routes: [
      { gate: 'integration-pr', target: lower },
      { gate: 'integration-pr', target: higher },
    ],
    globalPublicationBlock: false,
    message: `PR #${lower} and PR #${higher} have observed same-path collisions`,
  };
}

function emptyScope() {
  return {
    findingIds: [],
    claimBlockerIds: [],
    publicationBlockerIds: [],
    checkpointBlockerIds: [],
    advisoryIds: [],
    status: 'clear',
  };
}

export function buildScopeRouting({
  claims = [],
  pullRequests = [],
  serializingEntries = [],
  repository,
}) {
  const findings = [];
  const claimScopes = new Map(claims.map(({ number }) => [number, emptyScope()]));
  const pullRequestScopes = new Map(
    pullRequests.map(({ number }) => [
      number,
      { findingIds: [], integrationBlockerIds: [], status: 'clear' },
    ]),
  );
  for (const claim of claims) {
    const scope = claimScopes.get(claim.number);
    const problems = observedProblems(claim, { provisional: claim.provisional });
    if (problems.includes('observed evidence is unavailable')) {
      scope.status = 'unavailable';
      continue;
    }
    const intrinsic = [
      ['changed-path count disagrees with the complete observed set', 'changed-path-count'],
      ['observed paths exceed declared scope', 'scope-creep'],
    ];
    for (const [message, suffix] of intrinsic) {
      if (!problems.includes(message)) continue;
      const id = `scope-v1:claim:${claim.number}:${suffix}`;
      scope.findingIds.push(id);
      scope.claimBlockerIds.push(id);
      scope.publicationBlockerIds.push(id);
      scope.checkpointBlockerIds.push(id);
      scope.status = 'blocked';
    }
  }
  for (let left = 0; left < claims.length; left += 1) {
    for (let right = left + 1; right < claims.length; right += 1) {
      const a = claims[left],
        b = claims[right];
      const result = classifyClaimPair(a, b, serializingEntries, {
        leftProvisional: a.provisional,
        rightProvisional: b.provisional,
        includeIntrinsic: false,
      });
      if (result.status === 'blocked') {
        const id = `scope-v1:claim-claim:${Math.min(a.number, b.number)}:${Math.max(a.number, b.number)}`;
        for (const claim of [a, b]) {
          const scope = claimScopes.get(claim.number);
          scope.findingIds.push(id);
          scope.claimBlockerIds.push(id);
          scope.publicationBlockerIds.push(id);
          scope.checkpointBlockerIds.push(id);
          if (scope.status !== 'unavailable') scope.status = 'blocked';
        }
      } else if (result.status === 'advisory') {
        const id = `scope-v1:claim-claim-advisory:${Math.min(a.number, b.number)}:${Math.max(a.number, b.number)}`;
        for (const claim of [a, b]) {
          const scope = claimScopes.get(claim.number);
          scope.advisoryIds.push(id);
          if (scope.status === 'clear') scope.status = 'advisory';
        }
      }
    }
  }
  const associated = new Map();
  for (const claim of claims) {
    const namedCandidates = pullRequests.filter((pr) => pr.headRef === claim.branch);
    const branchCandidates = namedCandidates.filter((pr) => pr.headRepository === repository);
    const matches = branchCandidates.filter((pr) => pr.headSha === claim.remoteHead);
    if (matches.length === 1 && branchCandidates.length === 1 && namedCandidates.length === 1) {
      associated.set(claim.number, matches[0].number);
    } else if (namedCandidates.length > 0) {
      claimScopes.get(claim.number).status = 'unavailable';
      for (const pr of namedCandidates) pullRequestScopes.get(pr.number).status = 'unavailable';
    }
  }
  for (const claim of claims) {
    const scope = claimScopes.get(claim.number);
    for (const pr of pullRequests) {
      if (associated.get(claim.number) === pr.number) continue;
      if (pr.observed?.status !== 'complete') {
        scope.status = 'unavailable';
        pullRequestScopes.get(pr.number).status = 'unavailable';
        continue;
      }
      const paths = pr.observed.paths.filter(
        (path) =>
          scopeSetMatchesPath(claim.declaredEntries, path) || claim.observed?.paths?.includes(path),
      );
      if (paths.length === 0) continue;
      const entry = finding('claim-pr', [claim.number], [pr.number], paths);
      findings.push(entry);
      scope.findingIds.push(entry.id);
      scope.claimBlockerIds.push(entry.id);
      scope.publicationBlockerIds.push(entry.id);
      scope.checkpointBlockerIds.push(entry.id);
      if (scope.status !== 'unavailable') scope.status = 'blocked';
      const prScope = pullRequestScopes.get(pr.number);
      prScope.findingIds.push(entry.id);
      prScope.integrationBlockerIds.push(entry.id);
      if (prScope.status !== 'unavailable') prScope.status = 'blocked';
    }
  }
  for (let left = 0; left < pullRequests.length; left += 1) {
    for (let right = left + 1; right < pullRequests.length; right += 1) {
      const a = pullRequests[left],
        b = pullRequests[right];
      if (a.observed?.status !== 'complete' || b.observed?.status !== 'complete') continue;
      const paths = pathIntersection(a.observed.paths, b.observed.paths);
      const serializing = serializingPathHits(paths, serializingEntries);
      if (paths.length === 0 && serializing.length === 0) continue;
      const entry = finding('pr-pr', [], [a.number, b.number], paths);
      findings.push(entry);
      for (const pr of [a, b]) {
        const scope = pullRequestScopes.get(pr.number);
        scope.findingIds.push(entry.id);
        scope.integrationBlockerIds.push(entry.id);
        if (scope.status !== 'unavailable') scope.status = 'blocked';
      }
    }
  }
  findings.sort(
    (left, right) =>
      compareUtf8(left.kind, right.kind) ||
      compareNumberArrays(left.claimNumbers, right.claimNumbers) ||
      compareNumberArrays(left.pullRequestNumbers, right.pullRequestNumbers) ||
      compareStringArrays(left.paths, right.paths),
  );
  for (const scope of [...claimScopes.values(), ...pullRequestScopes.values()]) {
    for (const key of Object.keys(scope).filter((key) => key.endsWith('Ids')))
      scope[key].sort(compareUtf8);
  }
  return { findings, claimScopes, pullRequestScopes };
}

function compareNumberArrays(left, right) {
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    if (left[index] === undefined) return -1;
    if (right[index] === undefined) return 1;
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

function compareStringArrays(left, right) {
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    if (left[index] === undefined) return -1;
    if (right[index] === undefined) return 1;
    const comparison = compareUtf8(left[index], right[index]);
    if (comparison !== 0) return comparison;
  }
  return 0;
}

export function parseScopeGate(value) {
  if (value === undefined || value === 'board')
    return { status: 'valid', requested: 'board', kind: 'board', target: null };
  const match = typeof value === 'string' ? value.match(SCOPE_GATE) : null;
  if (!match || !Number.isSafeInteger(Number(match[2])))
    return { status: 'invalid', requested: value ?? 'missing' };
  return { status: 'valid', requested: value, kind: match[1], target: Number(match[2]) };
}

export function evaluateScopeGate(selector, findings, { known = true, targetExists = true } = {}) {
  const parsed = parseScopeGate(selector);
  if (parsed.status !== 'valid' || !known || (parsed.kind !== 'board' && !targetExists)) {
    return { requested: parsed.requested, status: 'unknown', blockingFindingIds: [] };
  }
  if (parsed.kind === 'board')
    return { requested: 'board', status: 'clear', blockingFindingIds: [] };
  const ids = findings
    .filter(({ routes }) =>
      routes.some(({ gate, target }) => gate === parsed.kind && target === parsed.target),
    )
    .map(({ id }) => id)
    .sort(compareUtf8);
  return {
    requested: parsed.requested,
    status: ids.length > 0 ? 'blocked' : 'clear',
    blockingFindingIds: ids,
  };
}

export function assertFreshScopeGate(scopeGate, expected) {
  if (
    !scopeGate ||
    scopeGate.requested !== expected ||
    scopeGate.status !== 'clear' ||
    !Array.isArray(scopeGate.blockingFindingIds) ||
    scopeGate.blockingFindingIds.length !== 0
  ) {
    throw new Error(`fresh scope gate ${expected} must be clear`);
  }
  return true;
}
