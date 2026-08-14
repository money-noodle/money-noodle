// One-time: collapse duplicated venue-contract copies in the forecast history to registry references.
//
// Every field on a row's venueContracts was verified present and identical in the provenance registry
// beforehand, apart from capturedAt, which is per-observation and is kept. A reference the registry
// cannot resolve keeps its full copy. Backs up first and refuses to write unless a full round-trip
// through the registry reproduces the original rows exactly.
//
// Run: node --max-old-space-size=6144 scripts/migrate-forecast-provenance.mjs [--apply]
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const historyFile = path.join(root, 'data/forecast-history.json');
const apply = process.argv.includes('--apply');

const registry = JSON.parse(fs.readFileSync(path.join(root, 'data/contract-provenance.json'), 'utf8'));
const byId = new Map(registry.records.map((record) => [record.registryId, record]));
const rows = JSON.parse(fs.readFileSync(historyFile, 'utf8'));

const slimRef = (ref) => byId.has(ref?.registryId) ? { registryId: ref.registryId, capturedAt: ref.capturedAt } : ref;
const rehydrateRef = (ref) => {
  const record = byId.get(ref?.registryId);
  if (!record || ref?.contractId !== undefined) return ref;
  return { ...record, capturedAt: ref.capturedAt ?? record.capturedAt };
};
const mapContracts = (row, fn) => row.venueContracts
  ? { ...row, venueContracts: Object.fromEntries(Object.entries(row.venueContracts).map(([venue, ref]) => [venue, fn(ref)])) }
  : row;

const slim = rows.map((row) => mapContracts(row, slimRef));

// The migration is only safe if expanding the slim form reproduces the original byte for byte.
let mismatched = 0;
for (let index = 0; index < rows.length; index += 1) {
  if (JSON.stringify(mapContracts(slim[index], rehydrateRef)) !== JSON.stringify(rows[index])) mismatched += 1;
}

const before = fs.statSync(historyFile).size;
const after = Buffer.byteLength(JSON.stringify(slim));
const kept = slim.filter((row) => Object.values(row.venueContracts ?? {}).some((ref) => ref?.contractId !== undefined)).length;

console.log(`rows                ${rows.length}`);
console.log(`round-trip failures ${mismatched}`);
console.log(`unresolved kept     ${kept}`);
console.log(`size                ${(before / 1048576).toFixed(1)} MB -> ${(after / 1048576).toFixed(1)} MB (${(100 - (after / before) * 100).toFixed(1)}% smaller)`);

if (mismatched) {
  console.error('\nRefusing to write: the slim form does not round-trip back to the original.');
  process.exit(1);
}
if (!apply) {
  console.log('\nDry run. Re-run with --apply to back up and write.');
  process.exit(0);
}

const backup = path.join(root, `../money-forecast-history-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
fs.copyFileSync(historyFile, backup);
const temporary = `${historyFile}.migrate.tmp`;
fs.writeFileSync(temporary, JSON.stringify(slim));
fs.renameSync(temporary, historyFile);
console.log(`\nBacked up to ${backup}`);
console.log(`Wrote ${historyFile}`);
