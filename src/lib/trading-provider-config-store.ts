import 'server-only';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { productionMarketCapability } from './market-registry';
import type {
  TradingProviderAuditEvent, TradingProviderConfiguration, TradingProviderControl, TradingProviderId,
} from './types';

const DATA_DIR = path.resolve(process.cwd(), 'data');
const CONFIG_FILE = path.join(DATA_DIR, 'trading-providers.json');
const MAX_AUDIT_EVENTS = 500;
export const TRADING_PROVIDER_IDS: TradingProviderId[] = ['polymarket', 'kalshi', 'crypto-com', 'forecastex', 'robinhood'];
export const DEFAULT_PROVIDER_VARIANTS: Record<TradingProviderId, string> = {
  polymarket: 'polymarket-clob-contract-v1',
  kalshi: 'kalshi-15m-maker-v1',
  'crypto-com': 'crypto-com-event-contract-v1',
  forecastex: 'forecastex-contract-v1',
  robinhood: 'robinhood-event-contract-v1',
};
/**
 * Derived from the market registry rather than restated. A second capability table drifts from the first,
 * and the failure mode is a provider enabled here that the registry considers incapable.
 */
const CAPABILITIES: Record<TradingProviderId, { research: boolean; paper: boolean; live: boolean }> =
  Object.fromEntries(TRADING_PROVIDER_IDS.map((id) => {
    const capability = productionMarketCapability(id);
    return [id, { research: capability.marketData, paper: capability.paper, live: capability.live }];
  })) as Record<TradingProviderId, { research: boolean; paper: boolean; live: boolean }>;
let operationQueue: Promise<void> = Promise.resolve();

const snapshot = (item: TradingProviderControl) => ({
  researchEnabled: item.researchEnabled, paperEnabled: item.paperEnabled,
  liveEnabled: item.liveEnabled, selectedVariantId: item.selectedVariantId,
});

function control(providerId: TradingProviderId, updatedAt: string): TradingProviderControl {
  return {
    providerId, researchEnabled: CAPABILITIES[providerId].research,
    paperEnabled: false, liveEnabled: false,
    selectedVariantId: DEFAULT_PROVIDER_VARIANTS[providerId], updatedAt,
  };
}

function defaults(now = new Date().toISOString()): TradingProviderConfiguration {
  return {
    version: 'trading-provider-config-v1', revision: 0, updatedAt: now,
    executionAuthority: 'legacy-budget-v1', providers: TRADING_PROVIDER_IDS.map((id) => control(id, now)), audit: [],
  };
}

export function normalizeTradingProviderConfiguration(input: Partial<TradingProviderConfiguration>): TradingProviderConfiguration {
  const fallback = defaults();
  const stored = new Map((Array.isArray(input.providers) ? input.providers : []).map((item) => [item.providerId, item]));
  return {
    version: 'trading-provider-config-v1',
    revision: Number.isSafeInteger(input.revision) && Number(input.revision) >= 0 ? Number(input.revision) : 0,
    updatedAt: typeof input.updatedAt === 'string' && Number.isFinite(Date.parse(input.updatedAt)) ? input.updatedAt : fallback.updatedAt,
    executionAuthority: input.executionAuthority === 'provider-registry-v1' ? 'provider-registry-v1' : 'legacy-budget-v1',
    providers: TRADING_PROVIDER_IDS.map((providerId) => {
      const prior = stored.get(providerId), base = control(providerId, fallback.updatedAt), capability = CAPABILITIES[providerId];
      return {
        ...base,
        researchEnabled: capability.research && prior?.researchEnabled !== false,
        paperEnabled: capability.paper && prior?.paperEnabled === true,
        liveEnabled: capability.live && prior?.liveEnabled === true,
        selectedVariantId: prior?.selectedVariantId === DEFAULT_PROVIDER_VARIANTS[providerId] ? prior.selectedVariantId : DEFAULT_PROVIDER_VARIANTS[providerId],
        updatedAt: typeof prior?.updatedAt === 'string' && Number.isFinite(Date.parse(prior.updatedAt)) ? prior.updatedAt : base.updatedAt,
      };
    }),
    audit: Array.isArray(input.audit) ? input.audit.filter((item): item is TradingProviderAuditEvent => Boolean(item?.id && item?.at && item?.providerId)).slice(-MAX_AUDIT_EVENTS) : [],
  };
}

async function readStored(): Promise<TradingProviderConfiguration> {
  try {
    return normalizeTradingProviderConfiguration(JSON.parse(await readFile(CONFIG_FILE, 'utf8')) as Partial<TradingProviderConfiguration>);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return defaults();
    await rename(CONFIG_FILE, `${CONFIG_FILE}.corrupt-${Date.now()}`).catch(() => undefined);
    console.error('Trading-provider configuration was malformed and has been quarantined:', error);
    return defaults();
  }
}

async function writeStored(configuration: TradingProviderConfiguration): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true });
  const temporary = `${CONFIG_FILE}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  await writeFile(temporary, JSON.stringify(configuration, null, 2));
  await rename(temporary, CONFIG_FILE);
}

function serialized<T>(operation: () => Promise<T>): Promise<T> {
  const result = operationQueue.then(operation);
  operationQueue = result.then(() => undefined, () => undefined);
  return result;
}

/** One-time migration from the former combined Budget venue toggle. */
export function migrateLegacyVenueAuthority(
  stored: TradingProviderConfiguration,
  enabledVenues: Array<'polymarket' | 'kalshi'>,
  now = new Date().toISOString(),
): { configuration: TradingProviderConfiguration; changed: boolean } {
  if (stored.executionAuthority === 'provider-registry-v1') return { configuration: stored, changed: false };
  const providers = stored.providers.map((item) => {
    const next = {
      ...item,
      paperEnabled: (item.providerId === 'polymarket' || item.providerId === 'kalshi') && enabledVenues.includes(item.providerId),
      liveEnabled: item.providerId === 'kalshi' && enabledVenues.includes('kalshi'), updatedAt: now,
    };
    return next;
  });
  const audit = providers.flatMap((next) => {
    const previous = stored.providers.find((item) => item.providerId === next.providerId)!;
    if (JSON.stringify(snapshot(previous)) === JSON.stringify(snapshot(next))) return [];
    return [{
      id: crypto.randomUUID(), at: now, providerId: next.providerId, action: 'migrated' as const,
      reason: 'Migrated paper/live permissions from the legacy Budget venue authority.',
      previous: snapshot(previous), next: snapshot(next),
    }];
  });
  return {
    changed: true,
    configuration: {
      ...stored, executionAuthority: 'provider-registry-v1', revision: stored.revision + 1,
      updatedAt: now, providers, audit: [...stored.audit, ...audit].slice(-MAX_AUDIT_EVENTS),
    },
  };
}

export function getTradingProviderConfiguration(enabledVenues: Array<'polymarket' | 'kalshi'>): Promise<TradingProviderConfiguration> {
  return serialized(async () => {
    const stored = await readStored();
    const migrated = migrateLegacyVenueAuthority(stored, enabledVenues);
    if (migrated.changed) await writeStored(migrated.configuration);
    return migrated.configuration;
  });
}

export interface UpdateTradingProviderInput {
  providerId: TradingProviderId;
  researchEnabled?: boolean;
  paperEnabled?: boolean;
  liveEnabled?: boolean;
  selectedVariantId?: string;
  reason: string;
}

export function updateTradingProviderConfiguration(
  input: UpdateTradingProviderInput,
  legacyEnabledVenues: Array<'polymarket' | 'kalshi'>,
): Promise<TradingProviderConfiguration> {
  return serialized(async () => {
    if (!TRADING_PROVIDER_IDS.includes(input.providerId)) throw new Error('Unknown trading provider.');
    const migrated = migrateLegacyVenueAuthority(await readStored(), legacyEnabledVenues);
    const stored = migrated.configuration, capability = CAPABILITIES[input.providerId];
    const index = stored.providers.findIndex((item) => item.providerId === input.providerId);
    const previous = stored.providers[index];
    if (input.researchEnabled === true && !capability.research) throw new Error(`${input.providerId} research is unavailable until an official adapter is implemented.`);
    if (input.paperEnabled === true && !capability.paper) throw new Error(`${input.providerId} paper trading is unavailable until an official adapter is implemented.`);
    if (input.liveEnabled === true && !capability.live) throw new Error(`${input.providerId} live trading is not implemented or promoted.`);
    if (input.selectedVariantId !== undefined && input.selectedVariantId !== DEFAULT_PROVIDER_VARIANTS[input.providerId]) throw new Error(`Unknown ${input.providerId} provider variant.`);
    const now = new Date().toISOString();
    const next: TradingProviderControl = {
      ...previous,
      researchEnabled: input.researchEnabled ?? previous.researchEnabled,
      paperEnabled: input.paperEnabled ?? previous.paperEnabled,
      liveEnabled: input.liveEnabled ?? previous.liveEnabled,
      selectedVariantId: input.selectedVariantId ?? previous.selectedVariantId,
      updatedAt: now,
    };
    // No invisible execution: paper/live require the provider read path to stay visible and healthy.
    if ((next.paperEnabled || next.liveEnabled) && !next.researchEnabled) throw new Error('Disable paper and live before disabling provider research visibility.');
    if (JSON.stringify(snapshot(previous)) === JSON.stringify(snapshot(next))) return stored;
    const audit: TradingProviderAuditEvent = {
      id: crypto.randomUUID(), at: now, providerId: input.providerId, action: 'updated',
      reason: input.reason.trim() || 'Provider configuration updated by operator.',
      previous: snapshot(previous), next: snapshot(next),
    };
    const providers = [...stored.providers]; providers[index] = next;
    const updated: TradingProviderConfiguration = {
      ...stored, executionAuthority: 'provider-registry-v1', revision: stored.revision + 1,
      updatedAt: now, providers, audit: [...stored.audit, audit].slice(-MAX_AUDIT_EVENTS),
    };
    await writeStored(updated);
    return updated;
  });
}

/** Compatibility projection only; permissions remain authoritative in this provider store. */
export function legacyEnabledVenues(configuration: TradingProviderConfiguration): Array<'polymarket' | 'kalshi'> {
  return configuration.providers.flatMap((item) => {
    if (item.providerId !== 'polymarket' && item.providerId !== 'kalshi') return [];
    return item.paperEnabled || item.liveEnabled ? [item.providerId] : [];
  });
}

/** Backward-compatible Budget action: explicitly replaces both paper and historical live permission. */
export function replaceImplementedProviderPermissionsFromLegacy(input: Array<'polymarket' | 'kalshi'>): Promise<TradingProviderConfiguration> {
  return serialized(async () => {
    const migrated = migrateLegacyVenueAuthority(await readStored(), input);
    let stored = migrated.configuration;
    const now = new Date().toISOString();
    for (const providerId of ['polymarket', 'kalshi'] as const) {
      const index = stored.providers.findIndex((item) => item.providerId === providerId), previous = stored.providers[index];
      const next = { ...previous, paperEnabled: input.includes(providerId), liveEnabled: providerId === 'kalshi' && input.includes('kalshi'), updatedAt: now };
      if (JSON.stringify(snapshot(previous)) === JSON.stringify(snapshot(next))) continue;
      const audit: TradingProviderAuditEvent = {
        id: crypto.randomUUID(), at: now, providerId, action: 'updated',
        reason: 'Permissions updated through the backward-compatible Budget venue control.', previous: snapshot(previous), next: snapshot(next),
      };
      const providers = [...stored.providers]; providers[index] = next;
      stored = { ...stored, revision: stored.revision + 1, updatedAt: now, providers, audit: [...stored.audit, audit].slice(-MAX_AUDIT_EVENTS) };
    }
    await writeStored(stored);
    return stored;
  });
}

export function tradingProviderConfigurationFile(): string { return CONFIG_FILE; }
