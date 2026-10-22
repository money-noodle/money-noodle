import { describe, expect, it } from 'vitest';
import {
  decodePaperGateSampleRows,
  type PaperGateRowScope,
} from './domain/paper-gate-row-codec.js';
import { PAPER_REGIME_SAMPLE_BUY_POLICY as policy } from './domain/paper-regime.js';
const scope: PaperGateRowScope = {
  generation_key: 'g',
  funding_id: 'f',
  epoch: 1,
  budget_id: 'actor:paper',
  generation_config_intent_id: 'C1',
  sample_policy: policy,
};
const candidate = {
  ...scope,
  candidate_key: 'candidate',
  candidate_id: 'display',
  issuance_run_id: 'issuance',
  source_kind: 'prospective-engine-run',
  symbol: 'BTC',
  venue: 'kalshi',
  contract_id: 'exact-ticker',
  side: 'UP',
  created_at_us: '0',
  closes_at_us: '900000000',
  selected_side_probability: '0.75',
  ask_price: '0.5',
  estimated_fee_rate: '0.0175',
  fee_model_version: 'historical-kalshi-continuous-taker-0.07-v1',
  predicted_net_edge: '0.2325',
  evidence_version: 'paper-regime-explicit-evidence-v1',
  qualification_receipt_id: 'qualification',
};
const outcome = {
  ...scope,
  outcome_key: 'outcome',
  candidate_key: 'candidate',
  closes_at_us: '900000000',
  contract_id: 'exact-ticker',
  side: 'UP',
  resolution_run_id: 'resolution',
  current_effect_config_intent_id: 'C2',
  source_kind: 'prospective-engine-run',
  evidence_version: 'paper-regime-explicit-evidence-v1',
  resolution_receipt_id: 'resolution-receipt',
  winner: 'UP',
  realized_edge: '0.4825',
  resolved_at_us: '900001000',
  recorded_at_us: '900001001',
};
const decode = (c: unknown = candidate, o: unknown = outcome, cutoff: unknown = '900002000') =>
  decodePaperGateSampleRows(c, o, scope, cutoff);
describe('unwired actual persisted candidate/outcome representation', () => {
  it('binds literal resolved sample, separate cause IDs and exact recorded microseconds', () => {
    expect(decode()).toEqual({
      kind: 'decoded',
      observation: {
        id: 'display',
        policyVersion: policy,
        closesAt: '1970-01-01T00:15:00.000Z',
        resolvedAt: '1970-01-01T00:15:00.001Z',
        realizedEdge: 0.4825,
      },
      candidateKey: 'candidate',
      outcomeKey: 'outcome',
      issuanceRunId: 'issuance',
      resolutionRunId: 'resolution',
      qualificationReceiptId: 'qualification',
      resolutionReceiptId: 'resolution-receipt',
      currentEffectConfigIntentId: 'C2',
      recordedAtMicroseconds: 900001001n,
    });
    const loss = decode(candidate, { ...outcome, winner: 'DOWN', realized_edge: '-0.5175' });
    expect(loss.kind).toBe('decoded');
    if (loss.kind === 'decoded') expect(loss.observation.realizedEdge).toBe(-0.5175);
  });
  it('keeps absent valid-only row unknown, never neutral or a fabricated pending/invalid sample', () => {
    expect(decode(candidate, null)).toEqual({
      kind: 'unavailable',
      reason: 'no-persisted-valid-outcome',
      candidateKey: 'candidate',
    });
    expect(decodePaperGateSampleRows(candidate, undefined, scope, '900002000')).toEqual({
      kind: 'malformed',
      reason: 'outcome',
    });
    for (const bad of [null, [], {}, false]) expect(decode(bad, null).kind).toBe('malformed');
    expect(decode(candidate, { ...outcome, winner: 'INVALID', realized_edge: '0' }).kind).toBe(
      'malformed',
    );
  });
  it('rejects wrong versions/origins/namespaces/cause bindings and coerced receipts', () => {
    for (const patch of [
      { generation_key: 'other' },
      { funding_id: 'other' },
      { epoch: 2 },
      { budget_id: 'other' },
      { generation_config_intent_id: 'C2' },
      { sample_policy: 'other' },
      { source_kind: 'restored' },
      { evidence_version: 'unknown' },
      { venue: 'polymarket' },
      { fee_model_version: 'unknown' },
      { issuance_run_id: '' },
      { qualification_receipt_id: 42 },
      { candidate_id: 'x'.repeat(257) },
      { candidate_key: ' padded ' },
      { extra: true },
    ])
      expect(decode({ ...candidate, ...patch }).kind).toBe('malformed');
    for (const patch of [
      { candidate_key: 'other' },
      { generation_key: 'other' },
      { contract_id: 'other' },
      { side: 'DOWN' },
      { closes_at_us: '1800000000' },
      { source_kind: 'ordinary-trade' },
      { evidence_version: 'unknown' },
      { resolution_receipt_id: '' },
      { resolution_run_id: null },
      { current_effect_config_intent_id: ' padded ' },
      { extra: true },
    ])
      expect(decode(candidate, { ...outcome, ...patch }).kind).toBe('malformed');
  });
  it('refuses future, causally reversed, nonfinite or millisecond-losing observation clocks', () => {
    for (const patch of [
      { created_at_us: '900000001' },
      { created_at_us: '1' },
      { closes_at_us: '900000001' },
      { closes_at_us: 'Infinity' },
      { created_at_us: 0 },
    ])
      expect(decode({ ...candidate, ...patch }).kind).toBe('malformed');
    for (const patch of [
      { resolved_at_us: '899999000' },
      { resolved_at_us: '900001001' },
      { recorded_at_us: '900000999' },
      { recorded_at_us: '900002001' },
      { recorded_at_us: 900001001 },
      { resolved_at_us: 'NaN' },
    ])
      expect(decode(candidate, { ...outcome, ...patch }).kind).toBe('malformed');
    expect(decode(candidate, outcome, '-1').kind).toBe('malformed');
    expect(decode(candidate, outcome, 'Infinity')).toEqual({ kind: 'malformed', reason: 'scope' });
    expect(
      decodePaperGateSampleRows(candidate, outcome, { ...scope, epoch: 0 }, '900002000').kind,
    ).toBe('malformed');
  });
  it('preserves source formula and rejects decimal precision loss, nonfinite and field bounds', () => {
    for (const patch of [
      { ask_price: '0' },
      { ask_price: '1' },
      { ask_price: 0.5 },
      { ask_price: '0.5000000000000000001' },
      { estimated_fee_rate: '0.0174' },
      { estimated_fee_rate: '0.0176' },
      { selected_side_probability: '1.1' },
      { selected_side_probability: 'NaN' },
      { predicted_net_edge: 'Infinity' },
      { predicted_net_edge: '-1.1' },
    ])
      expect(decode({ ...candidate, ...patch }).kind).toBe('malformed');
    for (const edge of ['0', 'NaN', 'Infinity', '0.48250000000000001', '-1.1', 0.4825])
      expect(decode(candidate, { ...outcome, realized_edge: edge }).kind).toBe('malformed');
  });
});
