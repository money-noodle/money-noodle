import { randomUUID } from 'node:crypto';

import { readArtifactVersion } from '../../../adapters/config/read-artifact-version';
import { readPlatformApiOrigin } from '../../../adapters/platform-api/read-platform-api-origin';

export function GET() {
  try {
    readPlatformApiOrigin(process.env.PLATFORM_API_ORIGIN, process.env.NODE_ENV);
    return Response.json({
      service: 'web',
      status: 'ready',
      version: readArtifactVersion(process.env.ARTIFACT_VERSION),
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
