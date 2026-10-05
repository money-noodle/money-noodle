#!/usr/bin/env node

// Turns "which projects did this commit affect" into the ordered release vector
// the delivery workflow deploys.
//
// Usage:
//   node tools/release/plan-release.mjs --affected <file|-> [--changed <file|->]
//                                      [--output <file>]
//
// Two inputs, both read rather than computed here, and both describing the same
// push:
//
//   * `--affected` is the workspace project graph's affected set. The graph owns
//     that, and derives it from declared manifests.
//   * `--changed` is the list of paths the push changed. It exists because a
//     service's stack is an input of that service's deployment unit (#227): every
//     path under `infra/` belongs to the `infra` project, so the project graph
//     alone reports no deployment unit for a stack-only commit and the change
//     would wait for an unrelated application commit to carry it.
//     `stack-inputs.mjs` maps those paths to units using the stack each manifest
//     already declares, and the two sets are unioned before planning.
//
// This process reaches no network and holds no credential; it fails closed, and a
// refusal prints its stable code and nothing else about the inputs.

import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { assertPublishable } from '../delivery/sanitize.mjs';
import { ReleasePlanError, loadDeploymentManifests } from './deployment-manifests.mjs';
import { planReleaseVector } from './affected-services.mjs';
import { projectsAffectedByStackPaths, readChangedPaths } from './stack-inputs.mjs';

function argument(argv, name) {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 && index + 1 < argv.length ? argv[index + 1] : undefined;
}

function readAffected(source) {
  if (source === undefined) {
    throw new ReleasePlanError('invalid-affected-input', '--affected <file|-> is required.');
  }
  const raw = readFileSync(source === '-' ? 0 : source, 'utf8').trim();
  if (raw === '') return [];

  // `nx show projects --affected --json` prints a bare array, but a task runner
  // is entitled to print a banner or a daemon notice alongside it. Parse the
  // whole text first and fall back to the last standalone JSON array line;
  // anything else refuses rather than being interpreted generously.
  const candidates = [
    raw,
    ...raw
      .split('\n')
      .map((line) => line.trim())
      .reverse(),
  ];
  for (const candidate of candidates) {
    if (!candidate.startsWith('[') && !candidate.startsWith('{')) continue;
    let parsed;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      continue;
    }
    if (Array.isArray(parsed)) return parsed;
    // Accept the `{ projects: [...] }` envelope too, rather than depending on
    // one shape of a tool's output.
    if (Array.isArray(parsed.projects)) return parsed.projects;
  }
  throw new ReleasePlanError('invalid-affected-input', 'The affected set is not a JSON array.');
}

/** The changed-path list, or an empty one when the caller supplied no file. */
function readChanged(source) {
  if (source === undefined) return [];
  return readChangedPaths(readFileSync(source === '-' ? 0 : source, 'utf8'));
}

export function main(argv = process.argv.slice(2), env = process.env) {
  const affectedProjects = readAffected(argument(argv, 'affected'));
  const { manifests, projects } = loadDeploymentManifests();

  // A stack change affects its unit as surely as a source change does, and the two
  // are unioned rather than chosen between: a commit that changes both an
  // application and its stack is one deploy of that unit, not two.
  const stackAffected = projectsAffectedByStackPaths({
    changedPaths: readChanged(argument(argv, 'changed')),
    manifests,
  });
  const plan = planReleaseVector({
    affectedProjects: [...new Set([...affectedProjects, ...stackAffected])],
    manifests,
    projects,
  });

  // Everything in the plan is a repository-declared name, so this should never
  // deny. It runs because a job summary is public and never masked, and the one
  // record that is never checked is the one that eventually carries something.
  assertPublishable(plan, 'release plan');
  const encoded = JSON.stringify(plan);

  const output = argument(argv, 'output');
  if (output !== undefined) writeFileSync(output, `${encoded}\n`);

  if (typeof env.GITHUB_OUTPUT === 'string' && env.GITHUB_OUTPUT.length > 0) {
    appendFileSync(
      env.GITHUB_OUTPUT,
      [
        `count=${plan.vector.length}`,
        `units=${JSON.stringify(plan.units)}`,
        `plan=${encoded}`,
        '',
      ].join('\n'),
    );
  }

  if (typeof env.GITHUB_STEP_SUMMARY === 'string' && env.GITHUB_STEP_SUMMARY.length > 0) {
    const ordered =
      plan.vector.length === 0
        ? '- no service is affected by this commit'
        : plan.vector.map(({ unit }, index) => `${index + 1}. \`${unit}\``).join('\n');
    appendFileSync(
      env.GITHUB_STEP_SUMMARY,
      [
        '### Release vector',
        '',
        `- operation: \`${plan.operation}\``,
        `- permission slots: ${plan.permissionSlots.map((slot) => `\`${slot}\``).join(', ')}`,
        `- target bound: ${plan.maxTargets}`,
        `- left unchanged: ${plan.unaffected.length === 0 ? 'none' : plan.unaffected.map((unit) => `\`${unit}\``).join(', ')}`,
        `- selected by a stack change: ${stackAffected.length === 0 ? 'none' : stackAffected.map((project) => `\`${project}\``).join(', ')}`,
        '',
        ordered,
        '',
      ].join('\n'),
    );
  }

  return plan;
}

const invokedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === import.meta.filename;

if (invokedDirectly) {
  try {
    const plan = main();
    console.log(
      plan.vector.length === 0
        ? 'No declared deployment unit is affected by this commit.'
        : `Ordered release vector: ${plan.units.join(' -> ')}.`,
    );
  } catch (error) {
    if (error instanceof ReleasePlanError) {
      console.error(`Release planning refused: ${error.code}. ${error.message}`);
      process.exitCode = 1;
    } else {
      throw error;
    }
  }
}
