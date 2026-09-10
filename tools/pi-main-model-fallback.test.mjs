import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import mainModelFallback, {
  registerMainModelFallback,
} from '../.pi/extensions/main-model-fallback.ts';

const root = new URL('../', import.meta.url);
const read = (path) => readFileSync(new URL(path, root), 'utf8');

// Offline wrapper/configuration contracts only. The upstream extension is injected,
// never imported here: CI does not install Pi, access accounts, or start children.
test('main fallback has only the exact approved Astra-to-Opus rule', () => {
  assert.deepEqual(JSON.parse(read('.pi/model-fallback/config.json')), {
    version: 1,
    enabled: true,
    rules: [
      {
        name: 'astra-to-opus',
        matchModels: [{ provider: 'openai-codex', model: 'gpt-6-astra' }],
        statuses: [429, 500, 502, 503, 504],
        fallback: { provider: 'pi-claude-code-provider', model: 'opus' },
      },
    ],
  });
});

test('unmarked main registers the injected upstream package once', async () => {
  const pi = {};
  let loads = 0;
  const registrations = [];
  await registerMainModelFallback(pi, {}, async () => {
    loads += 1;
    return { default: (api) => registrations.push(api) };
  });
  assert.equal(loads, 1);
  assert.deepEqual(registrations, [pi]);
});

for (const marker of ['1', '0', '', 'false']) {
  test(`child marker ${JSON.stringify(marker)} prevents import and every registration`, async () => {
    const pi = new Proxy({}, { get: () => assert.fail('child accessed the main-only API') });
    await registerMainModelFallback(pi, { PI_SUBAGENT_CHILD: marker }, () =>
      assert.fail('child imported the main-only package'),
    );
  });
}

test('the default entry observes the actual child environment marker', async (t) => {
  const before = process.env.PI_SUBAGENT_CHILD;
  t.after(() => {
    if (before === undefined) delete process.env.PI_SUBAGENT_CHILD;
    else process.env.PI_SUBAGENT_CHILD = before;
  });
  process.env.PI_SUBAGENT_CHILD = '1';
  const pi = new Proxy({}, { get: () => assert.fail('default entry registered child hooks') });
  await mainModelFallback(pi);
});

test('registration waits for loading instead of returning a false ready signal', async () => {
  let resolveLoad;
  let registered = false;
  const pending = new Promise((resolve) => {
    resolveLoad = resolve;
  });
  const completion = registerMainModelFallback({}, {}, () => pending);
  assert.equal(registered, false);
  resolveLoad({
    default: () => {
      registered = true;
    },
  });
  await completion;
  assert.equal(registered, true);
});

test('package loading failure propagates rather than enabling another execution path', async () => {
  const error = new Error('synthetic package load failure');
  await assert.rejects(
    registerMainModelFallback({}, {}, async () => {
      throw error;
    }),
    (actual) => actual === error,
  );
});

test('package registration failure propagates rather than claiming fallback is ready', async () => {
  const error = new Error('synthetic registration failure');
  await assert.rejects(
    registerMainModelFallback({}, {}, async () => ({
      default: () => {
        throw error;
      },
    })),
    (actual) => actual === error,
  );
});

test('Git shares only fallback config, never cooldown or recovery state', () => {
  const privatePaths = [
    '.pi/model-fallback/state.json',
    '.pi/model-fallback/config.local.json',
    '.pi/model-fallback/debug/recovery.json',
  ];
  const result = spawnSync('git', ['check-ignore', '--no-index', '--stdin'], {
    cwd: root,
    encoding: 'utf8',
    input: [...privatePaths, '.pi/model-fallback/config.json'].join('\n') + '\n',
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.stdout.trim().split('\n'), privatePaths);
});
