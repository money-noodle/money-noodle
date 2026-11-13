// Disposable hosted SELECT-only codec vectors; no schema/data/control/runtime edits.
import assert from 'node:assert/strict';
import process from 'node:process';
import {
  decodePaperDbMicroseconds,
  paperSourceIsoToDbMicroseconds,
  comparePaperDbTimes,
  paperDbTimeToSourceIso,
  paperSourceAtOrBeforeDbCutoff,
} from '../dist/domain/paper-time-codec.js';
export async function paperTimeCodecPostgresContract(admin) {
  assert.equal(process.env.GITHUB_ACTIONS, 'true');
  const values = [
    '2026-10-12T03:00:00.000000Z',
    '2026-10-12T03:00:00.000001Z',
    '2026-10-12T03:00:00.000002Z',
    '1969-12-31T23:59:59.999999Z',
    '1970-01-01T00:00:00.000000Z',
    'infinity',
    '-infinity',
  ];
  const rows = [];
  for (const value of values) {
    const [row] = await admin.unsafe(
      'select case when isfinite(t) then (extract(epoch from t)*1000000)::numeric(30,0)::text else null end as microseconds from (select $1::text::timestamptz as t) v',
      [value],
    );
    rows.push(row.microseconds);
  }
  assert.equal(typeof rows[0], 'string');
  const base = paperSourceIsoToDbMicroseconds('2026-10-12T03:00:00.000Z');
  assert.notEqual(base, undefined);
  assert.equal(decodePaperDbMicroseconds(rows[0]), base);
  assert.equal(decodePaperDbMicroseconds(rows[1]), base + 1n);
  assert.equal(decodePaperDbMicroseconds(rows[2]), base + 2n);
  assert.equal(comparePaperDbTimes(rows[1], rows[2]), -1);
  assert.equal(paperDbTimeToSourceIso(rows[1]), undefined);
  assert.equal(paperDbTimeToSourceIso(rows[2]), undefined);
  assert.equal(paperDbTimeToSourceIso(rows[0]), '2026-10-12T03:00:00.000Z');
  assert.equal(paperSourceAtOrBeforeDbCutoff('2026-10-12T03:00:00.000Z', rows[1]), true);
  assert.equal(paperSourceAtOrBeforeDbCutoff('2026-10-12T03:00:00.001Z', rows[2]), false);
  assert.equal(rows[3], '-1');
  assert.equal(rows[4], '0');
  for (const row of rows.slice(5)) {
    assert.equal(row, null);
    assert.equal(decodePaperDbMicroseconds(row), undefined);
  }
  // Actual persisted phase fixture clocks must remain distinct before Date decoding.
  const [stored] = await admin.unsafe(
    "select (extract(epoch from coverage_cutoff_at)*1000000)::numeric(30,0)::text as cutoff, (extract(epoch from recorded_at)*1000000)::numeric(30,0)::text as recorded from engine.paper_gate_phase_event where event_key='phase-genesis'",
  );
  assert.ok(stored);
  assert.equal(decodePaperDbMicroseconds(stored.cutoff), base + 1n);
  assert.equal(decodePaperDbMicroseconds(stored.recorded), base + 2n);
  assert.equal(comparePaperDbTimes(stored.cutoff, stored.recorded), -1);
  assert.equal(paperDbTimeToSourceIso(stored.cutoff), undefined);
  // This is not all-row lossless reapply, current DB clock/lease/control ordering,
  // source receipt truth, decimal edge fidelity or runtime authority qualification.
}
