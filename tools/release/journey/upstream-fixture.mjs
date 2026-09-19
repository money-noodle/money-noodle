// The CI-only upstream fixture the release journey runs against.
//
// The accepted test layout requires "a CI-only upstream fixture [covering]
// timeout, transport failure, malformed responses and incompatible schemas. No
// production failure-control endpoint or application test switch." So the
// packaged web artifact is shipped and configured exactly as production ships
// it, and the failure is injected between it and the API — here.
//
// The fixture is also the recorder. "Verify accessible state and the same
// API-provided timestamp received by the web, not timestamps from unrelated
// requests" only means something if the value compared against the page is the
// value this exact request carried, so the proxy remembers what it forwarded.
//
// Two things this deliberately is not: it is not reachable from a deployed
// runtime, and it holds no credential. It terminates TLS with a certificate
// minted for this run and discarded with the temporary directory.

import { spawnSync } from 'node:child_process';
import { createServer } from 'node:https';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** How the fixture answers the packaged web artifact's next request. */
export const FIXTURE_MODES = Object.freeze([
  'proxy',
  'timeout',
  'reset',
  'malformed',
  'incompatible',
]);

/** The hostname the certificate is minted for. Never a real, resolvable name. */
export const FIXTURE_HOSTNAME = 'platform-api.test';

function openssl(args, input) {
  const result = spawnSync('openssl', args, { encoding: 'utf8', input });
  if (result.status !== 0) {
    throw new Error(`openssl ${args[0]} failed: ${result.stderr.trim()}`);
  }
  return result;
}

/**
 * Mints a throwaway CA and a leaf for `hostname`.
 *
 * A private CA, rather than a self-signed leaf, because the packaged artifact
 * trusts it through `NODE_EXTRA_CA_CERTS` — the ordinary Node mechanism, not an
 * application flag, and certainly not a disabled verification.
 */
export function createJourneyCertificate(directory, hostname = FIXTURE_HOSTNAME) {
  const caKey = join(directory, 'journey-ca.key');
  const caCertificate = join(directory, 'journey-ca.pem');
  const key = join(directory, 'journey-upstream.key');
  const certificate = join(directory, 'journey-upstream.pem');
  const request = join(directory, 'journey-upstream.csr');
  const extensions = join(directory, 'journey-upstream.ext');

  openssl([
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-days',
    '2',
    '-subj',
    '/CN=money-noodle-journey-ca',
    '-addext',
    'basicConstraints=critical,CA:TRUE',
    '-keyout',
    caKey,
    '-out',
    caCertificate,
  ]);
  openssl([
    'req',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-subj',
    `/CN=${hostname}`,
    '-keyout',
    key,
    '-out',
    request,
  ]);
  writeFileSync(extensions, `subjectAltName=DNS:${hostname}\nbasicConstraints=CA:FALSE\n`);
  openssl([
    'x509',
    '-req',
    '-in',
    request,
    '-CA',
    caCertificate,
    '-CAkey',
    caKey,
    '-CAcreateserial',
    '-days',
    '2',
    '-extfile',
    extensions,
    '-out',
    certificate,
  ]);

  return { caCertificate, certificate, hostname, key };
}

/**
 * Starts the fixture in front of the packaged API artifact.
 *
 * `target` is the packaged API's own origin. In `proxy` mode the fixture adds
 * nothing to the response: the state and the timestamp the page shows are the
 * ones the real artifact produced.
 */
export async function startUpstreamFixture({ target, certificate }) {
  const sockets = new Set();
  const observations = [];
  let mode = 'proxy';
  let pending = new Set();

  const server = createServer(
    {
      cert: readFileSync(certificate.certificate),
      key: readFileSync(certificate.key),
    },
    (request, response) => {
      if (mode === 'reset') {
        request.socket.destroy();
        return;
      }
      if (mode === 'timeout') {
        // Accepted, never answered. The packaged artifact's own 1500 ms request
        // deadline is what ends this, which is the behaviour under test.
        pending.add(response);
        return;
      }
      if (mode === 'malformed') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end('{"state": "avail');
        return;
      }
      if (mode === 'incompatible') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({
            asOf: new Date().toISOString(),
            requestId: 'journey-incompatible',
            // A schema version this client was not built against. Well-formed
            // JSON that the web must still refuse.
            schemaVersion: '2',
            service: { name: 'platform-api', version: 'journey' },
            state: 'available',
          }),
        );
        return;
      }

      void forward(request, response);
    },
  );

  async function forward(request, response) {
    const headers = {};
    for (const name of ['traceparent', 'x-request-id', 'accept']) {
      const value = request.headers[name];
      if (typeof value === 'string') headers[name] = value;
    }

    let upstream;
    try {
      upstream = await fetch(new URL(request.url, target), { headers });
    } catch {
      response.writeHead(502, { 'content-type': 'application/problem+json' });
      response.end('{"title":"upstream unreachable"}');
      return;
    }

    const body = await upstream.text();
    let asOf;
    try {
      asOf = JSON.parse(body).asOf;
    } catch {
      asOf = undefined;
    }
    observations.push({
      asOf,
      path: request.url,
      requestId: headers['x-request-id'],
      status: upstream.status,
      traceparent: headers.traceparent,
    });

    response.writeHead(upstream.status, {
      'content-type': upstream.headers.get('content-type') ?? 'application/json',
    });
    response.end(body);
  }

  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '0.0.0.0', resolve);
  });

  const { port } = server.address();

  return {
    /** Every status response the fixture forwarded, oldest first. */
    observations,
    /** The origin the packaged web artifact is configured with. */
    origin: `https://${certificate.hostname}:${port}`,
    port,
    /** The most recent status observation the packaged web artifact received. */
    lastObservation() {
      return observations.at(-1);
    },
    setMode(next) {
      if (!FIXTURE_MODES.includes(next)) throw new Error(`Unknown fixture mode: ${next}`);
      mode = next;
    },
    async close() {
      for (const response of pending) response.destroy();
      pending = new Set();
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
