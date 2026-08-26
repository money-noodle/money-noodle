#!/usr/bin/env node

/**
 * Verify the compact current-status projection and immutable status archive.
 * This read-only check imports no application code and writes no repository state.
 */

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';

const repoRoot = resolve(import.meta.dirname, '..');
const statusFile = join(repoRoot, 'STATUS.md');
const statusDir = join(repoRoot, 'status');
const indexFile = join(statusDir, 'README.md');
const roadmapFile = join(statusDir, 'roadmap.md');
const archiveDir = join(statusDir, 'archive');

const archiveManifest = [
  {
    name: 'implementation-record-2026-08-20-to-26.md',
    lines: 1_181,
    words: 14_118,
    bytes: 110_542,
    sha256: 'bac566b1240235d27b725b4a52c69a2259b3cc927696f0aab0a29b18a4931a0a',
  },
  {
    name: 'policy-and-evidence-record-2026-08-17-to-22.md',
    lines: 1_280,
    words: 14_837,
    bytes: 107_109,
    sha256: '8c3d229ec11083df5aede2d4b913ef5e509ca02245ee1cbdbd8ce713f40abb38',
  },
  {
    name: 'roadmap-record-through-2026-08-26.md',
    lines: 444,
    words: 5_633,
    bytes: 40_961,
    sha256: '73a347f512f6c357fc0ef49edf3b90e506ae1f724ea5bfbc436144c31ecf9a6f',
  },
];
const originalStatusSha256 = 'be7d8ed9b721fb9a72f212d0091950c6bbb22c2f6b927c6be8094e8b100afdf0';
const errors = [];
const currentFiles = [statusFile, indexFile, roadmapFile];
const contents = new Map(currentFiles.map((file) => [file, readFileSync(file, 'utf8')]));

verifyCurrentProjection();
verifyActiveIdentityProjection();
verifyArchive();
verifyLocalLinks();

if (errors.length > 0) {
  console.error(`Status verification failed with ${errors.length} error(s):`);
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log(
  `Status verified: ${wordCount(contents.get(statusFile))} current words, ` +
  `${wordCount(contents.get(roadmapFile))} roadmap words, ` +
  `${archiveManifest.length} immutable archive fragments reproducing ${sum(archiveManifest.map((item) => item.words))} historical words.`,
);

function verifyCurrentProjection() {
  const status = contents.get(statusFile);
  const roadmap = contents.get(roadmapFile);

  checkLimit(statusFile, status, 3_000, 30 * 1024);
  checkLimit(roadmapFile, roadmap, 5_000, 50 * 1024);
  checkLimit(indexFile, contents.get(indexFile), 2_000, 24 * 1024);

  if (!/^# Money Noodle — Current Implementation Status$/m.test(status)) {
    errors.push('STATUS.md does not identify itself as the current implementation status');
  }
  if (!/^> \*\*Projection date:\*\* \d{4}-\d{2}-\d{2} · \*\*Status:\*\* Current implementation projection/m.test(status)) {
    errors.push('STATUS.md is missing its controlled projection date/status metadata');
  }
  for (const destination of ['status/README.md', 'status/roadmap.md', 'SPEC.md', 'docs/README.md']) {
    if (!status.includes(`](${destination})`)) errors.push(`STATUS.md does not link to ${destination}`);
  }
  if (!status.includes('authenticated Automation surface') || !status.includes('data/trading-control.json')) {
    errors.push('STATUS.md is missing the operational-state authority warning');
  }
  if (/^## Detailed Roadmap and Historical Delivery Record$/m.test(status)) {
    errors.push('STATUS.md contains the retired append-only roadmap/history section');
  }
  if (!/^> \*\*Status:\*\* Non-normative planning projection/m.test(roadmap)) {
    errors.push('status/roadmap.md is missing its non-normative status metadata');
  }
}

/** Compare only exact identities with one clear source owner; prose measurements remain human projections. */
function verifyActiveIdentityProjection() {
  const status = contents.get(statusFile);
  const dashboard = readFileSync(join(repoRoot, 'src/lib/dashboard.ts'), 'utf8');
  const predictionPolicy = readFileSync(join(repoRoot, 'src/lib/prediction-policy.ts'), 'utf8');
  const executionPolicy = readFileSync(join(repoRoot, 'src/lib/entry-execution-policy.ts'), 'utf8');
  const sizingPolicy = readFileSync(join(repoRoot, 'src/lib/entry-sizing-policy.ts'), 'utf8');
  const paperCalibration = readFileSync(join(repoRoot, 'src/lib/paper-fill-calibration.ts'), 'utf8');
  const strategyRegistry = readFileSync(join(repoRoot, 'src/lib/strategy-registry.ts'), 'utf8');

  const identities = [
    sourceConstant(dashboard, 'MODEL_VERSION'),
    sourceConstant(predictionPolicy, 'BUY_POLICY_VERSION'),
    sourceConstant(executionPolicy, 'ENTRY_EXECUTION_POLICY_VERSION'),
    sourceConstant(sizingPolicy, 'ENTRY_SIZING_POLICY_VERSION'),
  ];
  const prefix = sourceConstant(paperCalibration, 'PAPER_EXECUTION_VERSION_PREFIX', false);
  const generation = paperCalibration.match(/PAPER_NEUTRAL_EXECUTION_VERSION = `\$\{PAPER_EXECUTION_VERSION_PREFIX\}(\d+)`/)?.[1];
  if (prefix && generation) identities.push(`${prefix}${generation}`);
  else errors.push('could not derive PAPER_NEUTRAL_EXECUTION_VERSION from src/lib/paper-fill-calibration.ts');

  for (const identity of identities.filter(Boolean)) {
    if (!status.includes(identity)) errors.push(`STATUS.md active identities omit source-owned ${identity}`);
  }
  if (!/id: 'long-shot-round-trip',[\s\S]*?status: 'retired'/.test(strategyRegistry)) {
    errors.push('src/lib/strategy-registry.ts does not retain long-shot-round-trip as retired');
  } else if (!status.includes('Long-shot strategy | Retired registry identity only')) {
    errors.push('STATUS.md does not project the retired long-shot registry identity');
  }
}

function sourceConstant(text, name, reportMissing = true) {
  const value = text.match(new RegExp(`(?:export )?const ${name} = ['\\\"]([^'\\\"]+)['\\\"]`))?.[1];
  if (!value && reportMissing) errors.push(`could not read ${name} from its source module`);
  return value;
}

function verifyArchive() {
  const index = contents.get(indexFile);
  const actualNames = readdirSync(archiveDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
    .map((entry) => entry.name)
    .sort();
  const expectedNames = archiveManifest.map((item) => item.name).sort();
  if (actualNames.join('\n') !== expectedNames.join('\n')) {
    errors.push(`status/archive manifest mismatch; expected ${expectedNames.join(', ')}, found ${actualNames.join(', ')}`);
  }

  if (!index.includes(originalStatusSha256)) {
    errors.push('status/README.md does not publish the immutable combined source hash');
  }

  const fragments = [];
  for (const item of archiveManifest) {
    const file = join(archiveDir, item.name);
    const bytes = readFileSync(file);
    const text = bytes.toString('utf8');
    fragments.push(bytes);

    const actual = {
      lines: lineCount(text),
      words: wordCount(text),
      bytes: bytes.length,
      sha256: sha256(bytes),
    };
    for (const field of ['lines', 'words', 'bytes', 'sha256']) {
      if (actual[field] !== item[field]) {
        errors.push(`${display(file)} ${field} is ${actual[field]}, immutable manifest requires ${item[field]}`);
      }
    }
    verifyImmutableArchiveLinks(file, text);
    if (actual.words > 15_000 || actual.bytes > 120 * 1024) {
      errors.push(`${display(file)} exceeds the bounded archive limit`);
    }

    const destination = `archive/${item.name}`;
    const linkCount = [...index.matchAll(new RegExp(`\\]\\(${escapeRegExp(destination)}\\)`, 'g'))].length;
    if (linkCount !== 1) errors.push(`status/README.md indexes ${destination} ${linkCount} times; expected once`);
    if (!index.includes(item.sha256)) errors.push(`status/README.md omits the immutable hash for ${destination}`);
    if (!index.includes(item.words.toLocaleString('en-US'))) {
      errors.push(`status/README.md omits the immutable word count for ${destination}`);
    }
  }

  const combined = Buffer.concat(fragments);
  if (sha256(combined) !== originalStatusSha256) {
    errors.push('immutable status fragments no longer reproduce the pre-migration STATUS.md byte for byte');
  }
}

function verifyImmutableArchiveLinks(file, text) {
  for (const match of text.matchAll(/\]\(([^)]+)\)/g)) {
    const destination = match[1].trim();
    if (/^(https?:|mailto:|\/)/.test(destination)) continue;
    const [rawPath, rawFragment] = destination.split('#', 2);
    const target = rawPath ? resolve(repoRoot, decodeURIComponent(rawPath)) : file;
    if (!exists(target)) {
      errors.push(`${display(file)} has a repository-root-relative link to missing ${destination}`);
      continue;
    }
    if (!rawFragment || statSync(target).isDirectory() || extname(target) !== '.md') continue;
    const targetAnchors = headingAnchors(readFileSync(target, 'utf8'));
    if (!targetAnchors.has(decodeURIComponent(rawFragment))) {
      errors.push(`${display(file)} has a repository-root-relative link to missing anchor ${destination}`);
    }
  }
}

function verifyLocalLinks() {
  const anchors = new Map(currentFiles.map((file) => [file, headingAnchors(contents.get(file))]));
  for (const file of currentFiles) {
    const text = contents.get(file);
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

function checkLimit(file, text, maximumWords, maximumBytes) {
  const words = wordCount(text);
  const bytes = Buffer.byteLength(text);
  if (words > maximumWords) errors.push(`${display(file)} has ${words} words; limit is ${maximumWords}`);
  if (bytes > maximumBytes) errors.push(`${display(file)} has ${bytes} bytes; limit is ${maximumBytes}`);
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

function lineCount(text) {
  return text.length === 0 ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
}

function wordCount(text) {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function sum(values) {
  return values.reduce((total, value) => total + value, 0);
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
