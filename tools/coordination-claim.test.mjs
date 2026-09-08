import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  applyClaimFields,
  checkClaimable,
  claim,
  claimBranch,
  claimRef,
  parseArguments,
  readBodyField,
  renderResult,
} from './coordination-claim.mjs';

const BODY = [
  'Scope-Paths: tools/example.mjs',
  'Depends-On: none',
  'Dependency-Notes: none',
  'Claim-Agent: unclaimed',
  'Claim-Branch: none',
  'Claimed-At: none',
  'Integration-Owner: money-noodle',
].join('\n');

function fakeApi({ issue, createStatus = 201, updateFails = false }) {
  const calls = [];
  return {
    calls,
    async getIssue() {
      calls.push(['getIssue']);
      return { ...issue, labels: [...issue.labels] };
    },
    async getMainSha() {
      calls.push(['getMainSha']);
      return 'a'.repeat(40);
    },
    async createRef(input) {
      calls.push(['createRef', input]);
      return {
        statusCode: createStatus,
        ref: input.ref,
        object: { type: 'commit', sha: input.sha },
      };
    },
    async getRef(branch) {
      calls.push(['getRef', branch]);
      return { ref: `refs/heads/${branch}`, object: { type: 'commit', sha: 'a'.repeat(40) } };
    },
    async updateIssue(number, patch) {
      calls.push(['updateIssue', number, patch]);
      if (updateFails) throw new Error('403 forbidden');
    },
  };
}

const openIssue = (overrides = {}) => ({
  number: 7,
  state: 'open',
  title: 'Work: example',
  body: BODY,
  labels: ['work:ready', 'area:tools'],
  ...overrides,
});

const at = () => new Date('2026-09-08T12:00:00.000Z');

test('branch and ref are derived from the issue number alone', () => {
  assert.equal(claimBranch(7), 'claim-v1/issue-7');
  assert.equal(claimRef(7), 'refs/heads/claim-v1/issue-7');
});

test('a 201 ref creation wins the claim and rewrites exactly the claim fields', async () => {
  const api = fakeApi({ issue: openIssue() });
  const result = await claim({ issue: 7, agent: 'noodle-1', api, now: at });

  assert.equal(result.outcome, 'claimed');
  assert.equal(result.branch, 'claim-v1/issue-7');
  assert.deepEqual(api.calls[2], [
    'createRef',
    { ref: 'refs/heads/claim-v1/issue-7', sha: 'a'.repeat(40) },
  ]);

  const [, , patch] = api.calls.find(([name]) => name === 'updateIssue');
  assert.deepEqual(patch.labels, ['area:tools', 'work:active']);
  assert.equal(readBodyField(patch.body, 'Claim-Agent'), 'noodle-1');
  assert.equal(readBodyField(patch.body, 'Claim-Branch'), 'claim-v1/issue-7');
  assert.equal(readBodyField(patch.body, 'Claimed-At'), '2026-09-08T12:00:00.000Z');
  assert.equal(readBodyField(patch.body, 'Scope-Paths'), 'tools/example.mjs');
  assert.equal(readBodyField(patch.body, 'Integration-Owner'), 'money-noodle');

  const output = renderResult(result);
  assert.match(output, /claim-v1\/issue-7/);
  assert.match(output, /git worktree add/);
});

test('a 422 loses the race and mutates nothing', async () => {
  const holderBody = applyClaimFields(BODY, {
    agent: 'noodle-2',
    branch: 'claim-v1/issue-7',
    claimedAt: '2026-09-07T09:00:00.000Z',
  });
  const api = fakeApi({ issue: openIssue(), createStatus: 422 });
  let reads = 0;
  api.getIssue = async () => {
    reads += 1;
    return reads === 1
      ? openIssue()
      : openIssue({ body: holderBody, labels: ['work:active', 'area:tools'] });
  };

  const result = await claim({ issue: 7, agent: 'noodle-1', api, now: at });

  assert.equal(result.outcome, 'already-claimed');
  assert.equal(result.holder, 'noodle-2');
  assert.equal(result.claimedAt, '2026-09-07T09:00:00.000Z');
  assert.equal(
    api.calls.filter(([name]) => name === 'updateIssue').length,
    0,
    'a lost race must not write anything',
  );
  assert.match(renderResult(result), /recorded holder noodle-2/);
});

test('any other create status mutates nothing and reports what was observed', async () => {
  const api = fakeApi({ issue: openIssue(), createStatus: 500 });
  const result = await claim({ issue: 7, agent: 'noodle-1', api, now: at });

  assert.equal(result.outcome, 'ref-create-failed');
  assert.match(result.detail, /500/);
  assert.equal(api.calls.filter(([name]) => name === 'updateIssue').length, 0);
});

test('an issue that is not claimable is rejected before any ref is created', async () => {
  for (const issue of [
    openIssue({ state: 'closed' }),
    openIssue({ labels: ['area:tools'] }),
    openIssue({ labels: ['work:ready', 'work:proposed'] }),
    openIssue({ labels: ['work:active'] }),
    openIssue({ labels: ['work:ready', 'work:review'] }),
    openIssue({ labels: ['work:ready', 'work:blocked'] }),
    openIssue({ labels: ['work:ready', 'work:plan'] }),
    openIssue({ pull_request: {} }),
    openIssue({ body: BODY + '\nClaim-Agent: unclaimed' }),
    openIssue({ body: BODY.replace('Claim-Branch: none', 'Claim-Branch: feat/owned') }),
    openIssue({ body: BODY.replace('Claim-Agent: unclaimed', 'Claim-Agent: noodle-2') }),
  ]) {
    const api = fakeApi({ issue });
    const result = await claim({ issue: 7, agent: 'noodle-1', api, now: at });
    assert.equal(result.outcome, 'not-claimable', JSON.stringify(issue.labels));
    assert.deepEqual(
      api.calls.map(([name]) => name),
      ['getIssue'],
      'nothing beyond the read may happen',
    );
  }
  assert.equal(checkClaimable(openIssue()), undefined);
});

test('a failed issue update keeps the ref and prints the exact manual finish', async () => {
  const api = fakeApi({ issue: openIssue(), updateFails: true });
  const result = await claim({ issue: 7, agent: 'noodle-1', api, now: at });

  assert.equal(result.outcome, 'issue-update-failed');
  const output = renderResult(result);
  assert.match(output, /You own claim-v1\/issue-7/);
  assert.match(output, /gh issue edit 7 --add-label work:active/);
  assert.match(output, /Do not delete the ref/);
  assert.doesNotMatch(output, /delete-ref|rollback/i);
});

test('claim fields are appended when the body is missing them', () => {
  const updated = applyClaimFields('Scope-Paths: none', {
    agent: 'noodle-1',
    branch: 'claim-v1/issue-9',
    claimedAt: '2026-09-08T12:00:00.000Z',
  });
  assert.equal(readBodyField(updated, 'Claim-Agent'), 'noodle-1');
  assert.equal(readBodyField(updated, 'Claim-Branch'), 'claim-v1/issue-9');
});

test('arguments require a positive issue number and an agent label', () => {
  assert.deepEqual(parseArguments(['--issue', '7', '--agent', 'noodle-1']), {
    issue: 7,
    agent: 'noodle-1',
  });
  assert.throws(() => parseArguments(['--agent', 'noodle-1']), /--issue/);
  assert.throws(() => parseArguments(['--issue', '7']), /--agent/);
  assert.throws(() => parseArguments(['--issue', '0', '--agent', 'a']), /--issue/);
  assert.throws(() => parseArguments(['--force']), /unknown argument/);
});

const formBody = BODY.split('\n')
  .map((line) => {
    const [name, ...value] = line.split(': ');
    return `### ${name}\n\n${value.join(': ')}\n`;
  })
  .join('\n');

test('real form headings and multiline scope round-trip through claim bookkeeping', async () => {
  const source =
    formBody.replace('tools/example.mjs', 'tools/example.mjs\ndocs/example.md') +
    '\n### Acceptance\n\nKeep this prose.\n';
  const api = fakeApi({ issue: openIssue({ body: source }) });
  const result = await claim({ issue: 7, agent: 'worker', api, now: at });
  assert.equal(result.outcome, 'claimed');
  const patch = api.calls.find(([name]) => name === 'updateIssue')[2];
  assert.match(patch.body, /### Claim-Agent\n\nworker\n/);
  assert.equal(readBodyField(patch.body, 'Scope-Paths'), 'tools/example.mjs\ndocs/example.md');
  assert.match(patch.body, /### Acceptance\n\nKeep this prose/);
  assert.equal(
    checkClaimable(openIssue({ body: source + '\nClaim-Agent: unclaimed' })),
    'Claim-Agent is duplicated',
  );
});

test('two concurrent contenders share one existing-compatible atomic mutex', async () => {
  let reserved = false;
  const api = fakeApi({ issue: openIssue() });
  api.createRef = async ({ ref, sha }) => {
    assert.equal(ref, 'refs/heads/claim-v1/issue-7');
    if (reserved) return { statusCode: 422 };
    reserved = true;
    return { statusCode: 201, ref, object: { type: 'commit', sha } };
  };
  const results = await Promise.all(
    ['one', 'two'].map((agent) => claim({ issue: 7, agent, api, now: at })),
  );
  assert.deepEqual(results.map((result) => result.outcome).sort(), ['already-claimed', 'claimed']);
  assert.equal(api.calls.filter(([name]) => name === 'updateIssue').length, 1);
});

test('unconfirmed 201, 422 without exact ref, timeout and server failure never grant ownership', async () => {
  for (const created of [
    { statusCode: 201 },
    { statusCode: 201, ref: claimRef(8), object: { type: 'commit', sha: 'a'.repeat(40) } },
    { statusCode: 422 },
    { statusCode: 500 },
    new Error('timeout after request'),
  ]) {
    const api = fakeApi({ issue: openIssue() });
    api.createRef = async () => {
      if (created instanceof Error) throw created;
      return created;
    };
    api.getRef = async () => {
      throw new Error('404 or unavailable');
    };
    const result = await claim({ issue: 7, agent: 'worker', api, now: at });
    assert.equal(result.outcome, 'ref-create-failed');
    assert.equal(api.calls.filter(([name]) => name === 'updateIssue').length, 0);
    assert.match(renderResult(result), /outcome unknown/);
    assert.doesNotMatch(renderResult(result), /Nothing was changed|You own/);
  }
});

test('fresh unrelated body and label edits are preserved, conflicting claim edits stop bookkeeping', async () => {
  for (const conflict of [false, true]) {
    const api = fakeApi({ issue: openIssue() });
    let reads = 0;
    api.getIssue = async () =>
      ++reads === 1
        ? openIssue()
        : openIssue({
            body: BODY + '\nFresh unrelated narrative.',
            labels: conflict ? ['work:blocked'] : ['work:ready', 'area:new'],
          });
    const result = await claim({ issue: 7, agent: 'worker', api, now: at });
    const writes = api.calls.filter(([name]) => name === 'updateIssue');
    if (conflict) {
      assert.equal(result.outcome, 'issue-update-failed');
      assert.equal(writes.length, 0);
      assert.match(renderResult(result), /Preserve the reservation/);
    } else {
      assert.equal(result.outcome, 'claimed');
      assert.match(writes[0][2].body, /Fresh unrelated narrative/);
      assert.deepEqual(writes[0][2].labels, ['area:new', 'work:active']);
    }
  }
});

test('bad local inputs and unavailable reads stop before a create attempt', async () => {
  const api = fakeApi({ issue: openIssue() });
  for (const agent of ['none', 'unclaimed', 'bad\nClaim-Agent: injected', '   ']) {
    await assert.rejects(claim({ issue: 7, agent, api }), /--agent/);
  }
  await assert.rejects(
    claim({ issue: Number.MAX_SAFE_INTEGER + 1, agent: 'worker', api }),
    /--issue/,
  );
  assert.equal(api.calls.length, 0);
  api.getIssue = async () => {
    throw new Error('host unavailable');
  };
  const result = await claim({ issue: 7, agent: 'worker', api });
  assert.equal(result.outcome, 'read-failed');
  assert.match(renderResult(result), /Coordination unknown/);
  assert.equal(api.calls.length, 0);
  for (const input of ['1e2', '01', '7.0'])
    assert.throws(() => parseArguments(['--issue', input, '--agent', 'a']), /--issue/);
});

test('missing, self, open and abandoned prerequisites do not create refs', async () => {
  for (const dependency of [
    undefined,
    openIssue({ number: 8 }),
    openIssue({ number: 8, state: 'closed', labels: ['work:abandoned'] }),
    openIssue({ number: 8, state: 'closed', labels: [], state_reason: 'not_planned' }),
  ]) {
    const api = fakeApi({ issue: openIssue() });
    api.getIssue = async (number) =>
      number === 7
        ? openIssue({ body: BODY.replace('Depends-On: none', 'Depends-On: #8') })
        : dependency;
    const result = await claim({ issue: 7, agent: 'worker', api });
    assert.notEqual(result.outcome, 'claimed');
    assert.equal(api.calls.length, 0);
  }
});

test('minimal four-field Issue Form is unclaimed and receives tool-written metadata only after winning', async () => {
  const minimal =
    '### Outcome\n\nMake an example.\n\n### Scope-Paths\n\ntools/example.mjs\n\n### Depends-On\n\nnone\n\n### Acceptance checks\n\nRun the focused tests.\n';
  for (const status of [201, 422, 500]) {
    const api = fakeApi({ issue: openIssue({ body: minimal }), createStatus: status });
    const result = await claim({ issue: 7, agent: 'worker', api, now: at });
    const writes = api.calls.filter(([name]) => name === 'updateIssue');
    if (status === 201) {
      assert.equal(result.outcome, 'claimed');
      assert.equal(writes.length, 1);
      assert.ok(writes[0][2].body.startsWith(minimal));
      assert.equal(readBodyField(writes[0][2].body, 'Claim-Agent'), 'worker');
      assert.equal(readBodyField(writes[0][2].body, 'Claim-Branch'), 'claim-v1/issue-7');
      assert.equal(readBodyField(writes[0][2].body, 'Claimed-At'), at().toISOString());
    } else {
      assert.equal(writes.length, 0);
      assert.equal(result.outcome, status === 422 ? 'already-claimed' : 'ref-create-failed');
    }
  }
  for (const partial of [
    'Claim-Agent: unclaimed',
    'Claim-Branch: none',
    'Claimed-At: none',
    'Claim-Agent: worker',
  ]) {
    assert.match(
      checkClaimable(openIssue({ body: minimal + '\n' + partial })),
      /partial or not unclaimed/,
    );
  }
});

test('claim CLI adapter uses mocked gh effects, exact HTTP creation evidence and fresh PATCH inputs', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'mn-claim-cli-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const log = join(directory, 'requests.jsonl');
  const hostIssue = { ...openIssue(), labels: [{ name: 'work:ready' }, { name: 'area:tools' }] };
  writeFileSync(
    join(directory, 'gh'),
    `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
const body = fs.readFileSync(0, 'utf8');
fs.appendFileSync(process.env.MOCK_LOG, JSON.stringify({ args, body }) + '\\n');
const issue = ${JSON.stringify(hostIssue)};
const ref = { ref: 'refs/heads/claim-v1/issue-7', object: { type: 'commit', sha: '${'a'.repeat(40)}' } };
if (args.includes('POST')) {
  const status = process.env.MOCK_STATUS;
  process.stdout.write('HTTP/2.0 ' + status + ' Result\\r\\ncontent-type: application/json\\r\\n\\r\\n' + (status === '201' ? JSON.stringify(ref) : '{}'));
  if (status !== '201') process.exitCode = 1;
} else if (args.includes('PATCH')) {
  process.stdout.write(JSON.stringify({ ...issue, ...JSON.parse(body), labels: JSON.parse(body).labels.map(name => ({ name })) }));
} else if (args.some(arg => arg.endsWith('/git/ref/heads/main'))) {
  process.stdout.write(JSON.stringify({ ...ref, ref: 'refs/heads/main' }));
} else if (args.some(arg => arg.endsWith('/git/ref/heads/claim-v1/issue-7'))) {
  process.stdout.write(JSON.stringify(ref));
} else if (args.some(arg => arg.endsWith('/issues/7'))) {
  process.stdout.write(JSON.stringify(issue));
} else { process.stderr.write('unexpected host operation'); process.exitCode = 9; }
`,
    { mode: 0o755 },
  );
  for (const status of ['201', '422', '500']) {
    writeFileSync(log, '');
    const result = spawnSync(
      process.execPath,
      ['tools/coordination-claim.mjs', '--issue', '7', '--agent', 'worker'],
      {
        encoding: 'utf8',
        timeout: 10_000,
        env: { ...process.env, PATH: directory, MOCK_LOG: log, MOCK_STATUS: status },
      },
    );
    assert.equal(result.status, status === '201' ? 0 : 1, result.stderr);
    const requests = readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
    const creates = requests.filter((request) => request.args.includes('POST'));
    assert.equal(creates.length, 1);
    assert.deepEqual(JSON.parse(creates[0].body), { ref: claimRef(7), sha: 'a'.repeat(40) });
    assert.equal(
      requests.filter((request) => request.args.includes('PATCH')).length,
      status === '201' ? 1 : 0,
    );
    assert.ok(
      requests.every(
        (request) => !request.args.includes('DELETE') && !request.args.includes('PUT'),
      ),
    );
    if (status === '500') assert.match(result.stdout, /outcome unknown/);
  }
});

test('a bookkeeping reread failure or changed scope preserves the confirmed reservation', async () => {
  for (const change of ['offline', 'closed', 'scope']) {
    const api = fakeApi({ issue: openIssue() });
    let reads = 0;
    api.getIssue = async () => {
      if (++reads === 1) return openIssue();
      if (change === 'offline') throw new Error('host unavailable after creation');
      return change === 'closed'
        ? openIssue({ state: 'closed' })
        : openIssue({ body: BODY.replace('tools/example.mjs', 'docs/**') });
    };
    const result = await claim({ issue: 7, agent: 'worker', api, now: at });
    assert.equal(result.outcome, 'issue-update-failed');
    assert.equal(api.calls.filter(([name]) => name === 'createRef').length, 1);
    assert.equal(api.calls.filter(([name]) => name === 'updateIssue').length, 0);
    assert.match(renderResult(result), /Preserve the reservation/);
  }
});

test('appending missing metadata does not swallow a final structured form field', () => {
  const source = '### Scope-Paths\n\nnone\n\n### Depends-On\n\nnone\n';
  const updated = applyClaimFields(source, {
    agent: 'worker',
    branch: claimBranch(7),
    claimedAt: at().toISOString(),
  });
  assert.equal(readBodyField(updated, 'Depends-On'), 'none');
  assert.equal(readBodyField(updated, 'Claim-Agent'), 'worker');
  assert.equal(readBodyField(updated, 'Claim-Branch'), claimBranch(7));
  assert.equal(readBodyField(updated, 'Claimed-At'), at().toISOString());
});
