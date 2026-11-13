// The identity-bound audited-policy FIXTURE, physically absent from the production
// artifact: `tsconfig.build.json` excludes `src/test-support/**`, so this module is not
// in `dist` and not in the runtime image.
//
// It is a unique symbol, so admission is bound to this module's identity. A forged
// object, a string, or another `Symbol('paper-gate-audited-policy-fixture')` minted
// anywhere else is a different value and is refused. It is a TEST FIXTURE, never a
// claim that any policy bundle has actually been audited.

export const AUDITED_POLICY_FIXTURE: symbol = Symbol('paper-gate-audited-policy-fixture');
