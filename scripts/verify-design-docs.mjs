#!/usr/bin/env node

/**
 * Verify the top-level design-document registry and lifecycle metadata.
 * This is a read-only documentation check; it imports no application code.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';

const repoRoot = resolve(import.meta.dirname, '..');
const docsDir = join(repoRoot, 'docs');
const indexFile = join(docsDir, 'README.md');
const designFiles = readdirSync(docsDir, { withFileTypes: true })
  .filter((entry) => entry.isFile() && entry.name.endsWith('.md') && entry.name !== 'README.md')
  .map((entry) => join(docsDir, entry.name))
  .sort();

const allowedTypes = new Set([
  'Architecture design',
  'Evaluation design',
  'Execution design',
  'Exploration',
  'Policy design',
  'Product design',
  'Reference',
  'Safety design',
]);
const allowedStatuses = new Set(['Accepted', 'Exploratory', 'Proposed', 'Reference', 'Retired', 'Superseded']);
const allowedImplementation = new Set(['Complete', 'Not applicable', 'Not started', 'Partial', 'Removed']);
const errors = [];
const index = readFileSync(indexFile, 'utf8');
const decisionIds = new Set(
  JSON.parse(readFileSync(join(repoRoot, 'spec/decisions/decision-id-map.json'), 'utf8'))
    .decisions.map((entry) => entry.id),
);
const metadata = new Map();

for (const file of designFiles) verifyMetadata(file);
verifyIndex();
verifyLinks();

if (errors.length > 0) {
  console.error(`Design-document verification failed with ${errors.length} error(s):`);
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

const counts = [...metadata.values()].reduce((result, value) => {
  result[value.status] = (result[value.status] ?? 0) + 1;
  return result;
}, {});
console.log(
  `Design documents verified: ${designFiles.length} indexed; ` +
  [...allowedStatuses]
    .filter((status) => counts[status])
    .map((status) => `${counts[status]} ${status.toLocaleLowerCase('en-US')}`)
    .join(', ') + '.',
);

function verifyMetadata(file) {
  const text = readFileSync(file, 'utf8');
  const head = text.split('\n').slice(0, 14).join('\n');
  const value = {
    type: field(head, 'Document type'),
    status: field(head, 'Design status'),
    implementation: field(head, 'Implementation'),
    created: field(head, 'Created'),
    canonical: field(head, 'Canonical requirements'),
    decision: field(head, 'Decision record'),
    designIndex: field(head, 'Design index'),
  };
  metadata.set(file, value);

  if (!allowedTypes.has(value.type)) errors.push(`${display(file)} has invalid document type: ${value.type || 'missing'}`);
  if (!allowedStatuses.has(value.status)) errors.push(`${display(file)} has invalid design status: ${value.status || 'missing'}`);
  if (!allowedImplementation.has(value.implementation)) {
    errors.push(`${display(file)} has invalid implementation state: ${value.implementation || 'missing'}`);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value.created)) errors.push(`${display(file)} has invalid created date: ${value.created || 'missing'}`);
  if (value.designIndex !== '[`docs/README.md`](README.md)') errors.push(`${display(file)} does not link to docs/README.md`);

  const hasCanonicalLink = /\]\(\.\.\/spec\/[^)]+\.md\)/.test(value.canonical);
  const decisionId = value.decision.match(/^\[`(DEC-\d{8}-\d{2})`\]\(\.\.\/spec\/decisions\/decision-id-map\.json\)$/)?.[1];
  const legacyDecision = value.decision === 'Legacy — no single archived row names this design; see [`spec/decision-log.md`](../spec/decision-log.md)';
  const hasDecisionAuthority = decisionId !== undefined || legacyDecision;
  if (decisionId && !decisionIds.has(decisionId)) errors.push(`${display(file)} cites unknown decision ${decisionId}`);
  if (['Accepted', 'Retired', 'Superseded'].includes(value.status)) {
    if (!hasCanonicalLink) errors.push(`${display(file)} is ${value.status} without canonical requirement links`);
    if (!hasDecisionAuthority) errors.push(`${display(file)} is ${value.status} without an exact or explicitly legacy decision record`);
  }
  if (value.status === 'Proposed') {
    if (value.implementation !== 'Not started') errors.push(`${display(file)} is proposed but implementation is ${value.implementation}`);
    if (hasCanonicalLink || hasDecisionAuthority) errors.push(`${display(file)} is proposed but claims accepted authority`);
  }
  if (value.status === 'Exploratory') {
    if (value.implementation !== 'Not applicable') errors.push(`${display(file)} is exploratory but implementation is ${value.implementation}`);
    if (hasCanonicalLink || hasDecisionAuthority) errors.push(`${display(file)} is exploratory but claims accepted authority`);
  }
  if (value.status === 'Reference' && value.implementation !== 'Not applicable') {
    errors.push(`${display(file)} is a reference but implementation is ${value.implementation}`);
  }
  if (value.status === 'Retired' && !['Complete', 'Removed'].includes(value.implementation)) {
    errors.push(`${display(file)} is retired with invalid implementation state ${value.implementation}`);
  }
}

function verifyIndex() {
  for (const file of designFiles) {
    const name = relative(docsDir, file);
    const status = metadata.get(file).status;
    const section = sectionText(index, status);
    const primaryCount = [...section.matchAll(new RegExp(`\\]\\(${escapeRegExp(name)}\\)`, 'g'))].length;
    if (primaryCount !== 1) {
      errors.push(`docs/README.md indexes ${name} ${primaryCount} times under ## ${status}; expected one primary lifecycle entry`);
    }
  }
}

function verifyLinks() {
  const files = [indexFile, ...designFiles];
  const anchors = new Map(
    files.map((file) => [file, headingAnchors(readFileSync(file, 'utf8'))]),
  );

  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    for (const match of text.matchAll(/\]\(([^)]+)\)/g)) {
      const destination = match[1].trim();
      if (/^(https?:|mailto:)/.test(destination)) continue;
      if (destination.startsWith('/')) {
        errors.push(`${display(file)} uses the absolute link ${destination}; absolute paths resolve only on the authoring machine — use a relative link`);
        continue;
      }
      const [rawPath, rawFragment] = destination.split('#', 2);
      const target = rawPath ? resolve(dirname(file), decodeURIComponent(rawPath)) : file;
      if (!exists(target)) {
        errors.push(`${display(file)} links to missing ${destination}`);
        continue;
      }
      if (!rawFragment || statSync(target).isDirectory() || extname(target) !== '.md') continue;
      const targetAnchors = anchors.get(target) ?? headingAnchors(readFileSync(target, 'utf8'));
      if (!targetAnchors.has(decodeURIComponent(rawFragment))) {
        errors.push(`${display(file)} links to missing anchor ${destination}`);
      }
    }
  }
}

function field(head, name) {
  return head.match(new RegExp(`^> \\*\\*${escapeRegExp(name)}:\\*\\* (.+?)(?:  )?$`, 'm'))?.[1].trim() ?? '';
}

function sectionText(text, heading) {
  const marker = `## ${heading}\n`;
  const start = text.indexOf(marker);
  if (start < 0) return '';
  const rest = text.slice(start + marker.length);
  const end = rest.search(/^## /m);
  return end < 0 ? rest : rest.slice(0, end);
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

function exists(path) {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function display(file) {
  return relative(repoRoot, file);
}
