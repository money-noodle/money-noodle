#!/usr/bin/env node

/**
 * Verify the agent-facing specification graph without changing repository state.
 *
 * The root must remain a small router, every canonical top-level module must be
 * indexed exactly once, local Markdown links/anchors must resolve, and decision
 * archives/ADRs must be reachable from the decision index.
 */

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';

const repoRoot = resolve(import.meta.dirname, '..');
const specRoot = join(repoRoot, 'SPEC.md');
const specDir = join(repoRoot, 'spec');
const decisionDir = join(specDir, 'decisions');

const canonicalModules = [
  'decision-log.md',
  'delivery-and-acceptance.md',
  'forecasting-and-evidence.md',
  'open-decisions.md',
  'policy-and-track-separation.md',
  'product-and-surfaces.md',
  'providers-and-market-data.md',
  'storage-and-architecture.md',
  'trading-risk-and-budget.md',
].sort();

const errors = [];
const markdownFiles = [
  specRoot,
  ...markdownFilesUnder(specDir),
];
const contents = new Map(markdownFiles.map((file) => [file, readFileSync(file, 'utf8')]));
const anchors = new Map(markdownFiles.map((file) => [file, headingAnchors(contents.get(file))]));

verifyCanonicalModuleIndex();
verifySizeBoundaries();
verifyLocalLinks();
verifyDecisionIndex();
verifyDecisionIds();
verifyRequirementIds();
verifyTraceability();
verifyOpenDecisionIds();

if (errors.length > 0) {
  console.error(`Specification verification failed with ${errors.length} error(s):`);
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

const archiveCount = decisionArchiveFiles()
  .map((file) => countDecisionRows(contents.get(file)))
  .reduce((sum, count) => sum + count, 0);
const currentCount = countDecisionRows(contents.get(join(specDir, 'decision-log.md')));
console.log(
  `Specification verified: ${canonicalModules.length} canonical modules, ` +
  `${markdownFiles.length} Markdown files, ${archiveCount} archived decisions, ` +
  `${currentCount} current decision(s), ${openDecisionCount()} open decision(s).`,
);

function openDecisionCount() {
  return [...contents.get(join(specDir, 'open-decisions.md')).matchAll(/^### OD-\d+ +— /gm)].length;
}

function markdownFilesUnder(directory) {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return markdownFilesUnder(path);
      return entry.isFile() && extname(entry.name) === '.md' ? [path] : [];
    })
    .sort();
}

function decisionArchiveFiles() {
  return markdownFiles.filter((file) =>
    dirname(file) === decisionDir && /^\d{4}-\d{2}-\d{2}-to-\d{2}\.md$/.test(relative(decisionDir, file)),
  );
}

function verifyCanonicalModuleIndex() {
  const actual = readdirSync(specDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md') && entry.name !== 'README.md')
    .map((entry) => entry.name)
    .sort();

  if (actual.join('\n') !== canonicalModules.join('\n')) {
    errors.push(
      `canonical module set differs from verifier manifest; expected ${canonicalModules.join(', ')}, ` +
      `found ${actual.join(', ')}`,
    );
  }

  const root = contents.get(specRoot);
  for (const moduleFile of canonicalModules) {
    const target = `spec/${moduleFile}`;
    const links = [...root.matchAll(/\]\((spec\/[^)#]+\.md)(?:#[^)]+)?\)/g)]
      .map((match) => match[1]);
    const count = links.filter((link) => link === target).length;
    if (count === 0) errors.push(`SPEC.md does not index ${target}`);

    const text = contents.get(join(specDir, moduleFile));
    if (!text.includes('[`SPEC.md`](../SPEC.md)')) {
      errors.push(`${target} does not identify ../SPEC.md as its parent`);
    }
  }
}

function verifySizeBoundaries() {
  const rootWords = wordCount(contents.get(specRoot));
  if (rootWords > 5_000) errors.push(`SPEC.md has ${rootWords} words; router limit is 5,000`);

  for (const moduleFile of canonicalModules) {
    const words = wordCount(contents.get(join(specDir, moduleFile)));
    if (words > 8_000) errors.push(`spec/${moduleFile} has ${words} words; canonical module limit is 8,000`);
  }
}

function verifyLocalLinks() {
  for (const file of markdownFiles) {
    const text = contents.get(file);
    for (const match of text.matchAll(/\]\(([^)]+)\)/g)) {
      const rawDestination = match[1].trim();
      if (
        rawDestination.startsWith('http://') ||
        rawDestination.startsWith('https://') ||
        rawDestination.startsWith('mailto:')
      ) continue;
      if (rawDestination.startsWith('/')) {
        errors.push(`${display(file)} uses the absolute link ${rawDestination}; absolute paths resolve only on the authoring machine — use a relative link`);
        continue;
      }

      const [rawPath, rawFragment] = rawDestination.split('#', 2);
      const target = rawPath.length === 0 ? file : resolve(dirname(file), decodeURIComponent(rawPath));
      if (!exists(target)) {
        errors.push(`${display(file)} links to missing ${rawDestination}`);
        continue;
      }
      if (!rawFragment || statSync(target).isDirectory() || extname(target) !== '.md') continue;

      const targetAnchors = anchors.get(target) ?? headingAnchors(readFileSync(target, 'utf8'));
      if (!targetAnchors.has(decodeURIComponent(rawFragment))) {
        errors.push(`${display(file)} links to missing anchor ${rawDestination}`);
      }
    }
  }
}

function verifyDecisionIndex() {
  const indexFile = join(specDir, 'decision-log.md');
  const index = contents.get(indexFile);
  const archives = decisionArchiveFiles();
  let archivedDecisions = 0;

  for (const archive of archives) {
    const text = contents.get(archive);
    const declared = Number(text.match(/^> \*\*Entries:\*\* (\d+)$/m)?.[1]);
    const actual = countDecisionRows(text);
    archivedDecisions += actual;
    if (!Number.isInteger(declared) || declared !== actual) {
      errors.push(`${display(archive)} declares ${declared || 'no'} entries but contains ${actual}`);
    }
    const destination = `decisions/${relative(decisionDir, archive)}`;
    if (!index.includes(`](${destination})`)) {
      errors.push(`spec/decision-log.md does not index ${destination}`);
    }
  }

  const summary = Number(index.match(/Archive counts include ([\d,]+) preserved historical decisions/)?.[1].replaceAll(',', ''));
  if (!Number.isInteger(summary) || summary !== archivedDecisions) {
    errors.push(`spec/decision-log.md archive summary is ${summary || 'missing'}, actual is ${archivedDecisions}`);
  }

  const adrFiles = markdownFiles.filter((file) =>
    dirname(file) === decisionDir && /^ADR-\d{4}-.*\.md$/.test(relative(decisionDir, file)),
  );
  for (const adr of adrFiles) {
    const destination = `decisions/${relative(decisionDir, adr)}`;
    if (!index.includes(`](${destination})`)) {
      errors.push(`spec/decision-log.md does not index ${destination}`);
    }
  }
}

/** Open-decision identifiers are permanent citation handles: unique, sequential, never reused. */
/** Stable requirement aliases remain unique without disturbing inherited heading anchors. */
function verifyRequirementIds() {
  const seen = new Map();
  const modules = [specRoot, ...canonicalModules
    .filter((name) => !['decision-log.md', 'open-decisions.md'].includes(name))
    .map((name) => join(specDir, name))];

  for (const file of modules) {
    const ids = [...contents.get(file).matchAll(/<a id="(req-[a-z0-9-]+)"><\/a>/g)]
      .map((match) => match[1]);
    if (ids.length === 0) errors.push(`${display(file)} declares no stable req- requirement identifiers`);
    for (const id of ids) {
      const prior = seen.get(id);
      if (prior) errors.push(`requirement ID ${id} is duplicated in ${display(prior)} and ${display(file)}`);
      else seen.set(id, file);
    }
  }
}

/**
 * Immutable decision rows cannot be edited to insert IDs. The sidecar binds every
 * current/archive row by source, logical row ordinal, date, and SHA-256 instead.
 */
function verifyDecisionIds() {
  const mapFile = join(decisionDir, 'decision-id-map.json');
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(mapFile, 'utf8'));
  } catch (error) {
    errors.push(`spec/decisions/decision-id-map.json is unreadable: ${String(error)}`);
    return;
  }
  if (manifest.version !== 1 || !Array.isArray(manifest.decisions)) {
    errors.push('spec/decisions/decision-id-map.json has an unsupported shape');
    return;
  }

  const sources = [...decisionArchiveFiles(), join(specDir, 'decision-log.md')];
  const actual = sources.flatMap((file) => decisionRows(file).map((row, index) => ({ file, row, ordinal: index + 1 })));
  const expectedByKey = new Map();
  const ids = new Set();
  for (const entry of manifest.decisions) {
    if (!/^DEC-\d{8}-\d{2}$/.test(entry.id ?? '')) errors.push(`invalid decision ID ${entry.id ?? 'missing'}`);
    if (ids.has(entry.id)) errors.push(`duplicate decision ID ${entry.id}`);
    ids.add(entry.id);
    const key = `${entry.source}:${entry.rowOrdinal}`;
    if (expectedByKey.has(key)) errors.push(`decision map binds ${key} more than once`);
    expectedByKey.set(key, entry);
  }

  for (const { file, row, ordinal } of actual) {
    const source = display(file);
    const key = `${source}:${ordinal}`;
    const entry = expectedByKey.get(key);
    if (!entry) {
      errors.push(`decision map does not bind ${key}`);
      continue;
    }
    const date = row.match(/^\| (\d{4}-\d{2}-\d{2}) \|/)?.[1];
    if (entry.date !== date) errors.push(`${entry.id} maps date ${entry.date}, row has ${date}`);
    const digest = createHash('sha256').update(row).digest('hex');
    if (entry.rowSha256 !== digest) errors.push(`${entry.id} digest no longer matches ${key}`);
    if (file === join(specDir, 'decision-log.md') && !row.includes(`**${entry.id}**`)) {
      errors.push(`current decision ${entry.id} does not publish its ID in spec/decision-log.md`);
    }
    expectedByKey.delete(key);
  }
  for (const key of expectedByKey.keys()) errors.push(`decision map has orphaned binding ${key}`);
  if (manifest.decisions.length !== actual.length) {
    errors.push(`decision map contains ${manifest.decisions.length} entries; decision ledger contains ${actual.length}`);
  }
}

function decisionRows(file) {
  const rows = [];
  let current;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (/^\| \d{4}-\d{2}-\d{2} \|/.test(line)) {
      if (current !== undefined) errors.push(`${display(file)} contains an unterminated decision row`);
      current = line;
    } else if (current !== undefined) {
      current += `\n${line}`;
    }
    if (current?.endsWith(' |')) {
      rows.push(current);
      current = undefined;
    }
  }
  if (current !== undefined) errors.push(`${display(file)} contains an unterminated final decision row`);
  return rows;
}

function verifyTraceability() {
  const file = join(specDir, 'traceability.json');
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    errors.push(`spec/traceability.json is unreadable: ${String(error)}`);
    return;
  }
  if (manifest.version !== 1 || !Array.isArray(manifest.requirements)) {
    errors.push('spec/traceability.json has an unsupported shape');
    return;
  }

  const ids = new Set();
  for (const entry of manifest.requirements) {
    if (ids.has(entry.id)) errors.push(`spec/traceability.json maps ${entry.id} more than once`);
    ids.add(entry.id);
    if (!canonicalModules.includes(relative(specDir, join(repoRoot, entry.module ?? '')))) {
      errors.push(`${entry.id ?? 'missing ID'} cites non-canonical module ${entry.module ?? 'missing'}`);
      continue;
    }
    const moduleFile = join(repoRoot, entry.module);
    if (!contents.get(moduleFile)?.includes(`<a id="${entry.id}"></a>`)) {
      errors.push(`${entry.id} is not owned by ${entry.module}`);
    }
    if (!['full', 'partial'].includes(entry.coverage)) errors.push(`${entry.id} has invalid coverage ${entry.coverage ?? 'missing'}`);
    if (entry.coverage === 'partial' && !entry.gap) errors.push(`${entry.id} is partial without an explicit gap`);
    if (!Array.isArray(entry.sources) || entry.sources.length === 0) errors.push(`${entry.id} maps no source modules`);
    if (!Array.isArray(entry.tests)) errors.push(`${entry.id} has no tests array`);
    for (const source of entry.sources ?? []) {
      if (!exists(join(repoRoot, source))) errors.push(`${entry.id} cites missing source ${source}`);
    }
    for (const test of entry.tests ?? []) {
      if (!/\.test\.(ts|tsx|mjs)$/.test(test)) errors.push(`${entry.id} cites non-test path ${test}`);
      if (!exists(join(repoRoot, test))) errors.push(`${entry.id} cites missing test ${test}`);
    }
  }
}

function verifyOpenDecisionIds() {
  const text = contents.get(join(specDir, 'open-decisions.md'));
  const ids = [...text.matchAll(/^### OD-(\d+) +— /gm)].map((match) => Number(match[1]));
  if (ids.length === 0) {
    errors.push('spec/open-decisions.md declares no OD-<n> entries');
    return;
  }
  const seen = new Set();
  for (const id of ids) {
    if (seen.has(id)) errors.push(`spec/open-decisions.md declares OD-${id} more than once`);
    seen.add(id);
  }
  ids.forEach((id, index) => {
    if (id !== index + 1) errors.push(`spec/open-decisions.md lists OD-${id} in position ${index + 1}; ids must be sequential`);
  });
}

function headingAnchors(text) {
  const result = new Set([...text.matchAll(/<a id="([a-z0-9-]+)"><\/a>/g)].map((match) => match[1]));
  const occurrences = new Map();
  for (const match of text.matchAll(/^#{1,6} +(.*)$/gm)) {
    const base = githubSlug(match[1]);
    const occurrence = occurrences.get(base) ?? 0;
    occurrences.set(base, occurrence + 1);
    result.add(occurrence === 0 ? base : `${base}-${occurrence}`);
  }
  return result;
}

function githubSlug(heading) {
  return heading
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replaceAll('`', '')
    .toLocaleLowerCase('en-US')
    .replace(/[^\p{Letter}\p{Number}_\- ]/gu, '')
    .trim()
    .replace(/ +/g, '-');
}

function countDecisionRows(text) {
  return [...text.matchAll(/^\| \d{4}-\d{2}-\d{2} \|/gm)].length;
}

function wordCount(text) {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function exists(path) {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

function display(file) {
  return relative(repoRoot, file);
}
