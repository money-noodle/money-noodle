import { describe, expect, it } from 'vitest';

import { createCheckIdentityReadiness } from './check-identity-readiness.js';

describe('identity readiness', () => {
  it('is ready when the revision has everything the signed-in surface needs', () => {
    expect(
      createCheckIdentityReadiness({ configured: () => true, readyWithoutIdentity: false })(),
    ).toEqual({ ready: true, state: 'ready' });
  });

  it('fails closed when configuration is missing and the surface is depended upon', () => {
    expect(
      createCheckIdentityReadiness({ configured: () => false, readyWithoutIdentity: false })(),
    ).toEqual({ ready: false, state: 'not-configured' });
  });

  it('still reports the missing configuration while the surface is not yet depended upon', () => {
    // This is the interval before the maintainer has entered the values: the
    // public dashboard is the whole of what the revision promises, so it serves —
    // but the state is still `not-configured`, because saying "ready" and meaning
    // "ready for less" is how a half-configured revision goes unnoticed.
    expect(
      createCheckIdentityReadiness({ configured: () => false, readyWithoutIdentity: true })(),
    ).toEqual({ ready: true, state: 'not-configured' });
  });
});
