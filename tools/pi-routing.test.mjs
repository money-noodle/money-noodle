import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const settings = JSON.parse(read('.pi/settings.json'));
const roles = settings.subagents.agentOverrides;
const claude = 'pi-claude-code-provider/opus';
const astra = 'openai-codex/gpt-6-astra';
const jsonExamples = [...read('.pi/README.md').matchAll(/```json\n([\s\S]*?)\n```/g)].map((match) =>
  JSON.parse(match[1]),
);

// Offline source contracts only: no installed Pi package, account, or model is exercised.
test('Pi pins reviewed packages without changing the Astra/max supervisor route', () => {
  assert.equal(settings.defaultProvider, 'openai-codex');
  assert.equal(settings.defaultModel, 'gpt-6-astra');
  assert.equal(settings.defaultThinkingLevel, 'max');
  assert.deepEqual(settings.packages, [
    'npm:pi-subagents@0.66.0',
    'npm:pi-claude-code-provider@0.2.0',
  ]);
  assert.equal(settings.subagents.projectRootResolution, 'git-root');
});

test('roles use ordered native backups with effort in the separate thinking key', () => {
  const expected = {
    scout: ['openai-codex/gpt-5.6-luna', claude, 'low'],
    worker: [claude, astra, 'medium'],
    delegate: [claude, astra, 'medium'],
    researcher: [claude, astra, 'medium'],
    reviewer: [claude, astra, 'high'],
    oracle: [claude, astra, 'max'],
  };
  assert.deepEqual(Object.keys(roles).sort(), Object.keys(expected).sort());
  for (const [role, [model, fallback, thinking]] of Object.entries(expected)) {
    assert.equal(roles[role].model, model, role);
    assert.deepEqual(roles[role].fallbackModels, [fallback], role);
    assert.doesNotMatch(roles[role].model, /:/, role);
    assert.doesNotMatch(roles[role].fallbackModels[0], /:/, role);
    assert.equal(roles[role].thinking, thinking, role);
    assert.equal(roles[role].defaultContext, 'fresh', role);
  }
});

test('routing does not add roles, tools, permissions, or disable providers', () => {
  assert.deepEqual(Object.keys(settings.subagents).sort(), [
    'agentOverrides',
    'projectRootResolution',
  ]);
  for (const [role, config] of Object.entries(roles)) {
    assert.deepEqual(
      Object.keys(config).sort(),
      ['defaultContext', 'fallbackModels', 'model', 'thinking'],
      role,
    );
  }
});

test('the documented fallback example matches the worker configuration', () => {
  assert.equal(jsonExamples.length, 2);
  assert.deepEqual(jsonExamples[0], roles.worker);
});

test('the documented 1M opt-in changes only private Opus context metadata', () => {
  assert.deepEqual(jsonExamples[1], {
    providers: {
      'pi-claude-code-provider': {
        modelOverrides: { opus: { contextWindow: 1000000 } },
      },
    },
  });
});

test('the runtime prompt retains quota uncertainty, native boundaries, and safe recovery', () => {
  const policy = read('.pi/APPEND_SYSTEM.md');
  assert.match(policy, /Pi owns tools, prompts, permissions, supervision, and lifecycle/);
  assert.match(policy, /Provider-reported windows, restrictions, and reset instants win/);
  assert.match(policy, /Unknown remaining quota stays unknown/);
  assert.match(policy, /before any tool activity/);
  assert.match(policy, /no automatic cross-provider continuation/);
  assert.match(
    policy,
    /does not clear the role's fallback chain or raise its backup thinking level/,
  );
  assert.match(policy, /24 hours by default/);
  assert.match(policy, /Never relabel a safeguard refusal/);
  assert.match(policy, /Retained resumes keep their model\/tool contract/);
  assert.match(policy, /Never use a resume override to change the model/);
  assert.match(policy, /blindly replay mutation work, or start a competing writer/);
  assert.match(policy, /does not expand any tool ceiling/);
  assert.match(policy, /An unavailable approved route or supervisor mismatch must be surfaced/);
});
