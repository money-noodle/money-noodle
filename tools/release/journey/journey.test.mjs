// The packaged-artifact release journey.
//
// Two journeys, both against the images the release actually publishes:
//
//   * A normal journey. The page must show the platform state as accessible
//     text and the very timestamp the packaged API produced for that request —
//     not a timestamp from some other request, and not the runner's clock.
//   * A forced-failure journey, once per upstream failure family. Each must
//     render "Status unknown"; none may invent an available, zero-like or stale
//     value.
//
// Failure is injected between the two artifacts by the CI-only fixture. Neither
// image carries a test switch, and nothing here rebuilds an artifact.
//
// This suite is enabled by its environment contract, which the release wiring
// supplies. `tools/release.test.mjs` refuses a run in which it was supposed to
// execute and skipped instead, so "enabled" cannot quietly become "absent".

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  HOST_GATEWAY,
  assertDockerAvailable,
  readJourneyEnvironment,
  runPackagedArtifact,
} from './packaged-artifacts.mjs';
import {
  FIXTURE_HOSTNAME,
  createJourneyCertificate,
  startUpstreamFixture,
} from './upstream-fixture.mjs';

const TRACEPARENT = /^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/u;
const RFC_3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u;

/** Each upstream failure family the accepted test layout requires, by mode. */
const FAILURE_MODES = Object.freeze([
  ['a timeout', 'timeout'],
  ['a transport failure', 'reset'],
  ['a malformed response', 'malformed'],
  ['an incompatible schema', 'incompatible'],
]);

const journey = readJourneyEnvironment();

/**
 * The browser, preferring the exact revision the pinned Playwright declares.
 *
 * The lockfile pins Playwright, Playwright pins its browser revision, and the
 * release wiring installs exactly that one — so the browser is exact-version
 * rather than whatever a runner image happens to carry today. The runner's own
 * Chrome is a fallback, not the intent, and a failure to launch any of them is
 * a failure: there is no silent skip.
 */
async function launchBrowser(chromium) {
  const explicit = process.env.MONEY_NOODLE_JOURNEY_BROWSER_PATH;
  const attempts = [
    ...(typeof explicit === 'string' && explicit.length > 0
      ? [['an explicitly configured browser', { executablePath: explicit }]]
      : []),
    ['the pinned Playwright Chromium', {}],
    ['the runner-installed Chrome channel', { channel: 'chrome' }],
  ];

  const refusals = [];
  for (const [label, options] of attempts) {
    try {
      return { browser: await chromium.launch(options), label };
    } catch (error) {
      refusals.push(`${label}: ${error.message.split('\n')[0]}`);
    }
  }
  throw new Error(`No usable browser for the release journey. ${refusals.join('; ')}`);
}

test(
  'the packaged artifacts serve the release journey',
  { skip: journey === undefined && 'not the packaged release journey run' },
  async (t) => {
    assertDockerAvailable();
    const { chromium } = await import('playwright');

    const directory = mkdtempSync(join(tmpdir(), 'money-noodle-journey-'));
    const certificate = createJourneyCertificate(directory, FIXTURE_HOSTNAME);

    const api = await runPackagedArtifact({
      artifactVersion: journey.artifactVersion,
      image: journey.apiImage,
      port: 3001,
      service: 'platform-api',
      sourceCommit: journey.sourceCommit,
    });
    t.after(() => api.stop());

    const fixture = await startUpstreamFixture({ certificate, target: api.origin });
    t.after(() => fixture.close());

    const web = await runPackagedArtifact({
      addHosts: { [FIXTURE_HOSTNAME]: HOST_GATEWAY },
      artifactVersion: journey.artifactVersion,
      env: {
        // The ordinary Node trust mechanism. Certificate verification stays on;
        // the packaged artifact is simply told about this run's private CA.
        NODE_EXTRA_CA_CERTS: '/journey-ca/journey-ca.pem',
        PLATFORM_API_ORIGIN: fixture.origin,
      },
      image: journey.webImage,
      mounts: { [directory]: '/journey-ca' },
      port: 3000,
      service: 'web',
      sourceCommit: journey.sourceCommit,
    });
    t.after(() => web.stop());

    const { browser, label } = await launchBrowser(chromium);
    t.after(() => browser.close());
    t.diagnostic(`Release journey driving ${label}.`);
    t.after(() => rmSync(directory, { force: true, recursive: true }));

    const page = await browser.newPage();

    async function load(mode) {
      fixture.setMode(mode);
      const before = fixture.observations.length;
      await page.goto(`${web.origin}/`, { waitUntil: 'domcontentloaded' });
      return fixture.observations.slice(before);
    }

    await t.test('a normal journey shows the state and the API-provided time', async () => {
      const forwarded = await load('proxy');

      assert.equal(
        forwarded.length,
        1,
        'one page render must make exactly one upstream status request',
      );
      const [observation] = forwarded;
      assert.equal(observation.status, 200);
      assert.match(observation.asOf, RFC_3339, 'the packaged API must supply an RFC 3339 time');

      // Correlation, proven where it can be proven without an exporter: the
      // packaged web artifact propagated a well-formed W3C context and a
      // bounded request identity to the packaged API artifact.
      assert.match(observation.traceparent, TRACEPARENT);
      assert.match(observation.requestId, /^[A-Za-z0-9._:-]{1,128}$/u);

      // Accessible text, not colour. The state is readable as words.
      const title = await page.locator('#status-title').innerText();
      assert.ok(
        ['Available', 'Degraded', 'Maintenance'].includes(title.trim()),
        `the page must name the platform state; it showed "${title.trim()}"`,
      );

      // The same time, not merely a time.
      const shown = await page.locator('#status-title ~ dl time').getAttribute('datetime');
      assert.equal(
        shown,
        observation.asOf,
        'the page must show the timestamp this request received from the API',
      );
      assert.equal((await page.locator('#status-title ~ dl time').innerText()).trim(), shown);
    });

    for (const [description, mode] of FAILURE_MODES) {
      await t.test(`${description} renders status unknown`, async () => {
        await load(mode);

        const title = (await page.locator('#status-title').innerText()).trim();
        assert.equal(title, 'Status unknown', `${mode} must not render a usable state`);

        // No invented available, zero-like or stale fallback: the observation
        // block is absent entirely rather than showing an old or empty time.
        assert.equal(await page.locator('#status-title ~ dl time').count(), 0);
        const body = await page.locator('main').innerText();
        for (const forbidden of ['Available', 'Degraded', 'Maintenance', '1970-01-01']) {
          assert.ok(!body.includes(forbidden), `${mode} leaked "${forbidden}" into the page`);
        }
      });
    }

    await t.test('recovery after a failure needs no redeployment', async () => {
      const forwarded = await load('proxy');
      assert.equal(forwarded.length, 1);
      const title = (await page.locator('#status-title').innerText()).trim();
      assert.ok(['Available', 'Degraded', 'Maintenance'].includes(title));
    });
  },
);
