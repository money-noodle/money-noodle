#!/usr/bin/env node

/**
 * Verify the agent-facing root guidance without changing repository state.
 *
 * `AGENTS.md` is loaded into every session and `README.md` is the first file a
 * reader opens, yet neither was covered by verify:spec, verify:docs, or
 * verify:status — both of those skip `README.md` by name and neither reads
 * `AGENTS.md` at all. A stale pointer in `AGENTS.md` therefore costs every
 * future session, which is what happened to `lib/target-exit-policy.ts` after
 * the long-shot retirement deleted it.
 *
 * This verifier checks the claims those files make about the code:
 *
 *   1. Every backticked repository path resolves (globs and templates are skipped).
 *   2. Every identifier cited alongside a module path is bound by that module.
 *      This catches a symbol that still exists but has moved, which a plain
 *      path-existence check cannot.
 *   3. `AGENTS.md` stays under its 3,000-word cap.
 *   4. Local Markdown links and anchors resolve.
 *   5. Every `§` citation names a document earlier in its paragraph, so a bare
 *      `§3.6` cannot be dropped into new prose. Section numbers are inherited
 *      from the pre-modularization monolith and no longer identify a file on
 *      their own: three modules open at the same top-level number.
 *   6. `reports/README.md` indexes every report exactly once, and every report's
 *      own local links resolve, so the cited evidence directory stays
 *      discoverable and internally navigable.
 *
 * Limits worth knowing: the symbol check only reads the explicit
 * `identifier` + `path` citation forms described in symbolClaims(), so a bare
 * identifier mentioned with no module is not verified, and the `§` rule is a
 * per-paragraph heuristic rather than a parser.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';

const repoRoot = resolve(import.meta.dirname, '..');
const agentsFile = join(repoRoot, 'AGENTS.md');
const readmeFile = join(repoRoot, 'README.md');
const reportsDir = join(repoRoot, 'reports');
const reportsIndex = join(reportsDir, 'README.md');

const AGENTS_WORD_LIMIT = 3_000;

/** Directories whose backticked paths are treated as repository references. */
const sourceRoots = ['lib', 'scripts', 'spec', 'status', 'docs', 'reports', 'data', 'app', 'components', 'db'];
/** Root files that are cited bare rather than under a directory. */
const rootFiles = new Set(['SPEC.md', 'STATUS.md', 'AGENTS.md', 'README.md', 'CLAUDE.md', 'package.json']);

const governed = [agentsFile, readmeFile, reportsIndex];
/** Link-checked but not path/symbol-checked: reports are prose, not pointers into code. */
const linkChecked = [...governed, ...reportFiles().map((name) => join(reportsDir, name))];
const errors = [];
const contents = new Map(governed.map((file) => [file, readFileSync(file, 'utf8')]));
const bindingCache = new Map();

verifyWordBudget();
verifyCitedPaths();
verifySymbolClaims();
verifyLocalLinks();
verifySectionCitations();
verifyReportIndex();

if (errors.length > 0) {
  console.error(`Agent guidance verification failed with ${errors.length} error(s):`);
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

const checkedPaths = governed.flatMap((file) => citedPaths(contents.get(file))).length;
const checkedSymbols = governed.flatMap((file) => symbolClaims(contents.get(file))).length;
console.log(
  `Agent guidance verified: ${governed.length} governed files, ${checkedPaths} cited path(s), ` +
  `${checkedSymbols} symbol claim(s), ${reportFiles().length} indexed and link-checked report(s).`,
);

function verifyWordBudget() {
  const words = wordCount(contents.get(agentsFile));
  if (words > AGENTS_WORD_LIMIT) {
    errors.push(`AGENTS.md has ${words} words; always-loaded limit is ${AGENTS_WORD_LIMIT.toLocaleString('en-US')}`);
  }
}

function verifyCitedPaths() {
  for (const file of governed) {
    for (const path of citedPaths(contents.get(file))) {
      if (!exists(join(repoRoot, path))) {
        errors.push(`${display(file)} cites missing path \`${path}\``);
      }
    }
  }
}

function verifySymbolClaims() {
  for (const file of governed) {
    for (const { symbol, path } of symbolClaims(contents.get(file))) {
      const absolute = join(repoRoot, path);
      if (!exists(absolute)) continue; // already reported by verifyCitedPaths
      if (!boundNames(absolute).has(symbol)) {
        errors.push(`${display(file)} claims \`${symbol}\` lives in \`${path}\`, which does not define it`);
      }
    }
  }
}

function verifyLocalLinks() {
  for (const file of linkChecked) {
    const text = contents.get(file) ?? readFileSync(file, 'utf8');
    for (const match of text.matchAll(/\]\(([^)]+)\)/g)) {
      const rawDestination = match[1].trim();
      if (/^(https?:|mailto:)/.test(rawDestination)) continue;
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

      if (!headingAnchors(readFileSync(target, 'utf8')).has(decodeURIComponent(rawFragment))) {
        errors.push(`${display(file)} links to missing anchor ${rawDestination}`);
      }
    }
  }
}

function verifySectionCitations() {
  for (const file of governed) {
    // Paragraph granularity, not line: the corpus hard-wraps, so a citation and
    // the document qualifying it routinely land on different lines.
    let line = 1;
    for (const block of contents.get(file).split(/\n\s*\n/)) {
      const marker = block.match(/§+[0-9][0-9a-z.]*/);
      if (marker && !block.slice(0, marker.index).includes('.md')) {
        errors.push(
          `${display(file)}:${line} cites ${marker[0]} with no document named before it; ` +
          'section numbers are inherited from the former monolith and do not identify a module on their own',
        );
      }
      line += block.split('\n').length + 1;
    }
  }
}

function verifyReportIndex() {
  const index = contents.get(reportsIndex);
  const linked = [...index.matchAll(/\]\(([^)#]+\.md)\)/g)]
    .map((match) => match[1])
    .filter((link) => !link.includes('/'));
  const counts = new Map();
  for (const link of linked) counts.set(link, (counts.get(link) ?? 0) + 1);

  for (const [link, count] of counts) {
    if (count > 1) errors.push(`reports/README.md links ${link} ${count} times; index each report exactly once`);
  }
  for (const report of reportFiles()) {
    if (!counts.has(report)) errors.push(`reports/README.md does not index ${report}`);
  }
}

/** Backticked repository paths, minus globs, which name a set rather than a file. */
function citedPaths(text) {
  const result = new Set();
  for (const match of text.matchAll(/`([^`\s]+)`/g)) {
    const token = match[1];
    if (isPlaceholder(token)) continue;
    const isSourcePath = sourceRoots.some((root) => token.startsWith(`${root}/`)) && token.length > 0;
    if (isSourcePath || rootFiles.has(token)) result.add(token);
  }
  return [...result];
}

/**
 * Identifier/module pairings this verifier can check, in the two forms the
 * guidance actually uses:
 *
 *   `symbol`, `other` (`lib/module.ts`)   — trailing parenthesised citation
 *   `lib/module.ts` — `symbol`, `other`   — leading path, as in the §0 table
 *
 * A parenthesised group may list the path in any position, so
 * ``(`venueFeeCents`, `lib/venue-fill.ts`)`` and its reverse both resolve.
 */
function symbolClaims(text) {
  const claims = [];

  for (const match of text.matchAll(/((?:`[^`\n]+`(?:,| and|) *)*)\(((?:`[^`\n]+`(?:,| and|) *)+)\)/g)) {
    const inside = backtickedTokens(match[2]);
    const paths = inside.filter(isRepoPath);
    if (paths.length !== 1) continue;
    const candidates = [...inside.filter((token) => !isRepoPath(token)), ...backtickedTokens(match[1])];
    for (const symbol of candidates.filter(isIdentifier)) claims.push({ symbol, path: paths[0] });
  }

  for (const match of text.matchAll(/`([^`\n]+)` +[—-] +((?:`[^`\n]+`(?:,| and|) *)+)/g)) {
    if (!isRepoPath(match[1])) continue;
    for (const symbol of backtickedTokens(match[2]).filter(isIdentifier)) claims.push({ symbol, path: match[1] });
  }

  return claims;
}

function backtickedTokens(fragment) {
  return [...fragment.matchAll(/`([^`\n]+)`/g)].map((match) => match[1]);
}

function isRepoPath(token) {
  return !isPlaceholder(token) && /\.(ts|tsx|mjs|md|json)$/.test(token) &&
    (sourceRoots.some((root) => token.startsWith(`${root}/`)) || rootFiles.has(token));
}

/** Globs and `<angle-bracket>` templates name a shape, not a file. */
function isPlaceholder(token) {
  return token.includes('*') || token.includes('<') || token.includes('>');
}

function isIdentifier(token) {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(token);
}

/**
 * Every name the module binds: exported and private declarations plus imported
 * bindings. A guidance pointer claims "look here", not "import this", so a
 * module-private helper counts — while a symbol that has *moved* to another
 * file still fails, which is the drift worth catching.
 */
function boundNames(file) {
  const cached = bindingCache.get(file);
  if (cached) return cached;

  const result = new Set();
  if (/\.(ts|tsx|mjs)$/.test(file)) {
    const text = readFileSync(file, 'utf8');
    const declaration = /^ *(?:export +)?(?:declare +)?(?:async +)?(?:function|const|let|var|class|interface|type|enum) +([A-Za-z_$][A-Za-z0-9_$]*)/gm;
    for (const match of text.matchAll(declaration)) result.add(match[1]);

    for (const match of text.matchAll(/^(?:export|import) +(?:type +)?\{([^}]*)\}/gm)) {
      for (const clause of match[1].split(',')) {
        const name = clause.trim().split(/ +as +/).pop()?.trim();
        if (name && isIdentifier(name)) result.add(name);
      }
    }
    for (const match of text.matchAll(/^import +([A-Za-z_$][A-Za-z0-9_$]*) +from/gm)) result.add(match[1]);
  }
  bindingCache.set(file, result);
  return result;
}

function reportFiles() {
  return readdirSync(reportsDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && extname(entry.name) === '.md' && entry.name !== 'README.md')
    .map((entry) => entry.name)
    .sort();
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
