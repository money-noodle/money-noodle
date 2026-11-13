// PRODUCTION admission gate. This file ships in `dist` and in the runtime image.
//
// There is NO audited-policy token in the shipped artifact: `AUDITED_POLICY_ADMISSION`
// is `undefined` here, so `grantsAuditedPolicy` can never return `true`, whatever a
// caller passes — including the genuine fixture token imported from the separate
// test-support artifact. The boundary is the ABSENCE of a token from this build, not a
// name, an environment flag or an import convention.
//
// The test-support build replaces this one file with its own implementation, whose
// token is the fixture symbol, and compiles the SAME adapter source into a separate
// artifact that `.dockerignore` and the Dockerfile exclude. One real adapter, two
// artifacts, no duplicated core and no hand-written SQL surrogate.

/** No token exists in the shipped artifact. */
export const AUDITED_POLICY_ADMISSION: symbol | undefined = undefined;

/** Whether `admission` is the audited-policy token of THIS artifact. In production the
 * answer is always `false`, because there is no token to be. */
export function grantsAuditedPolicy(admission: unknown): boolean {
  return AUDITED_POLICY_ADMISSION !== undefined && admission === AUDITED_POLICY_ADMISSION;
}
