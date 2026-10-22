// SELECT-only disposable hosted transport oracles, NOT economic/source parity.
import assert from 'node:assert/strict';
import process from 'node:process';
import {
  decodePaperExactDecimal,
  comparePaperExactDecimals,
  encodePaperSourceBinary64,
  decodePaperSourceBinary64,
} from '../dist/domain/paper-decimal-codec.js';
export async function paperDecimalCodecPostgresContract(admin) {
  assert.equal(process.env.GITHUB_ACTIONS, 'true');
  const literals = [
    '0',
    '0.1',
    '0.30000000000000004',
    '7.000000000000001',
    '6.25',
    '2.5',
    '-0.99',
    '0.10000000000000000001',
    '2000000000000',
    '-2000000000000',
    '0.' + '0'.repeat(323) + '5',
  ];
  for (const literal of literals) {
    const [row] = await admin.unsafe('select ($1::text::numeric)::text as exact', [literal]);
    assert.equal(typeof row.exact, 'string');
    assert.equal(row.exact, literal);
    assert.notEqual(decodePaperExactDecimal(row.exact), undefined);
    if (literal === '0.10000000000000000001') {
      assert.equal(decodePaperSourceBinary64(row.exact), undefined);
    } else {
      const source = decodePaperSourceBinary64(row.exact);
      assert.notEqual(source, undefined);
      assert.equal(encodePaperSourceBinary64(source), literal);
    }
  }
  const [oracle] = await admin.unsafe(
    'select (0.1::numeric + 0.2::numeric)::text as exact_sum, (0.10000000000000000001::numeric > 0.1::numeric) as distinct, (6.25::numeric < 7::numeric) as raw_not_reserved',
  );
  assert.equal(oracle.exact_sum, '0.3');
  assert.equal(encodePaperSourceBinary64(0.1 + 0.2), '0.30000000000000004');
  assert.equal(oracle.distinct, true);
  assert.equal(comparePaperExactDecimals('0.10000000000000000001', '0.1'), 1);
  assert.equal(oracle.raw_not_reserved, true);
  assert.equal(comparePaperExactDecimals('6.25', '7'), -1);
  // PostgreSQL preserves display scale. Raw noncanonical TEXT is refused rather
  // than accepting it by Number coercion or silently rewriting provenance.
  for (const literal of [
    '1.00',
    '0.10',
    'NaN',
    'Infinity',
    '-Infinity',
    '2000000000000.0000000000000001',
    '0.' + '0'.repeat(324) + '1',
  ]) {
    const [row] = await admin.unsafe('select ($1::text::numeric)::text as exact', [literal]);
    assert.equal(decodePaperExactDecimal(row.exact), undefined);
    assert.equal(decodePaperSourceBinary64(row.exact), undefined);
  }
  // No store rows/DDL/grants, producer receipts, cause/window coverage, field
  // conservation, all-row snapshots, current authority or atomicity proven here.
}
