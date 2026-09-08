// Shared, side-effect-free parsing for colon records and GitHub Issue Form output.
export const WORK_STATES = [
  'proposed',
  'ready',
  'active',
  'review',
  'blocked',
  'done',
  'abandoned',
];
export const FIELD_NAMES = [
  'Scope-Paths',
  'Depends-On',
  'Dependency-Notes',
  'Claim-Agent',
  'Claim-Branch',
  'Claimed-At',
  'Integration-Owner',
  'Parent-Plan',
];
export const claimBranch = (number) => `claim-v1/issue-${number}`;
export const claimRef = (number) => `refs/heads/${claimBranch(number)}`;
export const isUnclaimed = (value) => value === 'none' || value === 'unclaimed';

// Keep source ranges so bookkeeping changes only the three claim values, including form fields.
export function bodyFields(body) {
  const source = String(body ?? '');
  const lines = [...source.matchAll(/[^\n]*(?:\n|$)/g)].filter((match) => match[0]);
  const fields = new Map(FIELD_NAMES.map((name) => [name, []]));
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const text = line[0].replace(/\r?\n$/, '');
    const colon = text.match(/^([A-Za-z-]+):[ \t]*(.*)$/);
    if (colon && fields.has(colon[1])) {
      fields.get(colon[1]).push({
        value: colon[2].trim(),
        start: line.index,
        end: line.index + text.length,
        form: false,
      });
    }
    const heading = text.match(/^### (.+?)\s*$/);
    if (!heading || !fields.has(heading[1])) continue;
    let end = index + 1;
    while (end < lines.length && !/^#{1,6} /.test(lines[end][0])) end += 1;
    const startOffset = line.index + line[0].length;
    const endOffset = end < lines.length ? lines[end].index : source.length;
    fields.get(heading[1]).push({
      value: source.slice(startOffset, endOffset).trim(),
      start: startOffset,
      end: endOffset,
      form: true,
    });
    index = end - 1;
  }
  return fields;
}

export function readBodyField(body, name) {
  const records = bodyFields(body).get(name) ?? [];
  return records.length === 1 ? records[0].value : undefined;
}

export function setBodyField(body, name, value) {
  const source = String(body ?? '');
  const records = bodyFields(source).get(name) ?? [];
  if (records.length > 1) throw new Error(`${name} is duplicated; reconcile by hand`);
  if (records.length === 0)
    return /^### /m.test(source)
      ? `${source}\n\n### ${name}\n\n${value}\n`
      : `${source}\n${name}: ${value}`;
  const record = records[0];
  const replacement = record.form ? `\n${value}\n\n` : `${name}: ${value}`;
  return source.slice(0, record.start) + replacement + source.slice(record.end);
}

export function hasUnclaimedOwnership(body) {
  const fields = bodyFields(body);
  const ownership = ['Claim-Agent', 'Claim-Branch', 'Claimed-At'].map((name) => fields.get(name));
  return (
    ownership.every((records) => records.length === 0) ||
    ownership.every((records) => records.length === 1 && isUnclaimed(records[0].value))
  );
}

export function lifecycle(labels) {
  const states = labels.filter((label) => label.startsWith('work:') && label !== 'work:plan');
  return states.length === 1 && WORK_STATES.includes(states[0].slice(5))
    ? states[0].slice(5)
    : undefined;
}

export function parseDependsOn(raw) {
  if (typeof raw !== 'string' || raw === '' || raw === '_No response_')
    return { status: 'missing', numbers: [] };
  if (raw === 'none') return { status: 'none', numbers: [] };
  const tokens = raw.split(/,\s*|\r?\n/).map((token) => token.trim());
  if (tokens.some((token) => !/^#[1-9]\d*$/.test(token))) return { status: 'invalid', numbers: [] };
  const numbers = tokens.map((token) => Number(token.slice(1)));
  if (
    numbers.some((number) => !Number.isSafeInteger(number)) ||
    new Set(numbers).size !== numbers.length
  )
    return { status: 'invalid', numbers: [] };
  return { status: 'declared', numbers };
}

// Structural host failures are not readable issue defects: the whole read is unknown.
export function normalizeIssue(record) {
  if (
    !record ||
    !Number.isSafeInteger(record.number) ||
    record.number <= 0 ||
    !['open', 'closed'].includes(record.state) ||
    typeof record.title !== 'string' ||
    !(record.body === null || typeof record.body === 'string') ||
    !Array.isArray(record.labels) ||
    record.labels.some((label) => typeof label?.name !== 'string')
  ) {
    throw new Error('malformed issue response; coordination unknown');
  }
  return { ...record, body: record.body ?? '', labels: record.labels.map((label) => label.name) };
}

export function isDelivered(issue) {
  return (
    issue.state === 'closed' &&
    issue.state_reason !== 'not_planned' &&
    !issue.labels.includes('work:abandoned') &&
    (issue.labels.every((label) => !label.startsWith('work:') || label === 'work:plan') ||
      lifecycle(issue.labels) === 'done')
  );
}

const GLOB = /[*?[\]{}!]/u;
const CONTROL_OR_SPACE = /[\p{Cc}\p{White_Space}]/u;

function literalSegments(value) {
  if (
    value === '' ||
    value.startsWith('/') ||
    value.endsWith('/') ||
    value.includes('\\') ||
    value.includes(',') ||
    CONTROL_OR_SPACE.test(value) ||
    GLOB.test(value)
  ) {
    return null;
  }
  const segments = value.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..'))
    return null;
  return segments;
}

// One exact repo-relative file, a literal directory prefix ending in `/**`, or root `**`.
export function parseScopePath(value) {
  if (typeof value !== 'string' || value === '') return { valid: false, value };
  if (value === '**') return { valid: true, kind: 'root', value };
  if (value.endsWith('/**')) {
    const prefix = value.slice(0, -3);
    return literalSegments(prefix)
      ? { valid: true, kind: 'prefix', value, prefix }
      : { valid: false, value };
  }
  return literalSegments(value)
    ? { valid: true, kind: 'exact', value, path: value }
    : { valid: false, value };
}

export function parseScopePaths(raw) {
  if (typeof raw !== 'string' || raw === '') return { status: 'missing', entries: [] };
  if (raw === 'none') return { status: 'none', entries: [] };
  const values = raw.split(/,\s*|\r?\n/).map((value) => value.trim());
  const entries = values.map(parseScopePath);
  if (entries.some((entry) => !entry.valid) || new Set(values).size !== values.length) {
    return { status: 'invalid', entries: [] };
  }
  return { status: 'declared', entries };
}
