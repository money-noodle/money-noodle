// The TEST-SUPPORT admission gate. The `build-test-support` target copies this file over
// `src/adapters/engine-store/paper-gate-audited-policy-gate.ts` in a throwaway source
// tree and compiles that tree into `dist-test-support`, which the production build never
// produces and the runtime image never copies.
//
// It is the ONLY implementation in which an audited-policy token exists, and the token is
// the fixture symbol itself, so the positive path is bound to that module's identity.

// Relative to where this file is COMPILED FROM, which is
// `.test-support-src/adapters/engine-store/paper-gate-audited-policy-gate.ts`, not to
// where it is stored. It is therefore excluded from the main tsconfig and typechecked by
// the `build-test-support` compile that places it.
import { AUDITED_POLICY_FIXTURE } from '../../test-support/paper-gate-audited-policy-fixture.js';

export const AUDITED_POLICY_ADMISSION: symbol | undefined = AUDITED_POLICY_FIXTURE;

export function grantsAuditedPolicy(admission: unknown): boolean {
  return AUDITED_POLICY_ADMISSION !== undefined && admission === AUDITED_POLICY_ADMISSION;
}
