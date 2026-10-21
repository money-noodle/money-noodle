#!/usr/bin/env node

// Rejects breaking changes to the published v1 contract, with ONE narrow door.
//
// A breaking change passes only when a committed exception record names exactly it: the
// same resolved schema path, property, change kind and exact old and new value, with the
// values independently re-read from the baseline and candidate documents rather than
// believed from the report. Everything else is blocked, including an unapproved breaking
// change that happens to travel alongside an approved one.
//
// Fail-closed, deliberately: a tool error, a non-zero exit, empty or unparsable output, a
// report whose enumerated changes disagree with its own summary, a malformed or duplicated
// exception record, a record whose declared values no longer match the documents, or a
// record that could match more than one change all REJECT. A record that matches nothing
// at all is the ordinary state once its change has merged, so it is reported as historical
// and does not reject.
//
// The tool is always invoked with an explicit neutral rules file. It otherwise
// auto-discovers `./changes-rules.yaml` and `~/.config/changes-rules.yaml`, and such a
// file can turn a whole class of changes non-breaking; see that file's header for the
// measured behaviour.

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

const RECORD_FIELDS = [
  'id',
  'approvedAtIso',
  'approver',
  'approvalSource',
  'reason',
  'contract',
  'type',
  'schemaPath',
  'property',
  'changeKind',
  'original',
  'new',
];
const SCHEMA_PATH_PATTERN = /^\$\.components\.schemas\['([A-Za-z0-9_.-]+)'\]$/u;

/** Parsed exception records, or a list of reasons why the file cannot be trusted. */
export function loadExceptions(text, contractPath = CONTRACT_PATH) {
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
    if (record.contract !== contractPath) {
      failures.push(`${where} names contract ${record.contract}, not ${contractPath}`);
      continue;
    }
    if (record.type !== 'schema') {
      failures.push(`${where} has unsupported type ${record.type}`);
      continue;
    }
    if (!SCHEMA_PATH_PATTERN.test(record.schemaPath)) {
      failures.push(`${where} has an unresolvable schema path ${record.schemaPath}`);
      continue;
    }
    if (record.changeKind !== 'modified') {
      failures.push(`${where} has unsupported change kind ${record.changeKind}`);
      continue;
    }
    if (Number.isNaN(Date.parse(record.approvedAtIso))) {
      failures.push(`${where} has an unparsable approval instant ${record.approvedAtIso}`);
      continue;
    }
    records.push(record);
  }
  return failures.length > 0 ? { failures } : { records };
}

/**
 * The scalar value of one property of one named schema, read straight from the YAML text.
 *
 * Deliberately tiny and deliberately strict: it exists only to corroborate an exception's
 * declared values against the documents themselves, so anything it cannot resolve
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

/** Enumerated breaking changes, cross-checked against the report's own summary. */
export function breakingChangesOf(report) {
  if (!report || typeof report !== 'object' || Array.isArray(report))
    return { failures: ['report is not an object'] };
  if (!Array.isArray(report.changes)) return { failures: ['report carries no changes array'] };
  const failures = [];
  for (const [index, change] of report.changes.entries())
    if (!change || typeof change !== 'object' || typeof change.breaking !== 'boolean')
      failures.push(`change[${index}] has no breaking flag`);
  if (failures.length > 0) return { failures };
  const breaking = report.changes.filter((change) => change.breaking === true);
  // The summary is never the authority, but a summary that disagrees with the enumerated
  // changes means the report was truncated or is not the report we think it is.
  const summary = report.reportSummary;
  if (summary !== undefined) {
    if (!summary || typeof summary !== 'object' || Array.isArray(summary))
      return { failures: ['report summary is not an object'] };
    let counted = 0;
    for (const section of Object.values(summary)) {
      if (!section || typeof section !== 'object')
        return { failures: ['report summary is malformed'] };
      const value = section.breakingChanges;
      if (value !== undefined && !Number.isInteger(value))
        return { failures: ['report summary breaking count is not an integer'] };
      counted += value ?? 0;
    }
    if (counted !== breaking.length)
      return {
        failures: [
          `report summary counts ${counted} breaking change(s) but ${breaking.length} are enumerated`,
        ],
      };
  }
  return { breaking, changes: report.changes };
}

/** Which breaking changes an exception admits, and which stay blocked. */
export function classifyChanges({ breaking, records, baselineText, candidateText }) {
  const failures = [];
  const approved = [];
  const blocked = [];
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
    if (baselineValue !== record.original || candidateValue !== record.new)
      failures.push(
        `exception ${record.id} is stale: it approves ${record.original} -> ${record.new} but the documents hold ${baselineValue} -> ${candidateValue}`,
      );
  }
  if (failures.length > 0) return { approved, blocked, failures, unused: [] };
  for (const change of breaking) {
    const matches = records.filter(
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
    unused: records.filter((record) => !consumed.has(record.id)).map((record) => record.id),
  };
}

function main() {
  const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const baseRef = process.env.OPENAPI_BASE_REF ?? process.env.NX_BASE ?? 'origin/main';
  const baseline = `${baseRef}:${CONTRACT_PATH}`;
  const probe = spawnSync('git', ['cat-file', '-e', baseline], { encoding: 'utf8' });
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
    { encoding: 'utf8' },
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
  let parsed;
  try {
    parsed = JSON.parse(report.stdout);
  } catch (error) {
    console.error(
      `Rejected: the compatibility report is not JSON: ${String(error && error.message)}`,
    );
    return 1;
  }
  const enumerated = breakingChangesOf(parsed);
  if (enumerated.failures) {
    for (const failure of enumerated.failures) console.error(`Rejected: ${failure}`);
    return 1;
  }
  const baselineText = spawnSync('git', ['show', baseline], { encoding: 'utf8' });
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
    breaking: enumerated.breaking,
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
      { stdio: 'inherit' },
    );
  }
  for (const entry of verdict.approved)
    console.log(`Accepted one approved exception (${entry.id}): ${entry.change}`);
  for (const id of verdict.unused)
    console.log(`Exception ${id} matches nothing in this comparison; it is historical.`);
  for (const failure of verdict.failures) console.error(`Rejected: ${failure}`);
  for (const change of verdict.blocked)
    console.error(`Rejected breaking change with no approved exception: ${change}`);
  if (verdict.failures.length > 0 || verdict.blocked.length > 0) return 1;
  console.log(
    `Verified OpenAPI compatibility against ${baseRef}; ${enumerated.changes.length} change(s), ` +
      `${enumerated.breaking.length} breaking, ${verdict.approved.length} approved by exception.`,
  );
  return 0;
}

if (process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = main();
}
