// TEST-ONLY reachability for the positive paper-gate write path.
//
// The production factory `createPostgresPaperGateWriter` takes no availability argument,
// so no runtime caller can reach a positive admission decision through it: it fixes
// availability to `COMPILED_PAPER_BUNDLE_AVAILABLE`, which is `false`. Reaching the
// positive branch requires calling the differently named function below, from this
// module, under `src/test-support/` — a path no runtime entry point imports.
//
// That boundary is architectural, not cryptographic, and it is enforced by a test:
// `paper-gate-write.test.ts` asserts that no module outside `src/test-support/` and the
// test files imports `createPaperGateWriterCore`. If a production module ever did, that
// test fails.
//
// Nothing here changes `COMPILED_PAPER_BUNDLE_AVAILABLE`, enables paper mode, or makes
// the runtime refusal any weaker. It supplies a pure policy fixture value to a pure
// reducer parameter that already existed.

import {
  createPaperGateWriterCore,
  type PaperGateWriter,
  type PaperGateWriterTestEffects,
} from '../adapters/engine-store/postgres-paper-gate-writer.js';

/** The audited-bundle value a hosted test may supply. It is a test fixture, never a
 * claim that any bundle has actually been audited. */
export const TEST_ONLY_AUDITED_POLICY_FIXTURE = true;

export function createTestOnlyAuditedPolicyGateWriter(
  connectionString: string,
  testEffects?: PaperGateWriterTestEffects,
): PaperGateWriter {
  return createPaperGateWriterCore(connectionString, TEST_ONLY_AUDITED_POLICY_FIXTURE, testEffects);
}
