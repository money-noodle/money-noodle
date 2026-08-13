import 'server-only';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DEFAULT_ALLOCATION, allocationsValid } from './provider-budget-policy';
import { TRADING_PROVIDER_IDS } from './trading-provider-config-store';
import type { MarketAllocation, ProviderBudget, ProviderBudgetConfiguration, TradingProviderId } from './types';

const DATA_DIR = path.resolve(process.cwd(), 'data');
const CONFIG_FILE = path.join(DATA_DIR, 'provider-budgets.json');

let operationQueue: Promise<void> = Promise.resolve();

/**
 * Ceilings only, deliberately not a second cash ledger. Cash accounting stays single-source in the
 * legacy control and the paper ledger: two ledgers of the same money drift, and the drift shows up as a
 * reservation that one of them thinks is affordable. Splitting cash per provider waits until a second
 * live provider is funded and each balance can be reconciled against real venue cash.
 */
function budget(providerId: TradingProviderId, updatedAt: string, allocations: MarketAllocation[] = DEFAULT_ALLOCATION): ProviderBudget {
  return { providerId, liveLimitCents: 0, paperLimitCents: 0, allocations: allocations.map((item) => ({ ...item })), updatedAt };
}

function defaults(now = new Date().toISOString()): ProviderBudgetConfiguration {
  return {
    version: 'provider-budget-v1', revision: 0, updatedAt: now,
    providers: TRADING_PROVIDER_IDS.map((id) => budget(id, now)),
  };
}

/**
 * Every provider is present after normalization, and a malformed allocation falls back to the default
 * rather than being repaired arithmetically — a partially trusted allocation is how a hard cap silently
 * becomes larger than the operator set.
 */
export function normalizeProviderBudgets(input: Partial<ProviderBudgetConfiguration>): ProviderBudgetConfiguration {
  const now = new Date().toISOString();
  const stored = new Map((Array.isArray(input.providers) ? input.providers : []).map((item) => [item?.providerId, item]));
  return {
    version: 'provider-budget-v1',
    revision: Number.isSafeInteger(input.revision) && (input.revision as number) >= 0 ? input.revision as number : 0,
    updatedAt: typeof input.updatedAt === 'string' ? input.updatedAt : now,
    seededFrom: typeof input.seededFrom === 'string' ? input.seededFrom : undefined,
    providers: TRADING_PROVIDER_IDS.map((id) => {
      const item = stored.get(id);
      if (!item) return budget(id, now);
      const allocations = Array.isArray(item.allocations) && allocationsValid(item.allocations)
        ? item.allocations.map((entry) => ({ marketId: entry.marketId, percent: entry.percent }))
        : DEFAULT_ALLOCATION.map((entry) => ({ ...entry }));
      const cents = (value: unknown) => Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : 0;
      return {
        providerId: id,
        liveLimitCents: cents(item.liveLimitCents),
        paperLimitCents: cents(item.paperLimitCents),
        allocations,
        updatedAt: typeof item.updatedAt === 'string' ? item.updatedAt : now,
      };
    }),
  };
}

async function persist(configuration: ProviderBudgetConfiguration): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true });
  const temporary = `${CONFIG_FILE}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  await writeFile(temporary, JSON.stringify(configuration, null, 2));
  await rename(temporary, CONFIG_FILE);
}

/**
 * Seeded on first read from the legacy control rather than by rewriting it. The legacy budget stays
 * authoritative for cash, so a bad seed costs a ceiling and not the ledger.
 */
export async function getProviderBudgets(seed?: { revision: number }): Promise<ProviderBudgetConfiguration> {
  try {
    const raw = JSON.parse(await readFile(CONFIG_FILE, 'utf8')) as Partial<ProviderBudgetConfiguration>;
    return normalizeProviderBudgets(raw);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const now = new Date().toISOString();
  const seeded = defaults(now);
  if (seed) {
    // Seeded with no provider ceiling on purpose, which reproduces current behaviour exactly. Seeding
    // the original funded amount instead would cap a provider at what it started with, so realized
    // gains could never be deployed — the legacy working budget grows with P&L. A ceiling is something
    // the operator sets deliberately, not something a migration infers.
    seeded.seededFrom = `legacy-budget-revision-${seed.revision}`;
  }
  const created = { ...seeded, revision: 1, updatedAt: now };
  await persist(created);
  return created;
}

/** Serialized so two concurrent edits cannot interleave a read-modify-write over the same file. */
export async function updateProviderBudget(
  providerId: TradingProviderId,
  changes: { liveLimitCents?: number; paperLimitCents?: number; allocations?: MarketAllocation[] },
): Promise<ProviderBudgetConfiguration> {
  const run = operationQueue.then(async () => {
    const current = await getProviderBudgets();
    if (changes.allocations && !allocationsValid(changes.allocations)) {
      throw new Error('Market allocations must be non-negative, unique per market, and sum to at most 100%.');
    }
    for (const key of ['liveLimitCents', 'paperLimitCents'] as const) {
      const value = changes[key];
      if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
        throw new Error(`${key} must be a whole number of cents, zero meaning no provider-specific ceiling.`);
      }
    }
    const now = new Date().toISOString();
    const next: ProviderBudgetConfiguration = {
      ...current,
      revision: current.revision + 1,
      updatedAt: now,
      providers: current.providers.map((item) => item.providerId === providerId
        ? {
          ...item,
          liveLimitCents: changes.liveLimitCents ?? item.liveLimitCents,
          paperLimitCents: changes.paperLimitCents ?? item.paperLimitCents,
          allocations: changes.allocations?.map((entry) => ({ ...entry })) ?? item.allocations,
          updatedAt: now,
        }
        : item),
    };
    await persist(next);
    return next;
  });
  operationQueue = run.then(() => undefined, () => undefined);
  return run;
}

export function providerBudget(configuration: ProviderBudgetConfiguration, providerId: TradingProviderId): ProviderBudget | undefined {
  return configuration.providers.find((item) => item.providerId === providerId);
}
