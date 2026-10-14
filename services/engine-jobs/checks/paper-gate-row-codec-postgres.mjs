// Read actual disposable persisted fixtures; no source collection or receipt truth.
import assert from 'node:assert/strict';
import process from 'node:process';
import { decodePaperGateSampleRows } from '../dist/domain/paper-gate-row-codec.js';
export async function paperGateRowCodecPostgresContract(admin) {
  assert.equal(process.env.GITHUB_ACTIONS, 'true');
  const [stored] = await admin.unsafe(
    "select (to_jsonb(c)-'created_at'-'closes_at') || jsonb_build_object('created_at_us',(extract(epoch from c.created_at)*1000000)::numeric(30,0)::text,'closes_at_us',(extract(epoch from c.closes_at)*1000000)::numeric(30,0)::text,'selected_side_probability',c.selected_side_probability::text,'ask_price',c.ask_price::text,'estimated_fee_rate',c.estimated_fee_rate::text,'predicted_net_edge',c.predicted_net_edge::text) as candidate, (to_jsonb(o)-'closes_at'-'resolved_at'-'recorded_at') || jsonb_build_object('closes_at_us',(extract(epoch from o.closes_at)*1000000)::numeric(30,0)::text,'resolved_at_us',(extract(epoch from o.resolved_at)*1000000)::numeric(30,0)::text,'recorded_at_us',(extract(epoch from o.recorded_at)*1000000)::numeric(30,0)::text,'realized_edge',o.realized_edge::text) as outcome, (extract(epoch from o.recorded_at)*1000000)::numeric(30,0)::text as cutoff from engine.paper_gate_candidate c join engine.paper_gate_outcome o on o.candidate_key=c.candidate_key where c.generation_key='gate-generation' and c.side='UP'",
  );
  assert.ok(stored);
  const c = stored.candidate,
    o = stored.outcome;
  const scope = Object.fromEntries(
    [
      'generation_key',
      'funding_id',
      'epoch',
      'budget_id',
      'generation_config_intent_id',
      'sample_policy',
    ].map((k) => [k, c[k]]),
  );
  const result = decodePaperGateSampleRows(c, o, scope, stored.cutoff);
  assert.equal(result.kind, 'decoded');
  assert.equal(result.observation.realizedEdge, 0.4825);
  assert.equal(result.observation.closesAt, '2026-10-12T02:15:00.000Z');
  assert.equal(result.observation.resolvedAt, '2026-10-12T02:15:01.000Z');
  assert.equal(result.currentEffectConfigIntentId, 'root-other-config');
  assert.equal(result.qualificationReceiptId, 'synthetic-not-qualified');
  assert.equal(result.recordedAtMicroseconds, BigInt(stored.cutoff));
  assert.equal(decodePaperGateSampleRows(c, null, scope, stored.cutoff).kind, 'unavailable');
  for (const patch of [
    { contract_id: 'foreign' },
    { resolution_receipt_id: '' },
    { evidence_version: 'unknown' },
    { realized_edge: '0.48250000000000001' },
    { resolved_at_us: stored.cutoff + '1' },
    { recorded_at_us: (BigInt(stored.cutoff) + 1n).toString() },
  ])
    assert.equal(
      decodePaperGateSampleRows(c, { ...o, ...patch }, scope, stored.cutoff).kind,
      'malformed',
    );
  // Synthetic receipt ID remains explicitly NOT qualified; FK/read/decoder cannot
  // prove source/model/path/quote truth, attempts, complete history or authority.
}
