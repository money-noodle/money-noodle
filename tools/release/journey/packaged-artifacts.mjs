// Running the packaged artifacts, exactly as built.
//
// The journey must "exercise the actual packaged web/API artifacts supplied by
// #71, without rebuilding them for promotion". So nothing here builds: it runs
// an image that already exists locally, under the same production runtime
// contract the delivery probe and the deployment inject, and waits for the
// image's own declared HEALTHCHECK verdict rather than inventing a second
// definition of healthy.

import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

/** A full source commit, so the packaged runtime contract accepts it. */
const COMMIT = /^[0-9a-f]{40}$/u;

function docker(args, { allowFailure = false } = {}) {
  const result = spawnSync('docker', args, { encoding: 'utf8' });
  if (result.status !== 0 && !allowFailure) {
    throw new Error(`docker ${args[0]} failed: ${(result.stderr || '').trim()}`);
  }
  return (result.stdout || '').trim();
}

/**
 * The journey's inputs, or `undefined` when this run is not the journey run.
 *
 * Deliberately all-or-nothing. A half-configured journey silently degrades into
 * a test that proves nothing, so an enabled journey with a missing input is a
 * failure rather than a skip.
 */
export function readJourneyEnvironment(env = process.env) {
  if (env.MONEY_NOODLE_RELEASE_JOURNEY !== '1') return undefined;

  const required = {
    apiImage: env.MONEY_NOODLE_JOURNEY_API_IMAGE,
    artifactVersion: env.MONEY_NOODLE_JOURNEY_ARTIFACT_VERSION,
    sourceCommit: env.MONEY_NOODLE_JOURNEY_COMMIT,
    webImage: env.MONEY_NOODLE_JOURNEY_WEB_IMAGE,
  };
  for (const [name, value] of Object.entries(required)) {
    if (typeof value !== 'string' || value.length === 0) {
      throw new Error(`The release journey is enabled but ${name} was not supplied.`);
    }
  }
  if (!COMMIT.test(required.sourceCommit)) {
    throw new Error('The release journey needs a full 40-character source commit.');
  }
  return Object.freeze(required);
}

/** Starts one packaged artifact and waits for its own health verdict. */
export async function runPackagedArtifact({
  addHosts = {},
  env = {},
  image,
  mounts = {},
  port,
  service,
  sourceCommit,
  artifactVersion,
}) {
  const args = [
    'run',
    '--detach',
    '--rm',
    '--env',
    'NODE_ENV=production',
    '--env',
    `MONEY_NOODLE_SERVICE=${service}`,
    '--env',
    'MONEY_NOODLE_ENVIRONMENT=production',
    '--env',
    `MONEY_NOODLE_COMMIT=${sourceCommit}`,
    '--env',
    `ARTIFACT_VERSION=${artifactVersion}`,
  ];
  for (const [name, value] of Object.entries(env)) {
    args.push('--env', `${name}=${value}`);
  }
  for (const [host, address] of Object.entries(addHosts)) {
    args.push('--add-host', `${host}:${address}`);
  }
  for (const [source, destination] of Object.entries(mounts)) {
    args.push('--volume', `${source}:${destination}:ro`);
  }
  args.push('--publish', `127.0.0.1:0:${port}`, image);

  const id = docker(args);
  try {
    await waitForHealthy(id);
    const published = docker(['port', id, `${port}/tcp`]).split('\n')[0];
    const hostPort = Number(published.slice(published.lastIndexOf(':') + 1));
    if (!Number.isInteger(hostPort) || hostPort <= 0) {
      throw new Error(`${service} published no reachable port.`);
    }
    return {
      hostPort,
      id,
      origin: `http://127.0.0.1:${hostPort}`,
      logs: () => docker(['logs', id], { allowFailure: true }),
      stop: () => {
        docker(['stop', id], { allowFailure: true });
      },
    };
  } catch (error) {
    docker(['stop', id], { allowFailure: true });
    throw error;
  }
}

/** Waits for the image's declared HEALTHCHECK, refusing an unhealthy verdict. */
export async function waitForHealthy(id, { attempts = 60, intervalMs = 2_000 } = {}) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const health = docker(['inspect', '--format', '{{.State.Health.Status}}', id], {
      allowFailure: true,
    });
    if (health === 'healthy') return;
    if (health === 'unhealthy') throw new Error('The packaged artifact reported itself unhealthy.');
    await delay(intervalMs);
  }
  throw new Error('The packaged artifact never became healthy under the production contract.');
}

/**
 * The address a container reaches the runner's own listeners on.
 *
 * `host-gateway` is Docker's documented alias for exactly that, so the fixture
 * needs no published container of its own.
 */
export const HOST_GATEWAY = 'host-gateway';

/** `docker` is present and usable. Absence is a failure, never a quiet skip. */
export function assertDockerAvailable() {
  const result = spawnSync('docker', ['version', '--format', '{{.Server.Version}}'], {
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error('The release journey needs a Docker daemon to run the packaged artifacts.');
  }
}
