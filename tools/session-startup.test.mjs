import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, readlinkSync, realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const names = ['start-work', 'start-plan', 'start-debug'];
const skillPath = (name) => `.agents/skills/${name}/SKILL.md`;
const promptPath = (name) => `.pi/prompts/${name}.md`;
const aliasPath = (name) => `.claude/skills/${name}`;
const read = (path) => readFileSync(resolve(root, path), 'utf8');

// These fixtures deliberately use only flat, single-line frontmatter.
// Native harness parsing and behavior require separate loader/smoke checks.
function markdown(path) {
  const match = read(path).match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  assert.ok(match, `${path} has frontmatter on the first line`);
  const fields = Object.fromEntries(
    match[1].split('\n').map((line) => {
      const field = line.match(/^([a-z][a-z-]*): (.+)$/);
      assert.ok(field, `${path} uses a flat, nonempty metadata field`);
      return [field[1], field[2]];
    }),
  );
  return { fields, body: match[2] };
}

for (const name of names) {
  test(`${name} is a manual-only inline skill with no tool or model overrides`, () => {
    const { fields, body } = markdown(skillPath(name));
    assert.deepEqual(Object.keys(fields).sort(), [
      'argument-hint',
      'description',
      'disable-model-invocation',
      'name',
    ]);
    assert.equal(fields.name, name);
    assert.ok(fields.description.length <= 1024);
    assert.match(fields['argument-hint'], /^(['"])\[.+\]\1$/);
    assert.equal(fields['disable-model-invocation'], 'true');
    assert.doesNotMatch(body, /\$(?:ARGUMENTS|\d|\{)|!`/);
  });

  test(`${name} resolves to the same source through Claude's skill directory`, () => {
    const alias = resolve(root, aliasPath(name));
    const canonical = resolve(root, '.agents/skills', name);
    assert.ok(lstatSync(alias).isSymbolicLink(), 'preserve the directory symlink in Git');
    assert.equal(readlinkSync(alias), `../../.agents/skills/${name}`);
    assert.equal(realpathSync(alias), realpathSync(canonical));
    assert.equal(read(`${aliasPath(name)}/SKILL.md`), read(skillPath(name)));
  });

  test(`${name} has a thin Pi wrapper with an optional initialize-only request`, () => {
    const { fields, body } = markdown(promptPath(name));
    assert.deepEqual(Object.keys(fields).sort(), ['argument-hint', 'description']);
    assert.equal(fields['argument-hint'], markdown(skillPath(name)).fields['argument-hint']);
    assert.ok(body.includes(`Read \`${skillPath(name)}\``));
    assert.ok(body.includes(`follow the \`${name}\` skill in this session`));
    assert.match(body, /If the skill is unavailable, stop and report it/);
    assert.match(body, /\$\{ARGUMENTS:-Initialize only; no [^}]+ has been supplied\.\}/);
    assert.doesNotMatch(body, /\/skill:/, 'prompt expansion is not recursive skill dispatch');
    assert.ok(body.length < 700, 'keep the role workflow in the shared skill, not the wrapper');
  });

  test(`${name} retains source guardrails for kind, scope, empty input, and harness routing`, () => {
    const { body } = markdown(skillPath(name));
    assert.match(body, /direct human request/);
    assert.match(body, /independent Money Noodle session/);
    assert.match(body, /remain a bounded child/);
    assert.match(body, /Resumption retains existing scope and authority/);
    assert.match(body, /initialize read-only/);
    assert.match(body, /do not select or claim backlog work automatically/);
    assert.match(body, /unavailable registry evidence is unknown, not unclaimed work/);
    assert.match(body, /In \*\*Pi only\*\*/);
    assert.match(body, /In \*\*Claude Code\*\*/);
    assert.match(body, /do not import Pi model routes or lifecycle APIs/);
  });
}

test('role workflows keep execution, review, and human-directed debugging distinct', () => {
  assert.match(
    read(skillPath('start-work')),
    /isolated claimed writers and independent validation/,
  );
  assert.match(read(skillPath('start-plan')), /Do not silently fix the reviewed source/);
  assert.match(read(skillPath('start-plan')), /fresh context for serious independent review/);
  assert.match(read(skillPath('start-debug')), /a supervisor must not launch a debugger/);
  assert.match(
    read(skillPath('start-debug')),
    /Work directly with the human rather than managing subagents/,
  );
  assert.match(
    read(skillPath('start-debug')),
    /Lasting changes still require authorized isolated work/,
  );
});

test('startup Markdown links resolve from the skill or document directory', () => {
  const files = [
    '.agents/skills/README.md',
    '.pi/README.md',
    ...names.map(skillPath),
    ...names.map(promptPath),
  ];
  for (const file of files) {
    for (const match of read(file).matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
      const target = match[1].split('#', 1)[0];
      if (!target || target.includes('://')) continue;
      assert.ok(existsSync(resolve(root, dirname(file), target)), `${file}: missing ${target}`);
    }
  }
});

test('Git admits shared skills and only the three intended Claude aliases, not private state', () => {
  const publicPaths = [
    ...names.map(skillPath),
    ...names.map(promptPath),
    ...names.map(aliasPath),
    '.agents/skills/README.md',
    '.pi/README.md',
  ];
  const privatePaths = [
    '.claude/settings.local.json',
    '.claude/skills/local-only',
    '.claude/skills/local-only/SKILL.md',
    '.claude/sessions/startup.json',
    '.pi/runs/startup.json',
  ];
  const result = spawnSync('git', ['check-ignore', '--no-index', '-z', '--stdin'], {
    cwd: root,
    encoding: 'utf8',
    input: [...publicPaths, ...privatePaths].join('\0') + '\0',
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  const ignored = new Set(result.stdout.split('\0').filter(Boolean));
  for (const path of publicPaths) assert.ok(!ignored.has(path), `${path} must be Git-visible`);
  for (const path of privatePaths) assert.ok(ignored.has(path), `${path} must stay ignored`);
});
