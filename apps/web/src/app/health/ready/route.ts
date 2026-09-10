import { randomUUID } from 'node:crypto';

import { readRuntimeConfig } from '../../../adapters/config/read-runtime-config';

export function GET() {
  try {
    const { service } = readRuntimeConfig(process.env);
    return Response.json({
      service: service.name,
      status: 'ready',
      version: service.version,
    });
  } catch {
    const requestId = randomUUID();
    return Response.json(
      {
        errorCode: 'MN-WEB-NOT-READY',
        requestId,
        status: 503,
        title: 'Service Unavailable',
        type: 'https://errors.noodle.money/mn-web-not-ready',
      },
      {
        headers: { 'content-type': 'application/problem+json', 'x-request-id': requestId },
        status: 503,
      },
    );
  }
}
