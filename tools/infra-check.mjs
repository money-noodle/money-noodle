#!/usr/bin/env node

// Runs the OpenTofu-native checks across every module and stack.
//
// Kept out of the `lint`/`test`/`build` target names deliberately. `pnpm check`
// runs those across every project, and it must stay runnable on a machine that
// has no OpenTofu installed. The static policy guards that *can* run everywhere
// live in `tools/infra-policy.test.mjs` and do run in `pnpm check`; this file is
// invoked through the `infra:*` Nx targets and the delivery workflow, where the
// pinned binary is installed.
//
// Nothing here reaches a provider API. `init` runs with `-backend=false`, so no
// state backend is contacted, and `tofu test` mocks the provider. There is no
// `plan` and no `apply` in this file.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const infraRoot = join(repoRoot, 'infra');
const pinnedVersion = readFileSync(join(infraRoot, '.terraform-version'), 'utf8').trim();

const mode = process.argv[2] ?? 'all';
const validModes = new Set(['fmt', 'validate', 'test', 'all']);

if (!validModes.has(mode)) {
  console.error(`Unknown mode "${mode}". Expected one of: ${[...validModes].join(', ')}.`);
  process.exit(2);
}

function tofu(args, cwd) {
  return spawnSync('tofu', args, {
    cwd,
    encoding: 'utf8',
    stdio: 'pipe',
    env: { ...process.env, TF_IN_AUTOMATION: '1' },
  });
}

const versionCheck = tofu(['version'], repoRoot);

if (versionCheck.error) {
  console.error(
    [
      `OpenTofu ${pinnedVersion} is required and was not found on PATH.`,
      '',
      'Install the pinned version, then re-run. CI installs it with',
      'opentofu/setup-opentofu, pinned in .github/workflows/delivery.yml.',
      '',
      'This check is not skipped when the tool is missing: a gate that passes',
      'silently because its tool is absent is worse than no gate.',
    ].join('\n'),
  );
  process.exit(1);
}

const reported = versionCheck.stdout.match(/OpenTofu v(\d+\.\d+\.\d+)/)?.[1];

if (reported !== pinnedVersion) {
  console.error(
    `OpenTofu ${pinnedVersion} is pinned in infra/.terraform-version but ${reported ?? 'an unrecognised version'} is on PATH.`,
  );
  process.exit(1);
}

function directoriesUnder(parent) {
  const path = join(infraRoot, parent);
  if (!existsSync(path)) return [];
  return readdirSync(path, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({ label: `${parent}/${entry.name}`, path: join(path, entry.name) }));
}

const targets = [...directoriesUnder('modules'), ...directoriesUnder('stacks')];
const failures = [];

// A failure as a workflow annotation as well as as log output.
//
// Added because the log was the only place a failure appeared, and an Actions log
// is served from a host that not every client can follow — a reviewer, or an agent
// fixing the failure, could see that the job exited 1 and nothing about why.
// `::error::` becomes a check annotation, which is readable through the ordinary
// checks API and visible in the pull request without opening the run.
//
// Bounded and escaped: the first lines only, newlines encoded as `%0A` because a
// workflow command is one line, and the usual `::` and `,` escapes so a path or a
// diff cannot terminate the command early. The content is this repository's own
// OpenTofu output, which holds no secret value — no stack here declares one.
function annotate(label, output) {
  if (process.env.GITHUB_ACTIONS !== 'true') return;
  const excerpt = output
    // Full escape sequences, not just their prefix: a half-stripped colour code
    // leaves `0m1m` noise in the middle of the message.
    .replaceAll(/\u001B\[[0-9;]*[A-Za-z]/gu, '')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .slice(0, 40)
    .join('\n')
    .slice(0, 4000)
    .replaceAll('%', '%25')
    .replaceAll('\r', '%0D')
    .replaceAll('\n', '%0A')
    .replaceAll('::', '%3A%3A');
  console.log(`::error title=infra-check ${label}::${excerpt}`);
}

function run(label, args, cwd, { quiet = false } = {}) {
  const result = tofu(args, cwd);
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trimEnd();
  if (result.status !== 0) {
    failures.push(label);
    console.error(`\nFAIL ${label}\n${output}`);
    annotate(label, output);
    return false;
  }
  if (!quiet && output) console.log(output);
  return true;
}

if (mode === 'fmt' || mode === 'all') {
  console.log(`# tofu fmt (OpenTofu ${pinnedVersion})`);
  run('fmt', ['fmt', '-recursive', '-check', '-diff'], infraRoot);
}

if (mode === 'validate' || mode === 'test' || mode === 'all') {
  for (const target of targets) {
    const hasTests =
      existsSync(join(target.path, 'tests')) &&
      readdirSync(join(target.path, 'tests')).some((name) => name.endsWith('.tftest.hcl'));

    console.log(`\n# ${target.label}`);

    // `-backend=false` initialises providers without configuring or contacting a
    // state backend.
    if (
      !run(`${target.label} init`, ['init', '-backend=false', '-input=false'], target.path, {
        quiet: true,
      })
    ) {
      continue;
    }

    if (mode === 'validate' || mode === 'all') {
      run(`${target.label} validate`, ['validate'], target.path);
    }

    if ((mode === 'test' || mode === 'all') && hasTests) {
      run(`${target.label} test`, ['test'], target.path);
    }
  }
}

if (failures.length > 0) {
  const summary = `${failures.length} infrastructure check(s) failed: ${failures.join(', ')}`;
  console.error(`\n${summary}`);
  annotate('summary', summary);
  process.exit(1);
}

console.log(
  `\nInfrastructure checks passed (${mode}) across ${targets.length} modules and stacks.`,
);
