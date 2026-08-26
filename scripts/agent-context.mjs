#!/usr/bin/env node

/**
 * Print a deterministic, read-only context preflight for an agent task.
 * This router is advisory: canonical authority remains in SPEC.md, its modules,
 * code/registries, and authenticated controls as described by AGENTS.md.
 */

import { readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const repoRoot = resolve(import.meta.dirname, '..');
const manifestPath = join(repoRoot, 'scripts/agent-context-manifest.json');
const traceabilityPath = join(repoRoot, 'spec/traceability.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const traceability = JSON.parse(readFileSync(traceabilityPath, 'utf8'));
const args = process.argv.slice(2);

if (args.includes('--check')) {
  const errors = validate();
  if (errors.length) {
    console.error(`Agent context manifest failed with ${errors.length} error(s):`);
    for (const error of errors) console.error(`- ${error}`);
    process.exit(1);
  }
  console.log(`Agent context manifest verified: ${manifest.routes.length} routes and ${traceability.requirements.length} traced requirement(s).`);
  process.exit(0);
}

const taskIndex = args.indexOf('--task');
const task = taskIndex >= 0 ? args[taskIndex + 1] ?? '' : '';
const paths = args.filter((arg, index) => arg !== '--task' && index !== taskIndex + 1 && !arg.startsWith('--'));
if (!task && paths.length === 0) {
  console.error('Usage: npm run agent:context -- [path ...] [--task "description"]');
  process.exit(2);
}

const normalizedPaths = paths.map((value) => value.replace(/^\.\//, ''));
const haystack = `${task}\n${normalizedPaths.join('\n')}`.toLocaleLowerCase('en-US');
const selected = manifest.routes.filter((route) =>
  normalizedPaths.some((value) => route.pathPatterns.some((pattern) => new RegExp(pattern).test(value))) ||
  route.taskKeywords.some((keyword) => haystack.includes(keyword.toLocaleLowerCase('en-US'))),
);
const routes = selected.length ? selected : [];

console.log('# Agent task preflight');
console.log(`\nInput: ${task || normalizedPaths.join(', ')}`);
console.log(`Routes: ${routes.length ? routes.map((route) => `${route.id} (${route.label})`).join(', ') : 'unclassified — inspect SPEC.md and source before choosing a domain'}`);
console.log(`Funded-path impact: ${joinValues(routes, 'fundedImpact', 'undetermined — fail closed until classified')}`);
console.log(`Durable-state impact: ${joinValues(routes, 'durableStateImpact', 'undetermined')}`);

section('Read in order', unique([
  'AGENTS.md',
  'SPEC.md',
  ...routes.flatMap((route) => route.specModules),
  ...(routes.some((route) => route.id !== 'agent-harness') ? ['STATUS.md'] : []),
  ...routes.flatMap((route) => route.designs),
]));
section('Start at source', unique([...normalizedPaths, ...routes.flatMap((route) => route.sources)]));
section('Invariant and focused tests', unique(routes.flatMap((route) => route.tests)));
section('Required records', unique(routes.flatMap((route) => route.records)));
section('Validation', unique(routes.flatMap((route) => route.validation)));
section('Do not cross', unique(routes.flatMap((route) => route.prohibitions)));
section('Traced requirements', unique(routes.flatMap((route) => route.traceability ?? []))
  .map((id) => {
    const entry = traceability.requirements.find((candidate) => candidate.id === id);
    return entry ? `${id} → ${entry.module}; ${entry.sources.join(', ')}; tests: ${entry.tests.join(', ') || 'gap recorded'}` : id;
  }));

console.log('\nPre-edit declaration:');
console.log('- [ ] I classified funded and durable-state impact.');
console.log('- [ ] I read every relevant canonical module and design completely.');
console.log('- [ ] I identified required records and invariant tests before editing.');
console.log('- [ ] I will verify current behavior in source rather than infer it from this output.');

function section(title, values) {
  console.log(`\n## ${title}`);
  if (values.length === 0) console.log('- None selected; inspect the task manually.');
  else for (const value of values) console.log(`- ${value}`);
}

function joinValues(routesToJoin, key, fallback) {
  const values = unique(routesToJoin.map((route) => route[key]).filter(Boolean));
  return values.length ? values.join(' | ') : fallback;
}

function unique(values) {
  return [...new Set(values)];
}

function validate() {
  const errors = [];
  if (manifest.version !== 1 || !Array.isArray(manifest.routes)) errors.push('unsupported scripts/agent-context-manifest.json shape');
  if (traceability.version !== 1 || !Array.isArray(traceability.requirements)) errors.push('unsupported spec/traceability.json shape');
  const routeIds = new Set();
  const traceIds = new Set(traceability.requirements.map((entry) => entry.id));
  for (const route of manifest.routes ?? []) {
    if (!/^[a-z0-9-]+$/.test(route.id ?? '')) errors.push(`invalid route id ${route.id ?? 'missing'}`);
    if (routeIds.has(route.id)) errors.push(`duplicate route id ${route.id}`);
    routeIds.add(route.id);
    for (const pattern of route.pathPatterns ?? []) {
      try { new RegExp(pattern); } catch { errors.push(`${route.id} has invalid path pattern ${pattern}`); }
    }
    for (const field of ['specModules', 'designs', 'sources', 'tests']) {
      for (const file of route[field] ?? []) if (!exists(join(repoRoot, file))) errors.push(`${route.id} cites missing ${file}`);
    }
    for (const id of route.traceability ?? []) if (!traceIds.has(id)) errors.push(`${route.id} cites untraced ${id}`);
  }
  return errors;
}

function exists(path) {
  try { statSync(path); return true; } catch { return false; }
}
