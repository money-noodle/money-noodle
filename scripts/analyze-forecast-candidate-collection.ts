/**
 * Measure: prospective Phase 2 candidate-family completeness, exact production replay, funded-provider outcome
 * coverage, and independent settlement-window milestone counts.
 * Deciding correction: UTC `closesAt` timestamps are the independent unit; repeated calculations and correlated
 * assets never increase a milestone count.
 * Main biases: this is an infrastructure/coverage audit, not an efficacy test; provider outages extend the clock,
 * missing candidate rows cannot reveal collector windows that were never observed, and no simulated execution or
 * live-fill evidence is scored here.
 */
import 'server-only';
import { summarizeForecastCandidateCollection } from '../src/lib/forecast-candidate-summary';
import { getForecastHistory } from '../src/lib/forecast-tracker';

const summary = summarizeForecastCandidateCollection(await getForecastHistory());
console.log(JSON.stringify(summary, null, 2));
