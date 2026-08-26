#!/usr/bin/env node

/**
 * Verify the agent-facing specification graph without changing repository state.
 *
 * The root must remain a small router, every canonical top-level module must be
 * indexed exactly once, local Markdown links/anchors must resolve, and decision
 * archives/ADRs must be reachable from the decision index.
 */

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
  const result = new Set();
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
