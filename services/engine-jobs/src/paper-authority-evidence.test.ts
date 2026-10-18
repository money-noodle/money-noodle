import { describe, expect, it } from 'vitest';

import { MAX_INTENT_CLOCK_SKEW_MS } from './domain/intent.js';
import {
  PAPER_AUTHORITY_EVIDENCE_PROTOCOL,
  buildPaperAuthorityEvidence,
  paperAuthorityFenceIsValid,
  paperAuthorityScopeIsValid,
  type PaperAuthorityRawReads,
} from './domain/paper-authority-evidence.js';
import { evaluatePaperAuthority } from './domain/paper-authority.js';

const SCOPE = { capability: 'budget:paper', epoch: 7 };
const FENCE = { capability: 'budget:paper', owner: 'synthetic-owner', fencingToken: 3n };
// Independent literals, not derived from the module under test.
const LATEST_US = '1791772202000000';
const CONFIGURE_US = '1791772201000000';
const OBSERVED_US = '1791772203000000';

const config = {
  paper_config_version: 1,
  budget_id: 'synthetic:paper',
  funding_id: 'synthetic-funding',
  total_cap_cents: 1000,
  entry_cap_cents: 200,
  kalshi_cap_cents: 500,
  polymarket_cap_cents: 0,
  kalshi_market_percent: 100,
  polymarket_market_percent: 0,
  paper_providers: 'kalshi',
  market_id: 'crypto-15m',
  policy_bundle: 'paper-v1-blend04-neutral-v7',
};

const configureRow = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  action: 'configure',
  actor: 'synthetic',
  capability: 'budget:paper',
  epoch_text: '7',
  id: 'C1',
  parameters: config,
  recorded_at_us: CONFIGURE_US,
  time_valid: true,
  ...over,
});

const latestRow = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  action: 'resume',
  actor: 'synthetic',
  capability: 'budget:paper',
  epoch_text: '7',
  id: 'R1',
  parameters: { paper_config_version: 1, config_intent_id: 'C1' },
  recorded_at_us: LATEST_US,
  time_valid: true,
  ...over,
});

const fundingRow = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  available_cents: '700',
  birth_bound: true,
  birth_intent_bound: true,
  budget_id: 'synthetic:paper',
  correction_cents: '0',
  epoch_text: '7',
  funding_id: 'synthetic-funding',
  identity_holds: true,
  other_epoch_root_exists: false,
  realized_cents: '0',
  reserved_cents: '300',
  revision: '4',
  revision_valid: true,
  starting_cents: '1000',
  ...over,
});

const raw = (over: Partial<PaperAuthorityRawReads> = {}): PaperAuthorityRawReads => ({
  configure: configureRow(),
  funding: fundingRow(),
  latest: latestRow(),
  leaseHeld: true,
  leaseStillHeld: true,
  observedAtMicroseconds: OBSERVED_US,
  ordering: {
    configure_at_or_before_latest: true,
    configure_after_reset: true,
    newest_reset_id: null,
  },
  ...over,
});

const read = (over: Partial<PaperAuthorityRawReads> = {}) =>
  buildPaperAuthorityEvidence(raw(over), SCOPE, FENCE);

const evidenceOf = (over: Partial<PaperAuthorityRawReads> = {}) => {
  const result = read(over);
  if (result.kind !== 'read') throw new Error('expected a read, got ' + result.reason);
  return result.evidence;
};

describe('paper authority scope and fence predicates', () => {
  it('rejects malformed scope and fence before anything else', () => {
    expect(paperAuthorityScopeIsValid(SCOPE)).toBe(true);
    for (const bad of [
      { capability: '', epoch: 7 },
      { capability: ' budget:paper', epoch: 7 },
      { capability: 'budget:paper', epoch: 0 },
      { capability: 'budget:paper', epoch: 1.5 },
      { capability: 'budget:paper', epoch: 2_147_483_648 },
    ])
      expect(paperAuthorityScopeIsValid(bad as never)).toBe(false);
    expect(paperAuthorityFenceIsValid(FENCE)).toBe(true);
    for (const bad of [
      { capability: 'budget:paper', owner: '', fencingToken: 3n },
      { capability: '', owner: 'o', fencingToken: 3n },
      { capability: 'budget:paper', owner: 'o', fencingToken: 0n },
      { capability: 'budget:paper', owner: 'o', fencingToken: 3 },
    ])
      expect(paperAuthorityFenceIsValid(bad as never)).toBe(false);
  });

  it('refuses scope, fence and capability mismatch without inspecting rows', () => {
    expect(
      buildPaperAuthorityEvidence(raw(), { capability: 'budget:paper', epoch: 0 }, FENCE),
    ).toEqual({ detail: 'scope', kind: 'refused', reason: 'scope' });
    expect(buildPaperAuthorityEvidence(raw(), SCOPE, { ...FENCE, fencingToken: 0n })).toEqual({
      detail: 'fence',
      kind: 'refused',
      reason: 'scope',
    });
    expect(
      buildPaperAuthorityEvidence(raw(), { capability: 'budget:other', epoch: 7 }, FENCE),
    ).toEqual({ detail: 'capability-mismatch', kind: 'refused', reason: 'scope' });
  });
});

describe('paper authority fence refusals', () => {
  it('refuses the start and the final boundary with no evidence at all', () => {
    expect(read({ leaseHeld: false })).toEqual({
      detail: 'start-boundary',
      kind: 'refused',
      reason: 'lease-not-held',
    });
    expect(read({ leaseStillHeld: false })).toEqual({
      detail: 'final-boundary',
      kind: 'refused',
      reason: 'lease-lost',
    });
  });
});

describe('paper authority evidence assembly', () => {
  it('states its own lifetime and reuses the approved clock-skew allowance', () => {
    const evidence = evidenceOf();
    expect(evidence.protocol).toBe(PAPER_AUTHORITY_EVIDENCE_PROTOCOL);
    expect(evidence.validity).toBe('single-transaction-snapshot-only');
    expect(evidence.lifetime).toBe('historical-read-evidence-after-commit');
    expect(evidence.admission).toBe('none');
    expect(evidence.clockSkewAllowanceMs).toBe(MAX_INTENT_CLOCK_SKEW_MS);
    expect(evidence.observedAtMicroseconds).toBe(BigInt(OBSERVED_US));
    expect(evidence.latestRecordedAtMicroseconds).toBe(BigInt(LATEST_US));
    expect(evidence.configureRecordedAtMicroseconds).toBe(BigInt(CONFIGURE_US));
  });

  it('refuses bundle-unavailable on an otherwise valid snapshot, by default', () => {
    const evidence = evidenceOf();
    expect(evidence.snapshot.complete).toBe(true);
    expect(evidence.snapshot.funding?.conserved).toBe(true);
    // The production path never gets a bundle override: the only refusal left is the
    // unavailable bundle.
    expect(evidence.decisionUnderProductionBundle).toEqual({
      allowed: false,
      reason: 'bundle-unavailable',
    });
    // The pure reducer with a known-audited fixture is the positive path, and it is
    // reached only by a caller that supplies the flag itself.
    expect(evaluatePaperAuthority(evidence.snapshot, true)).toEqual({
      allowed: true,
      config,
      configIntentId: 'C1',
      latestIntentId: 'R1',
    });
  });

  it('treats a missing standing intent as complete but unauthorised', () => {
    const evidence = evidenceOf({ configure: null, latest: null, funding: null, ordering: null });
    expect(evidence.snapshot.complete).toBe(true);
    expect(evidence.snapshot.latest).toBeUndefined();
    expect(evidence.decisionUnderProductionBundle).toEqual({
      allowed: false,
      reason: 'latest-authority-invalid',
    });
  });

  it('keeps a malformed newest row instead of falling back to an older one', () => {
    // A non-finite `recorded_at` arrives as a null microsecond text, which is what the
    // adapter emits rather than letting the numeric cast raise.
    const evidence = evidenceOf({ latest: latestRow({ recorded_at_us: null, time_valid: false }) });
    expect(evidence.snapshot.complete).toBe(false);
    expect(evidence.snapshot.latest).toBeUndefined();
    expect(evidence.snapshot.latestTimeValid).toBe(false);
    expect(evidence.decisionUnderProductionBundle).toEqual({
      allowed: false,
      reason: 'latest-authority-invalid',
    });
  });

  it('marks a snapshot incomplete when a representation is unrecognisable', () => {
    for (const over of [
      { latest: latestRow({ action: 'not-an-action' }) },
      { latest: latestRow({ epoch_text: '0' }) },
      { latest: latestRow({ capability: 'budget:other' }) },
      { latest: latestRow({ time_valid: 'true' }) },
      { latest: latestRow({ id: '' }) },
      { configure: configureRow({ recorded_at_us: 'x' }) },
      { observedAtMicroseconds: null },
      { funding: fundingRow({ identity_holds: null }) },
      { ordering: { configure_at_or_before_latest: 1, configure_after_reset: true } },
    ])
      expect(evidenceOf(over as Partial<PaperAuthorityRawReads>).snapshot.complete).toBe(false);
  });

  it('owes an ordering comparison whenever both rows were recognised', () => {
    const evidence = evidenceOf({ ordering: null });
    expect(evidence.snapshot.complete).toBe(false);
    expect(evidence.snapshot.configureAtOrBeforeLatest).toBe(false);
    expect(evidence.snapshot.configureAfterReset).toBe(false);
  });

  it('passes the server ordering and reset verdicts through unchanged', () => {
    const after = evidenceOf({
      ordering: {
        configure_after_reset: false,
        configure_at_or_before_latest: true,
        newest_reset_id: 'RESET-9',
      },
    });
    expect(after.snapshot.configureAfterReset).toBe(false);
    expect(after.newestResetIntentId).toBe('RESET-9');
    expect(after.decisionUnderProductionBundle).toEqual({
      allowed: false,
      reason: 'configure-authority-invalid',
    });
    const notBefore = evidenceOf({
      ordering: {
        configure_after_reset: true,
        configure_at_or_before_latest: false,
        newest_reset_id: null,
      },
    });
    expect(notBefore.snapshot.configureAtOrBeforeLatest).toBe(false);
    expect(notBefore.decisionUnderProductionBundle).toEqual({
      allowed: false,
      reason: 'configure-authority-invalid',
    });
  });

  it('requires every funding sub-fact, and reports identity from the rows', () => {
    const evidence = evidenceOf();
    expect(evidence.snapshot.funding).toEqual({
      budgetId: 'synthetic:paper',
      conserved: true,
      epoch: 7,
      id: 'synthetic-funding',
    });
    expect(evidence.fundingFacts?.availableCents).toBe('700');
    expect(evidence.fundingFacts?.otherEpochRootExists).toBe(false);
    for (const key of [
      'identity_holds',
      'revision_valid',
      'birth_bound',
      'birth_intent_bound',
    ] as const) {
      const broken = evidenceOf({ funding: fundingRow({ [key]: false }) });
      expect(broken.snapshot.funding?.conserved).toBe(false);
      expect(broken.decisionUnderProductionBundle).toEqual({
        allowed: false,
        reason: 'funding-invalid',
      });
    }
    // Audit-only: a root at another epoch does not by itself change the verdict.
    expect(
      evidenceOf({ funding: fundingRow({ other_epoch_root_exists: true }) }).snapshot.funding
        ?.conserved,
    ).toBe(true);
  });

  it('refuses when no funding root pair was found, without inventing one', () => {
    const evidence = evidenceOf({ funding: null });
    expect(evidence.snapshot.funding).toBeUndefined();
    expect(evidence.fundingFacts).toBeUndefined();
    expect(evidence.snapshot.complete).toBe(true);
    expect(evidence.decisionUnderProductionBundle).toEqual({
      allowed: false,
      reason: 'funding-invalid',
    });
  });

  it('refuses a paused standing intent and a stale global epoch', () => {
    expect(
      evidenceOf({ latest: latestRow({ action: 'pause', id: 'P1' }) })
        .decisionUnderProductionBundle,
    ).toEqual({ allowed: false, reason: 'paused' });
    // The standing intent is read globally, so a newer epoch is visible here and is
    // refused rather than filtered away.
    expect(
      evidenceOf({ latest: latestRow({ epoch_text: '8', id: 'R2' }) })
        .decisionUnderProductionBundle,
    ).toEqual({ allowed: false, reason: 'latest-authority-invalid' });
  });

  it('refuses a resume whose reference does not name the configure row', () => {
    expect(
      evidenceOf({
        latest: latestRow({ parameters: { paper_config_version: 1, config_intent_id: 'OTHER' } }),
      }).decisionUnderProductionBundle,
    ).toEqual({ allowed: false, reason: 'resume-reference-invalid' });
  });

  it('refuses a malformed newest configure rather than an older valid one', () => {
    const evidence = evidenceOf({
      configure: configureRow({ parameters: { ...config, extra_field: 1 } }),
    });
    expect(evidence.snapshot.complete).toBe(true);
    expect(evidence.decisionUnderProductionBundle).toEqual({
      allowed: false,
      reason: 'configuration-invalid',
    });
  });
});
