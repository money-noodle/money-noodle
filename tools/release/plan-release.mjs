#!/usr/bin/env node

// Turns "which projects did this commit affect" into the ordered release vector
// the delivery workflow deploys.
//
// Usage:
//   node tools/release/plan-release.mjs --affected <file|-> [--output <file>]
//
// The affected set is read, never computed here: the workspace project graph
// owns that, and it derives it from declared manifests. This process reaches no
// network and holds no credential; it fails closed, and a refusal prints its
// stable code and nothing else about the inputs.

import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { assertPublishable } from '../delivery/sanitize.mjs';
import { ReleasePlanError, loadDeploymentManifests } from './deployment-manifests.mjs';
import { planReleaseVector } from './affected-services.mjs';

function argument(argv, name) {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 && index + 1 < argv.length ? argv[index + 1] : undefined;
}

function readAffected(source) {
  if (source === undefined) {
    throw new ReleasePlanError('invalid-affected-input', '--affected <file|-> is required.');
  }
  const raw = readFileSync(source === '-' ? 0 : source, 'utf8').trim();
  let parsed;
  try {
    parsed = JSON.parse(raw === '' ? '[]' : raw);
  } catch {
    throw new ReleasePlanError('invalid-affected-input', 'The affected set is not valid JSON.');
  }
  // `nx show projects --affected --json` prints a bare array; accept the
  // `{ projects: [...] }` envelope too rather than depending on one shape.
  if (Array.isArray(parsed)) return parsed;
  if (Array.isArray(parsed?.projects)) return parsed.projects;
  throw new ReleasePlanError('invalid-affected-input', 'The affected set is not an array.');
}

export function main(argv = process.argv.slice(2), env = process.env) {
  const affectedProjects = readAffected(argument(argv, 'affected'));
  const { manifests, projects } = loadDeploymentManifests();
  const plan = planReleaseVector({ affectedProjects, manifests, projects });

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
