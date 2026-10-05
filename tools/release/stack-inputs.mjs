// A service stack is an input of its deployment unit.
//
// The maintainer's 2026-10-05 decision for #227: an infrastructure-only change to
// a service's stack must trigger a deploy of that service by itself. Until now the
// release vector came only from the workspace's affected set, and every path under
// `infra/` belongs to the `infra` project — so a commit that changed only
// `infra/stacks/api/**` reported no deployment unit, the deploy was skipped, and
// the change waited silently for the next unrelated application commit to carry it.
// #219/#220 is where that was found: the projection binding merged and was still
// not applied two runs later.
//
// Why this is derived rather than declared anywhere new.
//
// Nx cannot express it without a second table. Those files already belong to the
// `infra` project, and a file belongs to exactly one project, so making them affect
// `platform-api` would need `nx.json`'s glob `implicitDependencies` — deprecated in
// this Nx, and a path-to-project map that can disagree with the manifest that
// already names the stack. Here nothing new is declared:
//
//   * which stack a unit deploys comes from `metadata.deployment.stack`, the same
//     field the pipeline already applies;
//   * which modules that stack composes comes from the stack's own `module` blocks.
//
// So the mapping cannot drift from the infrastructure it describes. Adding a module
// to a stack makes that module an input of the same unit, in the same commit, with
// nothing else to remember.
//
// What is deliberately absent: `platform` and `bootstrap`. No manifest names them,
// so no unit maps to them, and a change there produces no service vector at all —
// which is correct, because those stacks are maintainer-applied and the routine
// path never deploys them (ADR-0005, ADR-0006). A module composed only by those
// stacks is likewise not an input of any unit.
//
// Nothing here reaches a network, a provider or a credential. It reads committed
// files and a list of changed paths.

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { REPOSITORY_ROOT, ReleasePlanError } from './deployment-manifests.mjs';

const refuse = (code, message) => {
  throw new ReleasePlanError(code, message);
};

/** A local module reference inside a `.tf` file: `source = "../../modules/x"`. */
const LOCAL_MODULE_SOURCE = /source\s*=\s*"((?:\.\.\/)+modules\/[a-z][a-z0-9-]*)"/gu;

const MODULE_NAME = /^[a-z][a-z0-9-]{0,62}$/u;

/** Repository-relative, forward-slashed, with no leading or trailing slash. */
const normalize = (path) => path.split('\\').join('/').replace(/^\.\//u, '').replace(/\/+$/u, '');

function readTerraformSources(directory) {
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.tf'))
    .map((entry) => readFileSync(join(directory, entry.name), 'utf8'));
}

/**
 * Every directory whose contents are applied when this stack is applied.
 *
 * The stack's own directory, plus the local modules it composes, transitively — a
 * module that composes another module is followed, so the set stays correct if the
 * infrastructure stops being flat. `seen` makes a cycle terminate rather than
 * recurse; a cycle is not valid OpenTofu, and this is not the place to diagnose it.
 */
export function stackInputDirectories(stack, root = REPOSITORY_ROOT) {
  if (typeof stack !== 'string' || !MODULE_NAME.test(stack)) {
    refuse('invalid-name', 'A stack name must be a lower-case hyphenated identifier.');
  }

  const inputs = new Set();
  const visit = (relativeDirectory) => {
    if (inputs.has(relativeDirectory)) return;
    inputs.add(relativeDirectory);
    for (const source of readTerraformSources(join(root, relativeDirectory))) {
      for (const [, reference] of source.matchAll(LOCAL_MODULE_SOURCE)) {
        const name = reference.slice(reference.lastIndexOf('/') + 1);
        if (!MODULE_NAME.test(name)) continue;
        visit(`infra/modules/${name}`);
      }
    }
  };

  visit(`infra/stacks/${stack}`);
  return Object.freeze([...inputs].sort());
}

/**
 * Each deployment unit's stack inputs, keyed by unit.
 *
 * Derived entirely from the manifests passed in, so a unit this repository does not
 * declare has no inputs and a stack no unit declares maps to nothing.
 */
export function stackInputsByUnit(manifests, root = REPOSITORY_ROOT) {
  if (!(manifests instanceof Map) || manifests.size === 0) {
    refuse('no-deployable-units', 'No declared deployment manifests were supplied.');
  }
  return new Map(
    [...manifests.values()].map((manifest) => [
      manifest.unit,
      stackInputDirectories(manifest.stack, root),
    ]),
  );
}

/**
 * The projects whose deployment unit a changed path belongs to.
 *
 * Returned as *project* names rather than units, because that is what the affected
 * set speaks: the caller unions this into the list the project graph produced, and
 * the planner then selects manifests from one combined set. A path under no unit's
 * stack contributes nothing — docs, application source, the platform stack and the
 * bootstrap stack all land there, each for its own good reason.
 */
export function projectsAffectedByStackPaths({ changedPaths, manifests, root = REPOSITORY_ROOT }) {
  if (!Array.isArray(changedPaths)) {
    refuse('invalid-changed-input', 'The changed path list must be an array.');
  }

  const inputs = stackInputsByUnit(manifests, root);
  const byUnit = new Map([...manifests.values()].map((manifest) => [manifest.unit, manifest]));
  const affected = new Set();

  for (const raw of changedPaths) {
    if (typeof raw !== 'string' || raw.length === 0) {
      refuse('invalid-changed-input', 'A changed path must be a non-empty string.');
    }
    const path = normalize(raw);
    for (const [unit, directories] of inputs) {
      // Prefix match on a directory boundary, so `infra/stacks/apifoo` is not a
      // change to `infra/stacks/api`.
      if (directories.some((directory) => path === directory || path.startsWith(`${directory}/`))) {
        affected.add(byUnit.get(unit).project);
      }
    }
  }

  return Object.freeze([...affected].sort());
}

/**
 * The changed paths of a push, as the delivery workflow hands them over.
 *
 * `git diff --name-only` output, one path per line. A JSON array is accepted too,
 * so the same flag works whether the caller shells out to git or already holds a
 * list. Empty input is a commit that changed nothing this planner cares about,
 * which is not an error.
 */
export function readChangedPaths(raw) {
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (text === '') return [];
  // An object is a caller mistake rather than a path. Refusing it is the difference
  // between a loud failure and a plan computed from one path named `{"paths":[]}`.
  if (text.startsWith('{')) {
    refuse('invalid-changed-input', 'The changed path list must be a list, not an object.');
  }
  if (text.startsWith('[')) {
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      refuse('invalid-changed-input', 'The changed path list is not readable JSON.');
    }
    if (!Array.isArray(parsed)) {
      refuse('invalid-changed-input', 'The changed path list is not a JSON array.');
    }
    return parsed;
  }
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}
