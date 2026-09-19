// Declared deployment manifests.
//
// The delivery pipeline may not guess which services a commit affects. The
// engineering standard is explicit: "CI computes the affected dependency graph
// from declared manifests and changed contracts; it does not guess from runtime
// traffic." So the deployable surface is declared once, by each project, under
// `metadata.deployment` in its own `project.json`, and read from there.
//
// Nothing in this file reaches a provider, a network or a credential. It reads
// repository-declared names and refuses anything it cannot resolve exactly.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

/** A refusal with a stable machine-readable code. */
export class ReleasePlanError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ReleasePlanError';
    this.code = code;
  }
}

const refuse = (code, message) => {
  throw new ReleasePlanError(code, message);
};

export const REPOSITORY_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

/** Exactly the keys a declared deployment may carry. An extra key denies. */
export const DEPLOYMENT_FIELDS = Object.freeze([
  'dependsOn',
  'image',
  'order',
  'port',
  'service',
  'stack',
  'unit',
  'verify',
]);

const NAME = /^[a-z][a-z0-9-]{0,30}$/u;
const VERIFY_PATH = /^\/[A-Za-z0-9/._-]*$/u;

// Directories that never hold a project manifest, and are large enough that
// walking them would dominate the cost of discovery.
const SKIPPED_DIRECTORIES = new Set([
  '.git',
  '.next',
  '.turbo',
  'coverage',
  'dist',
  'node_modules',
]);

/**
 * Every `project.json` in the workspace, discovered rather than listed.
 *
 * A hard-coded list of manifests would be exactly the table this module exists
 * to avoid: a new deployable project must be picked up because it declares
 * itself, not because someone also remembered to edit the planner.
 */
export function discoverProjectManifestPaths(root = REPOSITORY_ROOT, maxDepth = 3) {
  const found = [];

  const walk = (directory, depth) => {
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isFile() && entry.name === 'project.json') {
        found.push(join(directory, entry.name));
      }
    }
    if (depth >= maxDepth) return;
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      if (SKIPPED_DIRECTORIES.has(entry.name)) continue;
      walk(join(directory, entry.name), depth + 1);
    }
  };

  walk(root, 0);
  return found.sort();
}

/** The `{project, path, deployment}` entries the workspace declares. */
export function readProjectManifests(paths) {
  return paths.map((path) => {
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(path, 'utf8'));
    } catch {
      refuse('unreadable-manifest', `${path} is not readable JSON.`);
    }
    const project = parsed.name;
    if (typeof project !== 'string' || project.length === 0) {
      refuse('unnamed-project', `${path} declares no project name.`);
    }
    return {
      deployment: parsed.metadata?.deployment,
      path,
      project,
    };
  });
}

function assertShape(entry) {
  const { deployment, path, project } = entry;
  const where = `${project} (${path})`;

  if (typeof deployment !== 'object' || deployment === null || Array.isArray(deployment)) {
    refuse('invalid-deployment', `${where} declares a deployment that is not an object.`);
  }

  const declared = Object.keys(deployment).sort();
  for (const key of declared) {
    if (!DEPLOYMENT_FIELDS.includes(key)) {
      refuse('unknown-field', `${where} declares an unsupported deployment field "${key}".`);
    }
  }
  for (const field of DEPLOYMENT_FIELDS) {
    if (!declared.includes(field)) {
      refuse('missing-field', `${where} does not declare the deployment field "${field}".`);
    }
  }

  for (const field of ['unit', 'stack', 'image', 'service']) {
    if (typeof deployment[field] !== 'string' || !NAME.test(deployment[field])) {
      refuse('invalid-name', `${where} declares an invalid ${field}.`);
    }
  }
  if (!Number.isInteger(deployment.order) || deployment.order < 1) {
    refuse('invalid-order', `${where} must declare a positive integer deployment order.`);
  }
  if (!Number.isInteger(deployment.port) || deployment.port < 1 || deployment.port > 65535) {
    refuse('invalid-port', `${where} must declare a valid service port.`);
  }
  if (!Array.isArray(deployment.dependsOn)) {
    refuse('invalid-depends-on', `${where} must declare dependsOn, even when it is empty.`);
  }
  for (const dependency of deployment.dependsOn) {
    if (typeof dependency !== 'string' || !NAME.test(dependency)) {
      refuse('invalid-depends-on', `${where} declares an invalid deployment dependency.`);
    }
    if (dependency === deployment.unit) {
      refuse('self-dependency', `${where} declares itself as its own deployment dependency.`);
    }
  }
  if (!Array.isArray(deployment.verify) || deployment.verify.length === 0) {
    refuse('missing-verification', `${where} declares no post-deployment verification path.`);
  }
  for (const verifyPath of deployment.verify) {
    if (typeof verifyPath !== 'string' || !VERIFY_PATH.test(verifyPath)) {
      refuse('invalid-verification', `${where} declares an invalid verification path.`);
    }
  }
  if (new Set(deployment.verify).size !== deployment.verify.length) {
    refuse('invalid-verification', `${where} repeats a verification path.`);
  }
}

/**
 * Validates the declared deployments and returns them keyed by unit.
 *
 * Every refusal here is a refusal to deploy. An ambiguous manifest set — two
 * units claiming one order, a dependency that is not declared anywhere, a unit
 * that would deploy before something it depends on — has no single correct
 * ordered vector, so it produces no vector at all.
 */
export function parseDeploymentManifests(entries) {
  const deployable = entries.filter((entry) => entry.deployment !== undefined);
  if (deployable.length === 0) {
    refuse(
      'no-deployable-units',
      'No project declares metadata.deployment; nothing is deployable.',
    );
  }

  const manifests = new Map();
  const byOrder = new Map();
  const byProject = new Map();

  for (const entry of deployable) {
    assertShape(entry);
    const { deployment, path, project } = entry;

    if (manifests.has(deployment.unit)) {
      refuse('duplicate-unit', `Two projects declare the deployment unit "${deployment.unit}".`);
    }
    if (byOrder.has(deployment.order)) {
      refuse('duplicate-order', `Two deployment units declare order ${deployment.order}.`);
    }
    if (byProject.has(project)) {
      refuse('duplicate-project', `Two manifests declare the project "${project}".`);
    }

    const manifest = Object.freeze({
      dependsOn: Object.freeze([...deployment.dependsOn]),
      image: deployment.image,
      manifestPath: relative(REPOSITORY_ROOT, path).split('\\').join('/'),
      order: deployment.order,
      port: deployment.port,
      project,
      service: deployment.service,
      stack: deployment.stack,
      unit: deployment.unit,
      verify: Object.freeze([...deployment.verify]),
    });
    manifests.set(manifest.unit, manifest);
    byOrder.set(manifest.order, manifest.unit);
    byProject.set(project, manifest.unit);
  }

  for (const manifest of manifests.values()) {
    for (const dependency of manifest.dependsOn) {
      const upstream = manifests.get(dependency);
      if (upstream === undefined) {
        refuse(
          'unknown-dependency',
          `"${manifest.unit}" depends on "${dependency}", which no project declares.`,
        );
      }
      if (upstream.order >= manifest.order) {
        refuse(
          'dependency-order',
          `"${manifest.unit}" must deploy after "${dependency}", but its declared order is not greater.`,
        );
      }
    }
  }

  return manifests;
}

/** Refuses a declared stack that has no reviewed infrastructure to apply. */
export function assertStacksExist(manifests, root = REPOSITORY_ROOT) {
  for (const manifest of manifests.values()) {
    const directory = join(root, 'infra', 'stacks', manifest.stack);
    let stat;
    try {
      stat = statSync(directory);
    } catch {
      stat = undefined;
    }
    if (stat === undefined || !stat.isDirectory()) {
      refuse(
        'unknown-stack',
        `"${manifest.unit}" declares the stack "${manifest.stack}", which has no infra/stacks directory.`,
      );
    }
  }
  return manifests;
}

/** The declared deployment manifests of this repository, keyed by unit. */
export function loadDeploymentManifests(root = REPOSITORY_ROOT) {
  const entries = readProjectManifests(discoverProjectManifestPaths(root));
  return {
    manifests: assertStacksExist(parseDeploymentManifests(entries), root),
    projects: new Set(entries.map((entry) => entry.project)),
  };
}
