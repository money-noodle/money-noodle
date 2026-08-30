import { readArtifactVersion } from '../../../adapters/config/read-artifact-version';

export function GET() {
  return Response.json({
    service: 'web',
    status: 'live',
    version: readArtifactVersion(process.env.ARTIFACT_VERSION),
  });
}
