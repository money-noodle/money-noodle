#!/usr/bin/env node

// Rejects breaking changes to the published v1 contract, with ONE narrow door.
//
// The door is not "whatever a record in the exception file says". The approved change is
// fixed IN THIS SOURCE — contract, resolved schema path, property, change kind, exact old
// and new value, and the named approval that granted it — and a committed record is only
// the statement that this comparison is the one carrying it. A record with an unknown id,
// an unknown tuple or different provenance is refused even when it is internally
// consistent with the specifications and the tool's report, so a future exception needs a
// separately authorised change here rather than a new line in a data file.
//
// Fail-closed, deliberately. A tool error, a non-zero exit, output that is neither the
// pinned no-change form nor a complete normal report, a summary that disagrees with the
// enumerated changes, a malformed or duplicated record, a record whose declared values do
// not match the documents, or a record that could match more than one change all REJECT.
//
// The three accepted outcomes, measured against the pinned 0.2.11 binary:
//   * the exact no-change form `{"message":"No changes found between specifications"}`;
//   * a normal report whose only breaking change is the approved one, with a record
//     stating it (the state while the change is in flight);
//   * a normal report, or the no-change form, while the approved value is ALREADY the
//     baseline — the record is then historical and inert, and admits nothing.
//
// The tool is always invoked with an explicit neutral rules file: it otherwise
// auto-discovers `./changes-rules.yaml` and `~/.config/changes-rules.yaml`, and such a
// file can turn a whole class of changes non-breaking.

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import console from 'node:console';
import { fileURLToPath } from 'node:url';

export const CONTRACT_PATH = 'services/platform-api/openapi/platform-api.v1.yaml';
export const EXCEPTIONS_PATH = 'services/platform-api/openapi/compatibility-exceptions.json';
export const RULES_PATH = 'tools/openapi-changes-rules.neutral.yaml';
export const EXCEPTIONS_VERSION = 'openapi-compatibility-exception-v1';
/** The pinned tool's successful "nothing changed" answer, verbatim. */
export const NO_CHANGE_MESSAGE = 'No changes found between specifications';
/** Exactly the top-level keys the pinned tool emits for a normal report, in both its
 * file-to-file and its git-baseline modes. Anything else is not a report we understand. */
const REPORT_KEYS = ['changes', 'modifiedPath', 'originalPath', 'reportSummary'];
const REQUIRED_REPORT_KEYS = ['changes', 'reportSummary'];

/**
 * The approved exceptions, fixed here rather than taken from the data file.
 *
 * `reason` is prose and deliberately not part of the identity; everything else is. A
 * record must match one of these entries field for field, so an altered value, an unknown
 * id, another component or a different approval cannot authorise anything.
 */
export const APPROVED_EXCEPTIONS = Object.freeze([
  Object.freeze({
    approvalSource: '#orbit 1562275489748484137',
    approvedAtIso: '2026-10-21T01:25:02Z',
    approver: 'Rai',
    changeKind: 'modified',
    contract: CONTRACT_PATH,
    id: 'control-parameters-max-properties-12-to-20',
    new: '20',
    original: '12',
    property: 'maxProperties',
    schemaPath: "$.components.schemas['ControlParameters']",
    type: 'schema',
  }),
]);
const IDENTITY_FIELDS = [
  'approvalSource',
  'approvedAtIso',
  'approver',
  'changeKind',
  'contract',
  'id',
  'new',
  'original',
  'property',
  'schemaPath',
  'type',
];
const RECORD_FIELDS = [...IDENTITY_FIELDS, 'reason'];
const SCHEMA_PATH_PATTERN = /^\$\.components\.schemas\['([A-Za-z0-9_.-]+)'\]$/u;

/** Parsed exception records, or the reasons the file cannot be trusted. */
export function loadExceptions(text, approved = APPROVED_EXCEPTIONS) {
  let document;
  try {
    document = JSON.parse(text);
  } catch (error) {
    return { failures: [`exception file is not JSON: ${String(error && error.message)}`] };
  }
  if (!document || typeof document !== 'object' || Array.isArray(document))
    return { failures: ['exception file is not an object'] };
  if (document.version !== EXCEPTIONS_VERSION)
    return { failures: [`exception file version is not ${EXCEPTIONS_VERSION}`] };
  if (!Array.isArray(document.exceptions))
    return { failures: ['exception file has no exceptions array'] };
  const failures = [];
  const records = [];
  const seen = new Set();
  for (const [index, record] of document.exceptions.entries()) {
    const where = `exception[${index}]`;
    if (!record || typeof record !== 'object' || Array.isArray(record)) {
      failures.push(`${where} is not an object`);
      continue;
    }
    const keys = Object.keys(record).sort();
    if (keys.join(',') !== [...RECORD_FIELDS].sort().join(',')) {
      failures.push(`${where} must carry exactly ${RECORD_FIELDS.join(', ')}`);
      continue;
    }
    if (RECORD_FIELDS.some((field) => typeof record[field] !== 'string' || record[field] === '')) {
      failures.push(`${where} has a missing or non-string field`);
      continue;
    }
    if (seen.has(record.id)) {
      failures.push(`${where} duplicates id ${record.id}`);
      continue;
    }
    seen.add(record.id);
    // The identity check: this record must BE an approved exception, not merely look like
    // a well-formed one. An unknown id, an altered value pair, another component or
    // property, or different approval provenance all stop here.
    const match = approved.find((candidate) =>
      IDENTITY_FIELDS.every((field) => candidate[field] === record[field]),
    );
    if (match === undefined) {
      failures.push(
        `${where} (${record.id}) is not an approved exception: ${record.type} ${record.schemaPath} ` +
          `${record.property} ${record.changeKind} ${record.original} -> ${record.new}, approved by ` +
          `${record.approver} ${record.approvalSource} ${record.approvedAtIso}`,
      );
      continue;
    }
    if (!SCHEMA_PATH_PATTERN.test(record.schemaPath)) {
      failures.push(`${where} has an unresolvable schema path ${record.schemaPath}`);
      continue;
    }
    records.push(record);
  }
  return failures.length > 0 ? { failures } : { records };
}

/**
 * The scalar value of one property of one named schema, read straight from the YAML text.
 *
 * Deliberately tiny and deliberately strict: it exists only to corroborate an approved
 * exception's values against the documents themselves, so anything it cannot resolve
 * unambiguously — a missing schema, a repeated schema name, a repeated property inside the
 * schema, a non-scalar value — returns `undefined` and the caller rejects.
 */
export function resolveSchemaScalar(yamlText, schemaName, property) {
  const lines = String(yamlText).split('\n');
  const componentsAt = lines.findIndex((line) => /^components:\s*$/u.test(line));
  if (componentsAt < 0) return undefined;
  let schemasIndent = -1;
  let schemasAt = -1;
  for (let i = componentsAt + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^\S/u.test(line)) break;
    const match = /^(\s+)schemas:\s*$/u.exec(line);
    if (match) {
      if (schemasAt >= 0) return undefined;
      schemasAt = i;
      schemasIndent = match[1].length;
    }
  }
  if (schemasAt < 0) return undefined;
  const escaped = schemaName.replace(/[.*+?^${}()|[\]\\-]/gu, '\\$&');
  const schemaPattern = new RegExp(`^(\\s+)${escaped}:\\s*$`, 'u');
  let schemaAt = -1;
  let schemaIndent = -1;
  for (let i = schemasAt + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim() !== '' && /^\s*/u.exec(line)[0].length <= schemasIndent) break;
    const match = schemaPattern.exec(line);
    if (match && match[1].length > schemasIndent) {
      if (schemaAt >= 0) return undefined;
      schemaAt = i;
      schemaIndent = match[1].length;
    }
  }
  if (schemaAt < 0) return undefined;
  const propertyPattern = new RegExp(`^(\\s+)${property}:\\s*(\\S.*)$`, 'u');
  let value;
  for (let i = schemaAt + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim() !== '' && /^\s*/u.exec(line)[0].length <= schemaIndent) break;
    const match = propertyPattern.exec(line);
    if (match && match[1].length === schemaIndent + 2) {
      if (value !== undefined) return undefined;
      value = match[2].trim();
    }
  }
  return value;
}

const isCount = (value) => Number.isSafeInteger(value) && value >= 0;

/**
 * The tool's stdout, as one of the two forms the pinned binary actually produces.
 *
 * Measured on 0.2.11, in both file-to-file and git-baseline mode: a normal report carries
 * exactly `changes`, `modifiedPath`, `originalPath` and `reportSummary`; every summary
 * section carries both `totalChanges` and `breakingChanges`; and those counts agree with
 * the enumerated changes. A comparison with nothing to say is the one-key message form
 * instead. Anything else — an empty change list presented as a report, a summary that
 * counts changes the report does not list, an error or partial envelope, a truncated
 * object — is refused rather than read as "no changes".
 */
export function parseReport(text) {
  let report;
  try {
    report = JSON.parse(text);
  } catch (error) {
    return {
      failures: [`the compatibility report is not JSON: ${String(error && error.message)}`],
    };
  }
  if (!report || typeof report !== 'object' || Array.isArray(report))
    return { failures: ['the compatibility report is not an object'] };
  const keys = Object.keys(report);
  if (keys.length === 1 && keys[0] === 'message') {
    if (report.message !== NO_CHANGE_MESSAGE)
      return { failures: [`unrecognised compatibility message: ${String(report.message)}`] };
    return { breaking: [], changes: [], kind: 'no-change' };
  }
  const unexpected = keys.filter((key) => !REPORT_KEYS.includes(key));
  if (unexpected.length > 0)
    return {
      failures: [`the compatibility report carries unexpected fields: ${unexpected.join(', ')}`],
    };
  for (const required of REQUIRED_REPORT_KEYS)
    if (!Object.hasOwn(report, required))
      return { failures: [`the compatibility report has no ${required}`] };
  if (!Array.isArray(report.changes))
    return { failures: ['the compatibility report changes is not an array'] };
  if (report.changes.length === 0)
    return {
      failures: [
        'the compatibility report lists no changes; a comparison with nothing to report uses the no-change form',
      ],
    };
  for (const [index, change] of report.changes.entries()) {
    if (!change || typeof change !== 'object' || Array.isArray(change))
      return { failures: [`change[${index}] is not an object`] };
    if (typeof change.breaking !== 'boolean')
      return { failures: [`change[${index}] has no breaking flag`] };
  }
  const summary = report.reportSummary;
  if (!summary || typeof summary !== 'object' || Array.isArray(summary))
    return { failures: ['the compatibility report summary is not an object'] };
  const sections = Object.entries(summary);
  if (sections.length === 0) return { failures: ['the compatibility report summary is empty'] };
  let total = 0;
  let breakingCount = 0;
  for (const [name, section] of sections) {
    if (!section || typeof section !== 'object' || Array.isArray(section))
      return { failures: [`report summary section ${name} is not an object`] };
    if (!isCount(section.totalChanges) || !isCount(section.breakingChanges))
      return {
        failures: [`report summary section ${name} has no non-negative integer change counts`],
      };
    if (section.breakingChanges > section.totalChanges)
      return {
        failures: [`report summary section ${name} counts more breaking changes than changes`],
      };
    total += section.totalChanges;
    breakingCount += section.breakingChanges;
  }
  const breaking = report.changes.filter((change) => change.breaking === true);
  if (total !== report.changes.length)
    return {
      failures: [
        `report summary counts ${total} change(s) but ${report.changes.length} are enumerated`,
      ],
    };
  if (breakingCount !== breaking.length)
    return {
      failures: [
        `report summary counts ${breakingCount} breaking change(s) but ${breaking.length} are enumerated`,
      ],
    };
  return { breaking, changes: report.changes, kind: 'report' };
}

/**
 * Which breaking changes an approved exception admits, and which stay blocked.
 *
 * A record is ACTIVE while the documents hold the approved transition (baseline carries
 * the old value, candidate the new one) and may then admit exactly one matching change.
 * It is HISTORICAL and inert once the approved value is on both sides, which is the
 * ordinary state after the change has merged; it admits nothing at all in that state, so a
 * later move away from the approved value is blocked like any other breaking change.
 * Anything else is a stale record and rejects.
 */
export function classifyChanges({ breaking, records, baselineText, candidateText }) {
  const failures = [];
  const approved = [];
  const blocked = [];
  const historical = [];
  const active = [];
  const consumed = new Set();
  const describe = (change) =>
    `${change.type ?? 'unknown'} ${change.path ?? '?'} ${change.property ?? '?'} ` +
    `${change.changeText ?? '?'} ${String(change.original)} -> ${String(change.new)}`;
  for (const record of records) {
    const schemaName = SCHEMA_PATH_PATTERN.exec(record.schemaPath)[1];
    const baselineValue = resolveSchemaScalar(baselineText, schemaName, record.property);
    const candidateValue = resolveSchemaScalar(candidateText, schemaName, record.property);
    if (baselineValue === undefined || candidateValue === undefined) {
      failures.push(
        `exception ${record.id} names ${record.schemaPath}.${record.property}, which cannot be resolved unambiguously in both documents`,
      );
      continue;
    }
    if (baselineValue === record.original && candidateValue === record.new) active.push(record);
    else if (baselineValue === record.new && candidateValue === record.new)
      historical.push(record.id);
    else
      failures.push(
        `exception ${record.id} is stale: it approves ${record.original} -> ${record.new} but the documents hold ${baselineValue} -> ${candidateValue}`,
      );
  }
  if (failures.length > 0) return { approved, blocked, failures, historical, unused: [] };
  for (const change of breaking) {
    const matches = active.filter(
      (record) =>
        change.type === record.type &&
        change.path === record.schemaPath &&
        change.property === record.property &&
        change.changeText === record.changeKind &&
        String(change.original) === record.original &&
        String(change.new) === record.new,
    );
    if (matches.length === 0) {
      blocked.push(describe(change));
      continue;
    }
    if (matches.length > 1) {
      failures.push(`change ${describe(change)} matches ${matches.length} exception records`);
      continue;
    }
    const record = matches[0];
    if (consumed.has(record.id)) {
      failures.push(`exception ${record.id} would admit more than one change`);
      continue;
    }
    consumed.add(record.id);
    approved.push({ change: describe(change), id: record.id });
  }
  return {
    approved,
    blocked,
    failures,
    historical,
    unused: active.filter((record) => !consumed.has(record.id)).map((record) => record.id),
  };
}

function main() {
  const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const baseRef = process.env.OPENAPI_BASE_REF ?? process.env.NX_BASE ?? 'origin/main';
  const baseline = `${baseRef}:${CONTRACT_PATH}`;
  const probe = spawnSync('git', ['cat-file', '-e', baseline], {
    cwd: repositoryRoot,
    encoding: 'utf8',
  });
  if (probe.status !== 0) {
    console.log(
      `No OpenAPI baseline exists at ${baseRef}; treating this as the initial v1 contract.`,
    );
    return 0;
  }
  const command = path.join(
    repositoryRoot,
    'node_modules',
    '.bin',
    process.platform === 'win32' ? 'openapi-changes.cmd' : 'openapi-changes',
  );
  const rules = path.join(repositoryRoot, RULES_PATH);
  const report = spawnSync(
    command,
    ['report', '--reproducible', '--no-logo', '-c', rules, baseline, CONTRACT_PATH],
    { cwd: repositoryRoot, encoding: 'utf8' },
  );
  if (report.error) {
    console.error(`Rejected: the compatibility tool failed to run: ${report.error.message}`);
    return 1;
  }
  if (report.status !== 0) {
    console.error(report.stderr || report.stdout);
    console.error(`Rejected: the compatibility tool exited ${report.status}.`);
    return 1;
  }
  const parsed = parseReport(report.stdout ?? '');
  if (parsed.failures) {
    for (const failure of parsed.failures) console.error(`Rejected: ${failure}`);
    return 1;
  }
  const baselineText = spawnSync('git', ['show', baseline], {
    cwd: repositoryRoot,
    encoding: 'utf8',
  });
  if (baselineText.status !== 0 || typeof baselineText.stdout !== 'string') {
    console.error(`Rejected: the baseline contract at ${baseline} could not be read.`);
    return 1;
  }
  const loaded = loadExceptions(readFileSync(path.join(repositoryRoot, EXCEPTIONS_PATH), 'utf8'));
  if (loaded.failures) {
    for (const failure of loaded.failures) console.error(`Rejected: ${failure}`);
    return 1;
  }
  const verdict = classifyChanges({
    baselineText: baselineText.stdout,
    breaking: parsed.breaking,
    candidateText: readFileSync(path.join(repositoryRoot, CONTRACT_PATH), 'utf8'),
    records: loaded.records,
  });
  // The human-readable summary is printed only when something is actually rejected: the
  // subcommand reports every breaking change it finds, including one this checker has
  // accepted by exception, and printing that on a passing run reads like a failure.
  if (verdict.failures.length > 0 || verdict.blocked.length > 0) {
    spawnSync(
      command,
      ['summary', '--no-logo', '--no-color', '-c', rules, baseline, CONTRACT_PATH],
      { cwd: repositoryRoot, stdio: 'inherit' },
    );
  }
  for (const entry of verdict.approved)
    console.log(`Accepted one approved exception (${entry.id}): ${entry.change}`);
  for (const id of verdict.historical)
    console.log(`Exception ${id} is historical: its approved value is already the baseline.`);
  for (const id of verdict.unused)
    console.log(`Exception ${id} is active but matches no change in this comparison.`);
  for (const failure of verdict.failures) console.error(`Rejected: ${failure}`);
  for (const change of verdict.blocked)
    console.error(`Rejected breaking change with no approved exception: ${change}`);
  if (verdict.failures.length > 0 || verdict.blocked.length > 0) return 1;
  if (parsed.kind === 'no-change') {
    console.log(`Verified OpenAPI compatibility against ${baseRef}; the contract is unchanged.`);
    return 0;
  }
  console.log(
    `Verified OpenAPI compatibility against ${baseRef}; ${parsed.changes.length} change(s), ` +
      `${parsed.breaking.length} breaking, ${verdict.approved.length} approved by exception.`,
  );
  return 0;
}

if (process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = main();
}
