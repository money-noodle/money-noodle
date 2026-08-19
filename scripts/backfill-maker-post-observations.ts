/**
 * RETIRED HISTORICAL MIGRATION — no package command invokes this file. Existing backfilled observations
 * remain readable; the completed persistence sentinel and permissive source must not be mutated again.
 *
 * One-day backfill of observed fills onto sentinel intents, from the 60-second depth experiment.
 *
 *   npm run backfill:maker-posts -- --dry-run
 *   npm run backfill:maker-posts
 *
 * **This is the coarser method and it is labelled as such.** It is stamped `depth-experiment-60s` and the
 * report never pools it with live 2-second observation. Three differences, all making it weaker rather
 * than wrong, per docs/maker-post-observation-design.md §7:
 *
 *   - 60-second samples against a 12-second horizon, so the reprice ladder cannot be resolved. **Only the
 *     static arm is scored**; the ladder is recorded `unobserved`. One sample is taken, the first after
 *     the intent, and its prints already cover up to 60 seconds — so every fill here is an **upper
 *     bound**, not a fill rate comparable to live observation.
 *   - `tradedVolumeByPrice` has already discarded `takerSide`, so a trade that lifted an ask counts as if
 *     it had hit our bid. It will fill slightly too often.
 *   - Queue ahead comes from the sample preceding the intent, up to 60 seconds stale, not from a snapshot
 *     taken at post time. A sample stores displayed size only at **its own** bid, not the whole book, so
 *     an intent whose bid has moved since that sample cannot be scored at the price production would
 *     actually have posted at. Those are skipped rather than posted at the stale price: the first draft
 *     of this script used the sample's bid and simulated a DOWN post at 64c that the desk would have
 *     placed at 56c, which fills far too easily and inflated the fill rate.
 *
 * It exists because the live cohort starts at zero and this covers roughly a hundred v19 intents that
 * would otherwise never be observed at all. It is a bridge, not the measurement.
 *
 * Write-once: an intent that already carries an observation is skipped, so this can never overwrite a
 * live observation and re-running it is a no-op.
 */
import { readFile } from 'node:fs/promises';
import { createReadStream, existsSync } from 'node:fs';
import readline from 'node:readline';
import path from 'node:path';
import { applySample, decodeSample, openPost, type MakerDepthSample } from '../lib/maker-depth-experiment';
import { MAKER_POST_OBSERVATION_VERSION } from '../lib/maker-post-observation';
import { recordMakerPostObservations, type MakerPostObservationRecord } from '../lib/persistence-candidate-store';
import type { PersistenceCandidateIntent } from '../lib/types';

function refuseRetiredRun(): void {
  throw new Error('Retired: the completed persistence sentinel and permissive 60-second backfill are read-only.');
}
refuseRetiredRun();

const DATA = path.resolve(process.cwd(), 'data');
const SAMPLES = path.join(DATA, 'maker-depth-experiment.jsonl');
const STORE = path.join(DATA, 'persistence-candidate.json');
const dryRun = process.argv.includes('--dry-run');

async function loadSamples(): Promise<Map<string, MakerDepthSample[]>> {
  const byKey = new Map<string, MakerDepthSample[]>();
  if (!existsSync(SAMPLES)) return byKey;
  const stream = readline.createInterface({ input: createReadStream(SAMPLES) });
  for await (const line of stream) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try { parsed = JSON.parse(line); } catch { continue; }
    const sample = decodeSample(parsed);
    if (!sample) continue;
    const key = `${sample.contractId}|${sample.side}`;
    byKey.set(key, [...(byKey.get(key) ?? []), sample]);
  }
  for (const list of byKey.values()) list.sort((a, b) => Date.parse(a.observedAt) - Date.parse(b.observedAt));
  return byKey;
}

const samples = await loadSamples();
const store = JSON.parse(await readFile(STORE, 'utf8')) as { intents: PersistenceCandidateIntent[] };

/**
 * Undo path for backfilled observations only, so a defect in this script is corrected by re-running it
 * rather than by hand-editing an evidence store. It never touches a `live-2s` observation.
 */
if (process.argv.includes('--reset-backfill')) {
  const stale = store.intents.filter((intent) => intent.makerObservationSource === 'depth-experiment-60s');
  console.log(`clearing ${stale.length} backfilled observations; live observations are untouched`);
  if (!dryRun) {
    const { clearBackfilledMakerPostObservations } = await import('../lib/persistence-candidate-store');
    console.log(`cleared ${await clearBackfilledMakerPostObservations()}`);
  }
  process.exit(0);
}

const observations: MakerPostObservationRecord[] = [];
let alreadyObserved = 0;
let noCoverage = 0;
let noSampleAfter = 0;
let quoteMoved = 0;

for (const intent of store.intents) {
  if (intent.makerObservationModel) { alreadyObserved += 1; continue; }
  const list = samples.get(`${intent.contractId}|${intent.side}`);
  if (!list?.length) { noCoverage += 1; continue; }
  const postedAtMs = Date.parse(intent.createdAt);
  if (!Number.isFinite(postedAtMs)) { noCoverage += 1; continue; }

  // Queue ahead from the last sample at or before the intent: the closest thing this data has to a
  // snapshot at post time. A sample after the intent would read a book the decision never saw.
  const priorSample = [...list].reverse().find((sample) => Date.parse(sample.observedAt) <= postedAtMs);
  // Exactly one sample, the first after the intent. Its prints are cumulative since the sample before,
  // so it already covers up to 60 seconds against a 12-second horizon — an upper bound on fills, and the
  // tightest this data supports. Taking every sample through the horizon compounded that to over two
  // minutes of volume and put the fill rate at 88%, which is an artefact of the window, not a finding.
  const nextSample = list.find((sample) => Date.parse(sample.observedAt) > postedAtMs);
  if (!priorSample || !nextSample) { noSampleAfter += 1; continue; }
  if (priorSample.displayedAheadCents === undefined) { noSampleAfter += 1; continue; }

  // Production posts at the bid it saw when it decided. The sample records displayed size only at its
  // own bid, so unless the two agree there is no queue depth for the price that would actually have been
  // posted, and the intent is skipped rather than scored at a price the desk never chose.
  const postCents = Math.round(intent.bidPrice * 100);
  if (Math.abs(intent.bidPrice * 100 - postCents) > 1e-8 || postCents !== priorSample.bidCents) { quoteMoved += 1; continue; }

  // The static arm only: a 60-second sampler cannot resolve six 2-second rungs.
  const state = applySample(openPost(postCents, priorSample.displayedAheadCents), nextSample);

  observations.push({
    id: intent.id,
    makerObservationModel: MAKER_POST_OBSERVATION_VERSION,
    makerObservationSource: 'depth-experiment-60s',
    makerPostCents: postCents,
    makerQueueAheadCents: priorSample.displayedAheadCents,
    makerLadderFill: 'unobserved',
    makerStaticFill: state.filled ? 'filled' : 'unfilled',
    makerStaticFillCents: postCents,
  });
}

const filled = observations.filter((observation) => observation.makerStaticFill === 'filled').length;
console.log(`intents in store        ${store.intents.length}`);
console.log(`already observed        ${alreadyObserved}`);
console.log(`no depth coverage       ${noCoverage}`);
console.log(`no usable sample pair   ${noSampleAfter}`);
console.log(`quote moved since sample ${quoteMoved}`);
console.log(`backfillable            ${observations.length}  (static arm filled ${filled}, unfilled ${observations.length - filled})`);
console.log(`ladder arm              unobserved for all of them, by construction`);
console.log('Fills here are an upper bound: one 60-second print window against a 12-second horizon, with');
console.log('taker direction already discarded. Never pooled with live-2s observation.');

if (dryRun) {
  console.log('\n--dry-run: nothing written.');
} else {
  const applied = await recordMakerPostObservations(observations);
  console.log(`\nwritten to the store    ${applied}`);
}
