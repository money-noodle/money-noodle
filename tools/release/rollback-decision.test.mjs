// The four rollback rules, read back as a specification.
//
// Provider-free by construction: nothing here starts a container, opens a
// socket or reads a credential. Every revision name is obviously synthetic.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  HALT,
  HALT_REASONS,
  MAX_HEALTH_CHECKS,
  NONE,
  ROLLBACK,
  decideRollback,
} from './rollback-decision.mjs';

const PREVIOUS = 'platform-api-00041-abc';
const check = (healthy) => ({ healthy });

/**
 * Follows the decisions for one whole deploy, exactly as an operator would.
 *
 * The health results are scripted, so this performs no work: it records what it
 * was told to do. The step bound is deliberately larger than the rules allow,
 * so a helper that kept asking for rollbacks would be caught rather than loop.
 */
function runDeploy({ healthResults, previousRevision }) {
  const healthChecks = [check(healthResults[0])];
  const decisions = [];
  for (let step = 0; step < 5; step += 1) {
    const decision = decideRollback({ healthChecks, previousRevision });
    decisions.push(decision);
    if (decision.action !== ROLLBACK) break;
    // Rule 3: having rolled back, run the health check once more.
    healthChecks.push(check(healthResults[healthChecks.length] ?? false));
  }
  return {
    decisions,
    final: decisions.at(-1),
    rollbacks: decisions.filter(({ action }) => action === ROLLBACK).length,
  };
}

test('rule 2: a healthy deploy is left alone', () => {
  assert.deepEqual(decideRollback({ healthChecks: [check(true)], previousRevision: PREVIOUS }), {
    action: NONE,
  });
  // With or without a noted revision: a healthy deploy never needs one.
  assert.deepEqual(decideRollback({ healthChecks: [check(true)], previousRevision: null }), {
    action: NONE,
  });
});

test('rule 3: a failed check with a noted revision rolls back to exactly that revision', () => {
  const decision = decideRollback({ healthChecks: [check(false)], previousRevision: PREVIOUS });
  assert.equal(decision.action, ROLLBACK);
  assert.equal(decision.revision, PREVIOUS);

  // Verbatim, not derived. Each of these would change under any normalisation
  // a helper might be tempted to apply — case folding, trimming, suffixing —
  // so an exact-identity assertion is the only thing that passes. A noted name
  // the caller got wrong should surface as that wrong name, not as a different
  // revision this module invented for it.
  for (const noted of ['web-00007-xyz.candidate', 'Web-00007-XYZ', '  web-00007-xyz  ']) {
    const decision = decideRollback({ healthChecks: [check(false)], previousRevision: noted });
    assert.equal(decision.action, ROLLBACK);
    assert.ok(Object.is(decision.revision, noted), `expected ${JSON.stringify(noted)} verbatim`);
  }
});

test('rule 4: a failed check with no noted revision halts rather than guessing', () => {
  for (const previousRevision of [null, undefined, '', '   ', 42, {}, ['a']]) {
    const decision = decideRollback({ healthChecks: [check(false)], previousRevision });
    assert.equal(decision.action, HALT, `expected halt for ${JSON.stringify(previousRevision)}`);
    assert.equal(decision.reason, HALT_REASONS.NO_PREVIOUS_REVISION);
    assert.equal(decision.revision, undefined, 'a halt names no rollback target');
  }
});

test('rule 4: a failed re-check after the rollback halts', () => {
  const decision = decideRollback({
    healthChecks: [check(false), check(false)],
    previousRevision: PREVIOUS,
  });
  assert.equal(decision.action, HALT);
  assert.equal(decision.reason, HALT_REASONS.ROLLBACK_DID_NOT_RECOVER);
});

test('a recovered re-check after the rollback needs nothing further', () => {
  assert.deepEqual(
    decideRollback({ healthChecks: [check(false), check(true)], previousRevision: PREVIOUS }),
    { action: NONE },
  );
});

test('never more than one rollback per deploy, over every scripted deploy', () => {
  const revisions = [PREVIOUS, null, undefined, '', '   '];
  const scripts = [
    [true, true],
    [true, false],
    [false, true],
    [false, false],
  ];

  for (const previousRevision of revisions) {
    for (const healthResults of scripts) {
      const run = runDeploy({ healthResults, previousRevision });
      const label = `${JSON.stringify(previousRevision)} / ${JSON.stringify(healthResults)}`;

      assert.ok(run.rollbacks <= 1, `${label} asked for ${run.rollbacks} rollbacks`);
      // A deploy always ends decided, never still asking to roll back.
      assert.notEqual(run.final.action, ROLLBACK, `${label} never settled`);

      const usable = typeof previousRevision === 'string' && previousRevision.trim().length > 0;
      const expected = !healthResults[0] && usable ? 1 : 0;
      assert.equal(run.rollbacks, expected, `${label} rolled back ${run.rollbacks} times`);

      // An unhealthy deploy that cannot be recovered must end in halt, never
      // in `none`: "nothing to do" is the one wrong answer here.
      if (!healthResults[0] && !(usable && healthResults[1])) {
        assert.equal(run.final.action, HALT, `${label} ended ${run.final.action}`);
      }
    }
  }
});

test('a third health check halts: it could only follow a second rollback', () => {
  const decision = decideRollback({
    healthChecks: [check(false), check(false), check(true)],
    previousRevision: PREVIOUS,
  });
  assert.equal(decision.action, HALT);
  assert.equal(decision.reason, HALT_REASONS.TOO_MANY_HEALTH_CHECKS);
  assert.equal(MAX_HEALTH_CHECKS, 2);
});

test('unreadable health results halt rather than pass', () => {
  const unreadable = [
    undefined,
    null,
    [],
    'healthy',
    [{}],
    [{ healthy: 'true' }],
    [{ healthy: 1 }],
    [null],
    [check(false), { healthy: undefined }],
  ];
  for (const healthChecks of unreadable) {
    const decision = decideRollback({ healthChecks, previousRevision: PREVIOUS });
    assert.equal(decision.action, HALT, `expected halt for ${JSON.stringify(healthChecks)}`);
    assert.equal(decision.reason, HALT_REASONS.UNREADABLE_HEALTH_RESULTS);
  }
});

test('a re-check that no rollback could have produced halts', () => {
  // The deploy passed, so nothing should have rolled back.
  assert.equal(
    decideRollback({ healthChecks: [check(true), check(true)], previousRevision: PREVIOUS }).reason,
    HALT_REASONS.UNEXPECTED_RECHECK,
  );
  // There was no revision to roll back to, so a second check cannot exist.
  assert.equal(
    decideRollback({ healthChecks: [check(false), check(true)], previousRevision: null }).reason,
    HALT_REASONS.RECHECK_WITHOUT_ROLLBACK,
  );
});

test('the decision is total, pure and frozen', () => {
  // Total: no input throws, including no input at all.
  for (const input of [undefined, null, 0, 'deploy', [], {}, { healthChecks: [check(false)] }]) {
    const decision = decideRollback(input);
    assert.ok([NONE, ROLLBACK, HALT].includes(decision.action));
    assert.ok(Object.isFrozen(decision), 'a decision is frozen');
  }

  // Pure: same inputs, same answer, and the caller's input is not mutated.
  const healthChecks = [check(false)];
  const input = { healthChecks, previousRevision: PREVIOUS };
  const first = decideRollback(input);
  const second = decideRollback(input);
  assert.deepEqual(first, second);
  assert.deepEqual(input, { healthChecks: [check(false)], previousRevision: PREVIOUS });
  assert.equal(healthChecks.length, 1, 'the helper does not record checks of its own');
});
