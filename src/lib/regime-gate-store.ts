import 'server-only';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { BUY_POLICY_VERSION } from './prediction-policy';
import { evaluateRegimeGate, regimeGateSettings, type RegimeGateEvaluation, type RegimeGateObservation, type RegimeGatePhase } from './regime-gate-policy';
import type { PositionSide } from './types';

const DATA_DIR = path.resolve(process.cwd(), 'data');
const STORE_FILE = path.join(DATA_DIR, 'regime-gate.json');
const MAX_CANDIDATES = 5_000;
const MAX_TRANSITIONS = 500;
let storeQueue: Promise<void> = Promise.resolve();

export interface RegimeSentinelCandidate {
  id: string;
  policyVersion: string;
  symbol: string;
  contractId: string;
  side: PositionSide;
  closesAt: string;
  createdAt: string;
  selectedSideProbability: number;
  askPrice: number;
  estimatedFeeRate: number;
  predictedNetEdge: number;
  outcome?: PositionSide;
  resolvedAt?: string;
  realizedEdge?: number;
  invalidReason?: string;
}

interface RegimeGateTransition {
  at: string;
  from: RegimeGatePhase;
  to: RegimeGatePhase;
  policyVersion: string;
  reason: string;
}

interface RegimeGateStore {
  version: 1;
  phase: RegimeGatePhase;
  policyVersion: string;
  candidates: RegimeSentinelCandidate[];
  transitions: RegimeGateTransition[];
  updatedAt: string;
}

function emptyStore(): RegimeGateStore {
  return { version: 1, phase: 'warming', policyVersion: BUY_POLICY_VERSION, candidates: [], transitions: [], updatedAt: new Date().toISOString() };
}

async function readStore(): Promise<RegimeGateStore> {
  try {
    const raw = JSON.parse(await readFile(STORE_FILE, 'utf8')) as Partial<RegimeGateStore>;
    return {
      version: 1,
      phase: raw.phase ?? 'warming',
      policyVersion: raw.policyVersion ?? BUY_POLICY_VERSION,
      candidates: Array.isArray(raw.candidates) ? raw.candidates : [],
      transitions: Array.isArray(raw.transitions) ? raw.transitions : [],
      updatedAt: raw.updatedAt ?? new Date().toISOString(),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyStore();
    throw error;
  }
}

async function writeStore(store: RegimeGateStore): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true });
  const temporary = `${STORE_FILE}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  await writeFile(temporary, JSON.stringify(store, null, 2));
  await rename(temporary, STORE_FILE);
}

function observations(store: RegimeGateStore): RegimeGateObservation[] {
  return store.candidates.flatMap((candidate) => candidate.realizedEdge === undefined || !candidate.resolvedAt ? [] : [{
    id: candidate.id, policyVersion: candidate.policyVersion, closesAt: candidate.closesAt,
    resolvedAt: candidate.resolvedAt, realizedEdge: candidate.realizedEdge,
  }]);
}

async function resolveCandidate(candidate: RegimeSentinelCandidate): Promise<boolean> {
  if (candidate.resolvedAt || candidate.invalidReason || Date.parse(candidate.closesAt) > Date.now()) return false;
  const baseUrl = (process.env.KALSHI_BASE_URL ?? 'https://api.elections.kalshi.com/trade-api/v2').replace(/\/$/, '');
  const response = await fetch(`${baseUrl}/markets/${encodeURIComponent(candidate.contractId)}`, {
    signal: AbortSignal.timeout(10_000), cache: 'no-store',
  });
  if (!response.ok) return false;
  const body = await response.json() as { market?: { result?: string } };
  const result = body.market?.result?.toLowerCase();
  const outcome = result === 'yes' ? 'UP' : result === 'no' ? 'DOWN' : undefined;
  if (!outcome) return false;
  candidate.outcome = outcome;
  candidate.resolvedAt = new Date().toISOString();
  // Per-$1-payout economic result is bounded and does not let a cheap-contract capital ROI dominate.
  candidate.realizedEdge = (outcome === candidate.side ? 1 : 0) - candidate.askPrice - candidate.estimatedFeeRate;
  return true;
}

export interface RegimeGateStatus extends RegimeGateEvaluation {
  configured: ReturnType<typeof regimeGateSettings>;
  pendingWindows: number;
  latestResolvedAt?: string;
  transitions: RegimeGateTransition[];
}

function status(store: RegimeGateStore): RegimeGateStatus {
  const configured = regimeGateSettings();
  const evaluation = evaluateRegimeGate(observations(store), BUY_POLICY_VERSION, store.phase, configured);
  const currentCandidates = store.candidates.filter((candidate) => candidate.policyVersion === BUY_POLICY_VERSION);
  return {
    ...evaluation, configured,
    pendingWindows: currentCandidates.filter((candidate) => !candidate.resolvedAt && !candidate.invalidReason).length,
    latestResolvedAt: currentCandidates.filter((candidate) => candidate.resolvedAt).at(-1)?.resolvedAt,
    transitions: store.transitions.slice(-10).reverse(),
  };
}

function serialized<T>(operation: () => Promise<T>): Promise<T> {
  const result = storeQueue.then(operation);
  storeQueue = result.then(() => undefined, () => undefined);
  return result;
}

/** Resolves due sentinels, updates adaptive evidence, and records at most one candidate per settlement window. */
export function updateRegimeGate(candidate?: RegimeSentinelCandidate): Promise<RegimeGateStatus> {
  return serialized(async () => {
    const store = await readStore();
    let changed = false;
    for (const pending of store.candidates.filter((item) => !item.resolvedAt && !item.invalidReason && Date.parse(item.closesAt) <= Date.now())) {
      try { changed = await resolveCandidate(pending) || changed; }
      catch (error) { console.error(`Regime sentinel settlement failed for ${pending.id}:`, error); }
    }
    const settings = regimeGateSettings();
    if (settings.enabled && candidate && candidate.policyVersion === BUY_POLICY_VERSION
      && !store.candidates.some((item) => item.policyVersion === candidate.policyVersion && item.closesAt === candidate.closesAt)) {
      store.candidates.push(candidate);
      changed = true;
    }
    const previousPhase = store.policyVersion === BUY_POLICY_VERSION ? store.phase : 'warming';
    const evaluation = evaluateRegimeGate(observations(store), BUY_POLICY_VERSION, previousPhase, settings);
    if (evaluation.phase !== store.phase || store.policyVersion !== BUY_POLICY_VERSION) {
      store.transitions.push({
        at: new Date().toISOString(), from: store.phase, to: evaluation.phase,
        policyVersion: BUY_POLICY_VERSION, reason: evaluation.reason,
      });
      store.phase = evaluation.phase;
      store.policyVersion = BUY_POLICY_VERSION;
      changed = true;
    }
    if (changed) {
      store.candidates = store.candidates.slice(-MAX_CANDIDATES);
      store.transitions = store.transitions.slice(-MAX_TRANSITIONS);
      store.updatedAt = new Date().toISOString();
      await writeStore(store);
    }
    return status(store);
  });
}

export function getRegimeGateStatus(): Promise<RegimeGateStatus> {
  return serialized(async () => status(await readStore()));
}
