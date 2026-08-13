import 'server-only';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { getAccounts } from './accounts';
import { mayAutoResumeAfterReconciliation, systemSuspensionFields } from './automation-resume-policy';
import { DEFAULT_MAX_PURCHASE_PERCENT, MIN_PURCHASE_PERCENT, normalizeEnabledVenues, proposedStakeCents, reconcileBudgetReservations, releaseBudget, reserveBudget, settleBudget, workingEquityCents } from './budget-ledger';
import { liveBlockers, liveTradingEnabled, maxLiveStakeCents } from './live-orders';
import { getExecutionDrainStatus } from './execution-drain-state';
import { liveRiskLimits } from './live-risk-policy';
import { getLiveRiskStatus } from './live-risk-store';
import { getKalshiReconciliationStatus } from './reconciliation-state';
import {
  getTradingProviderConfiguration, legacyEnabledVenues, replaceImplementedProviderPermissionsFromLegacy,
} from './trading-provider-config-store';
import { tradingProviderRegistry } from './trading-provider-registry';
import type { BudgetAuditEvent, BudgetControl, LiveRiskStatus, TradingControlData, TradingVenueReadiness } from './types';

const DATA_DIR = path.resolve(process.cwd(), 'data');
const CONTROL_FILE = path.join(DATA_DIR, 'trading-control.json');
let controlQueue: Promise<void> = Promise.resolve();

interface StoredTradingControl {
  control: BudgetControl;
  audit: BudgetAuditEvent[];
}

function defaultControl(): BudgetControl {
  return {
    revision: 0, state: 'unconfigured', mode: 'paper', startingBudgetCents: 0,
    availableBudgetCents: 0, reservedBudgetCents: 0, realizedPnlCents: 0,
    perTradeCents: 0, purchasePercent: 1, enabledVenues: ['polymarket', 'kalshi'],
    operatorIntent: 'paused', pauseOrigin: 'configuration', autoResumeEligible: false,
    pauseReason: 'Budget has not been configured', updatedAt: new Date().toISOString(),
  };
}

async function readStored(): Promise<StoredTradingControl> {
  try {
    const stored = JSON.parse(await readFile(CONTROL_FILE, 'utf8')) as StoredTradingControl;
    // Migrate percentage-era records in memory. The next write persists the explicit all-in amount.
    if (!(stored.control.perTradeCents > 0)) {
      stored.control.perTradeCents = Math.max(1, Math.floor(workingEquityCents(stored.control) * (stored.control.purchasePercent || 1) / 100));
    }
    // Historical paused states are deliberately treated as operator pauses. Never infer permission
    // to resume from legacy free-form reason text.
    if (!stored.control.operatorIntent) {
      stored.control.operatorIntent = stored.control.state === 'active' ? 'active' : 'paused';
      stored.control.pauseOrigin = stored.control.state === 'active' ? undefined : 'user';
      stored.control.autoResumeEligible = false;
    }
    return stored; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { control: defaultControl(), audit: [] };
    throw error;
  }
}

async function writeStored(stored: StoredTradingControl): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true });
  const temporary = `${CONTROL_FILE}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  await writeFile(temporary, JSON.stringify(stored, null, 2));
  await rename(temporary, CONTROL_FILE);
}

function maximumPurchasePercent(): number {
  const configured = Number(process.env.MONEY_NOODLE_MAX_PURCHASE_PERCENT ?? DEFAULT_MAX_PURCHASE_PERCENT);
  return Number.isFinite(configured) ? Math.min(100, Math.max(MIN_PURCHASE_PERCENT, configured)) : DEFAULT_MAX_PURCHASE_PERCENT;
}

function event(control: BudgetControl, input: Omit<BudgetAuditEvent, 'id' | 'timestamp' | 'revision'>): BudgetAuditEvent {
  return { id: crypto.randomUUID(), timestamp: new Date().toISOString(), revision: control.revision, ...input };
}

async function readiness(stored: StoredTradingControl): Promise<TradingControlData> {
  const providerConfiguration = await getTradingProviderConfiguration(stored.control.enabledVenues);
  const tradingProviders = tradingProviderRegistry(providerConfiguration);
  const enabledVenues = legacyEnabledVenues(providerConfiguration);
  const accounts = await getAccounts();
  // Execution readiness stays restricted to the two trading venues on purpose. Accounts are read for
  // every configured provider, but a provider without a crypto-15m execution path must never appear as
  // a venue the engine could arm — read access is not trading capability.
  const venues: TradingVenueReadiness[] = accounts.venues
    .filter((account): account is typeof account & { venue: 'polymarket' | 'kalshi' } => account.venue === 'polymarket' || account.venue === 'kalshi')
    .map((account) => {
    const balanceCents = account.balance === undefined ? undefined : Math.max(0, Math.round(account.balance * 100));
    const authenticated = Boolean(account.tradeAuthenticated && account.configured && account.connected && balanceCents !== undefined);
    const funded = authenticated && (balanceCents ?? 0) > 0;
    return {
      venue: account.venue, environment: account.environment, enabled: enabledVenues.includes(account.venue),
      configured: account.configured, connected: account.connected,
      tradeReady: funded, balanceCents,
      reason: funded ? 'Authenticated account and cash balance available'
        : authenticated ? 'Authenticated account connected, but no available cash was reported'
        : account.venue === 'polymarket' && account.connected ? 'Public wallet connected; configure private CLOB signing credentials and collateral balance checks'
        : account.error ?? 'Account connector is not configured or connected',
    };
  });
  const requiredProviderIds = new Set(tradingProviders.filter((provider) => stored.control.mode === 'live' ? provider.liveEnabled : provider.paperEnabled).map((provider) => provider.id));
  const enabled = venues.filter((venue) => requiredProviderIds.has(venue.venue));
  const totalUsableBalanceCents = enabled.filter((venue) => venue.tradeReady).reduce((sum, venue) => sum + (venue.balanceCents ?? 0), 0);
  const kalshi = enabled.find((venue) => venue.venue === 'kalshi');
  // Live orders can only go to Kalshi. Compare spendable ledger cash to venue cash; reserved stakes
  // have already left cash and must not be counted a second time.
  const fundingCovered = kalshi
    ? Boolean(kalshi.tradeReady && (kalshi.balanceCents ?? 0) >= stored.control.availableBudgetCents)
    : totalUsableBalanceCents >= stored.control.availableBudgetCents;
  // Paper execution always runs. Live execution additionally requires the environment opt-in.
  const executionEngineReady = stored.control.mode === 'paper' || liveTradingEnabled();
  const blockers: string[] = [];
  if (stored.control.state === 'unconfigured') blockers.push('Configure a positive working budget.');
  if (stored.control.state !== 'unconfigured' && workingEquityCents(stored.control) <= 0) blockers.push('Working budget is depleted.');
  if (proposedStakeCents(stored.control) <= 0 && stored.control.state !== 'unconfigured') blockers.push('The all-in per-purchase amount produces a zero-cent allocation.');
  if (!enabled.length) blockers.push(`Enable at least one ${stored.control.mode} trading provider.`);
  if (enabled.length && !enabled.some((venue) => venue.tradeReady)) blockers.push(`None of the ${stored.control.mode}-enabled providers currently has a trade-ready connector.`);
  if (!fundingCovered) blockers.push(`Signed Kalshi available cash does not cover the uncommitted live budget ($${(stored.control.availableBudgetCents / 100).toFixed(2)}).`);
  if (!executionEngineReady) blockers.push(`Live execution unavailable: ${liveBlockers().join(' ')}`);
  const reconciliation = getKalshiReconciliationStatus();
  if (stored.control.mode === 'live' && reconciliation.phase !== 'ready') blockers.push(`Kalshi reconciliation ${reconciliation.phase}: ${reconciliation.reason}`);
  let liveRisk: LiveRiskStatus;
  try {
    liveRisk = await getLiveRiskStatus(stored.control);
  } catch (error) {
    const limits = liveRiskLimits(stored.control.startingBudgetCents);
    const reason = `Live risk evidence is unavailable: ${error instanceof Error ? error.message : 'unknown ledger error'}`;
    liveRisk = {
      ...limits, allowed: false, currentEpochDrawdownCents: 0,
      lifetimeRealizedPnlCents: 0, lifetimeLossCents: 0, reasons: [reason],
    };
  }
  if (stored.control.mode === 'live' && !liveRisk.allowed) blockers.push(...liveRisk.reasons);
  const drain = getExecutionDrainStatus();
  const executionDrain = stored.control.state === 'active'
    ? { ...drain, phase: drain.workingTransactions > 0 ? drain.phase : 'active' as const, reason: drain.workingTransactions > 0 ? drain.reason : 'Automation is active; request Pause to establish a restart-safe quiescent point.', restartSafe: false }
    : drain;
  return {
    control: { ...stored.control, enabledVenues },
    tradingProviders,
    workingEquityCents: workingEquityCents(stored.control),
    proposedStakeCents: proposedStakeCents(stored.control),
    maximumPurchasePercent: maximumPurchasePercent(), maximumLiveStakeCents: maxLiveStakeCents(), totalUsableBalanceCents,
    fundingCovered, executionEngineReady, canResume: blockers.length === 0,
    blockers, venues, recentAudit: stored.audit.slice(-20).reverse(), reconciliation, executionDrain,
    liveAvailable: liveTradingEnabled(), liveBlockers: liveBlockers(), liveRisk,
  };
}

function serialized<T>(operation: () => Promise<T>): Promise<T> {
  const result = controlQueue.then(operation);
  controlQueue = result.then(() => undefined, () => undefined);
  return result;
}

export function getEnabledTradingVenues(): Promise<Array<'polymarket' | 'kalshi'>> {
  return serialized(async () => {
    const stored = await readStored();
    return legacyEnabledVenues(await getTradingProviderConfiguration(stored.control.enabledVenues));
  });
}

export function getTradingControl(): Promise<TradingControlData> {
  return serialized(async () => readiness(await readStored()));
}

/** The smallest all-in purchase that can clear a 1c contract plus the 1c minimum venue fee. */
export const MIN_PER_TRADE_CENTS = 2;

export function configureTradingBudget(input: { budgetDollars: number; perTradeDollars: number; enabledVenues: Array<'polymarket' | 'kalshi'> }): Promise<TradingControlData> {
  return serialized(async () => {
    const stored = await readStored();
    if (stored.control.state === 'active') throw new Error('Pause automation before changing its budget.');
    if (stored.control.reservedBudgetCents > 0) throw new Error('Cannot reset budget while trade funds are reserved.');
    const budgetCents = Math.round(input.budgetDollars * 100);
    if (!Number.isSafeInteger(budgetCents) || budgetCents <= 0) throw new Error('Total budget must be a positive dollar amount.');
    const perTradeCents = Math.round(input.perTradeDollars * 100);
    if (!Number.isSafeInteger(perTradeCents) || perTradeCents < MIN_PER_TRADE_CENTS) throw new Error(`Per-purchase spend must be at least ${MIN_PER_TRADE_CENTS} cents so a contract plus fees can fit.`);
    if (perTradeCents > budgetCents) throw new Error('Per-purchase spend cannot exceed the total budget.');
    // Provider permissions are authoritative and must not be recombined when only budget values change.
    const providerConfiguration = await getTradingProviderConfiguration(stored.control.enabledVenues);
    const enabledVenues = legacyEnabledVenues(providerConfiguration);
    if (!enabledVenues.length) throw new Error('Enable at least one provider for paper or live before configuring a budget.');
    if (providerConfiguration.providers.find((item) => item.providerId === 'kalshi')?.liveEnabled) {
      const accounts = await getAccounts();
      const kalshi = accounts.venues.find((account) => account.venue === 'kalshi');
      const kalshiBalanceCents = kalshi?.balance === undefined ? undefined : Math.max(0, Math.round(kalshi.balance * 100));
      if (!kalshi?.tradeAuthenticated || !kalshi.connected || kalshiBalanceCents === undefined) throw new Error('Cannot verify the total budget because the signed Kalshi balance is unavailable.');
      if (budgetCents > kalshiBalanceCents) throw new Error(`Total budget $${input.budgetDollars.toFixed(2)} exceeds available Kalshi cash $${(kalshiBalanceCents / 100).toFixed(2)}.`);
    }
    const previousState = stored.control.state;
    const now = new Date().toISOString();
    stored.control = {
      ...stored.control, revision: stored.control.revision + 1, state: 'paused', mode: 'paper',
      startingBudgetCents: budgetCents, availableBudgetCents: budgetCents, reservedBudgetCents: 0,
      realizedPnlCents: 0, perTradeCents, purchasePercent: stored.control.purchasePercent, enabledVenues,
      operatorIntent: 'paused', pauseOrigin: 'configuration', autoResumeEligible: false,
      pauseReason: 'Configured; explicit resume and trade-ready connectors required',
      createdAt: stored.control.createdAt ?? now, updatedAt: now,
    };
    stored.audit.push(event(stored.control, { type: 'configured', reason: `Budget $${input.budgetDollars.toFixed(2)} total, $${input.perTradeDollars.toFixed(2)} all-in per purchase on ${enabledVenues.join(' + ')}`, previousState, newState: 'paused', amountCents: budgetCents }));
    await writeStored(stored);
    return readiness(stored);
  });
}

export function syncLegacyVenuesFromProviderRegistry(input: Array<'polymarket' | 'kalshi'>): Promise<void> {
  return serialized(async () => {
    const stored = await readStored();
    const enabledVenues = normalizeEnabledVenues(input);
    if (JSON.stringify(stored.control.enabledVenues) === JSON.stringify(enabledVenues)) return;
    stored.control = { ...stored.control, revision: stored.control.revision + 1, enabledVenues, updatedAt: new Date().toISOString() };
    stored.audit.push(event(stored.control, {
      type: 'venues_updated', reason: `Compatibility venue projection synchronized from authoritative provider registry: ${enabledVenues.join(' + ') || 'none'}.`,
      previousState: stored.control.state, newState: stored.control.state,
    }));
    await writeStored(stored);
  });
}

/** Backward-compatible combined toggle. New UI uses the independent provider-registry route. */
export function setEnabledTradingVenues(input: Array<'polymarket' | 'kalshi'>): Promise<TradingControlData> {
  return serialized(async () => {
    const stored = await readStored();
    if (stored.control.state === 'active') throw new Error('Pause automation before changing enabled venues.');
    const enabledVenues = normalizeEnabledVenues(input);
    if (!enabledVenues.length) throw new Error('Enable at least one trading venue.');
    await replaceImplementedProviderPermissionsFromLegacy(enabledVenues);
    const previous = stored.control.enabledVenues.join(' + ') || 'none';
    stored.control = { ...stored.control, revision: stored.control.revision + 1, enabledVenues, updatedAt: new Date().toISOString() };
    stored.audit.push(event(stored.control, { type: 'venues_updated', reason: `Enabled venues changed from ${previous} to ${enabledVenues.join(' + ')}`, previousState: stored.control.state, newState: stored.control.state }));
    await writeStored(stored);
    return readiness(stored);
  });
}

/**
 * Switches between simulated and real execution. Requires a typed confirmation so live money can
 * never be armed by a stray click, and refuses while positions are open or automation is running.
 */
export function setTradingMode(mode: 'paper' | 'live', confirmation?: string): Promise<TradingControlData> {
  return serialized(async () => {
    const stored = await readStored();
    if (stored.control.state === 'active') throw new Error('Pause automation before changing execution mode.');
    if (stored.control.reservedBudgetCents > 0) throw new Error('Cannot change execution mode while trade funds are reserved.');
    if (mode === 'live') {
      const unavailable = liveBlockers();
      if (unavailable.length) throw new Error(unavailable.join(' '));
      if (confirmation !== 'TRADE LIVE') throw new Error('Type TRADE LIVE exactly to arm real-money execution.');
    }
    const previousState = stored.control.state;
    stored.control = { ...stored.control, revision: stored.control.revision + 1, mode,
      operatorIntent: 'paused', pauseOrigin: 'configuration', autoResumeEligible: false,
      pauseReason: `Execution mode set to ${mode}`, updatedAt: new Date().toISOString() };
    stored.audit.push(event(stored.control, { type: 'venues_updated', reason: `Execution mode changed to ${mode}`, previousState, newState: stored.control.state }));
    await writeStored(stored);
    return readiness(stored);
  });
}

export function pauseTrading(reason = 'Paused by user'): Promise<TradingControlData> {
  return serialized(async () => {
    const stored = await readStored();
    const previousState = stored.control.state;
    if (previousState !== 'unconfigured' && previousState !== 'depleted') {
      stored.control = { ...stored.control, revision: stored.control.revision + 1, state: 'paused',
        operatorIntent: 'paused', pauseOrigin: 'user', autoResumeEligible: false,
        pauseReason: reason, updatedAt: new Date().toISOString() };
      stored.audit.push(event(stored.control, { type: 'paused', reason, previousState, newState: 'paused' }));
      await writeStored(stored);
    }
    return readiness(stored);
  });
}

/** Economic risk stops withdraw active intent and cannot be cleared by reconciliation/auto-resume. */
export function stopTradingForLiveRisk(reason: string): Promise<TradingControlData> {
  return serialized(async () => {
    const stored = await readStored();
    const previousState = stored.control.state;
    if (previousState !== 'unconfigured' && previousState !== 'depleted') {
      stored.control = {
        ...stored.control, revision: stored.control.revision + 1, state: 'paused',
        operatorIntent: 'paused', pauseOrigin: 'system', autoResumeEligible: false,
        pauseReason: reason, updatedAt: new Date().toISOString(),
      };
      stored.audit.push(event(stored.control, { type: 'risk_stopped', reason, previousState, newState: 'paused' }));
      await writeStored(stored);
    }
    return readiness(stored);
  });
}

/** System safety stop that preserves an already-active operator intent for guarded recovery. */
export function suspendTrading(reason: string): Promise<TradingControlData> {
  return serialized(async () => {
    const stored = await readStored();
    const previousState = stored.control.state;
    if (previousState !== 'unconfigured' && previousState !== 'depleted') {
      stored.control = {
        ...stored.control, ...systemSuspensionFields(stored.control), revision: stored.control.revision + 1,
        pauseReason: reason, updatedAt: new Date().toISOString(),
      };
      stored.audit.push(event(stored.control, { type: 'paused', reason: `System suspension: ${reason}`, previousState, newState: 'paused' }));
      await writeStored(stored);
    }
    return readiness(stored);
  });
}

export function resumeTrading(): Promise<TradingControlData> {
  return serialized(async () => {
    const stored = await readStored();
    const status = await readiness(stored);
    if (!status.canResume) {
      stored.audit.push(event(stored.control, { type: 'rejected', reason: `Resume blocked: ${status.blockers.join(' ')}`, previousState: stored.control.state, newState: stored.control.state }));
      await writeStored(stored);
      throw new Error(status.blockers.join(' '));
    }
    const previousState = stored.control.state;
    stored.control = { ...stored.control, revision: stored.control.revision + 1, state: 'active',
      operatorIntent: 'active', pauseOrigin: undefined, autoResumeEligible: false,
      pauseReason: undefined, updatedAt: new Date().toISOString() };
    stored.audit.push(event(stored.control, { type: 'resumed', reason: 'All funding, connector, and execution checks passed', previousState, newState: 'active' }));
    await writeStored(stored);
    return readiness(stored);
  });
}

/** Guarded recovery after authoritative reconciliation; manual/configuration pauses are immutable here. */
export function autoResumeTradingAfterReconciliation(): Promise<TradingControlData> {
  return serialized(async () => {
    const stored = await readStored();
    const status = await readiness(stored);
    if (!mayAutoResumeAfterReconciliation(stored.control, status.canResume)) return status;
    const previousState = stored.control.state;
    stored.control = {
      ...stored.control, revision: stored.control.revision + 1, state: 'active',
      pauseReason: undefined, pauseOrigin: undefined, autoResumeEligible: false,
      updatedAt: new Date().toISOString(),
    };
    stored.audit.push(event(stored.control, {
      type: 'resumed', reason: 'Automatically resumed after authoritative reconciliation and all normal readiness checks passed.',
      previousState, newState: 'active',
    }));
    await writeStored(stored);
    return readiness(stored);
  });
}

// Internal execution-engine hooks. No public order route calls these yet.
export function reserveTradingBudget(amountCents: number, venue: 'polymarket' | 'kalshi', relatedId: string): Promise<BudgetControl> {
  return serialized(async () => {
    const stored = await readStored();
    const previousState = stored.control.state;
    if (stored.audit.some((entry) => entry.type === 'reserved' && entry.relatedId === relatedId)) return stored.control;
    const providers = tradingProviderRegistry(await getTradingProviderConfiguration(stored.control.enabledVenues));
    if (!providers.find((provider) => provider.id === venue)?.liveEnabled) throw new Error(`${venue} is disabled for live automated trading.`);
    const status = await readiness(stored);
    const selectedVenue = status.venues.find((item) => item.venue === venue);
    if (!selectedVenue?.tradeReady) throw new Error(`${venue} is not currently trade ready.`);
    if ((selectedVenue.balanceCents ?? 0) < amountCents) throw new Error(`${venue} does not have enough available cash for this reservation.`);
    stored.control = reserveBudget(stored.control, amountCents);
    stored.audit.push(event(stored.control, { type: 'reserved', reason: 'Trade stake reserved', previousState, newState: stored.control.state, amountCents, venue, relatedId }));
    await writeStored(stored);
    return stored.control;
  });
}

/** Releases an IOC remainder or fee reserve without recording artificial P&L. */
export function releaseTradingBudget(amountCents: number, venue: 'polymarket' | 'kalshi', relatedId: string): Promise<BudgetControl> {
  return serialized(async () => {
    const stored = await readStored();
    if (amountCents <= 0) return stored.control;
    stored.control = releaseBudget(stored.control, amountCents);
    stored.audit.push(event(stored.control, { type: 'released', reason: 'Unused order principal and fee reserve released', previousState: stored.control.state, newState: stored.control.state, amountCents, venue, relatedId }));
    await writeStored(stored);
    return stored.control;
  });
}

export function settleTradingBudget(stakeCents: number, payoutCents: number, venue: 'polymarket' | 'kalshi', relatedId: string): Promise<BudgetControl> {
  return serialized(async () => {
    const stored = await readStored();
    const previousState = stored.control.state;
    if (stored.audit.some((entry) => (entry.type === 'settled' || entry.type === 'depleted') && entry.relatedId === relatedId)) return stored.control;
    stored.control = settleBudget(stored.control, stakeCents, payoutCents);
    if (stored.control.state === 'depleted') stored.control = {
      ...stored.control, operatorIntent: 'paused', pauseOrigin: 'configuration', autoResumeEligible: false,
    };
    stored.audit.push(event(stored.control, { type: stored.control.state === 'depleted' ? 'depleted' : 'settled', reason: stored.control.state === 'depleted' ? 'Settlement depleted working budget' : 'Trade settled', previousState, newState: stored.control.state, amountCents: stakeCents, payoutCents, venue, relatedId }));
    await writeStored(stored);
    return stored.control;
  });
}

/** Aligns whole-cent local reservations to reconciled open exposure without recognizing artificial P&L. */
export function reconcileTradingBudget(input: { targetReservedCents: number; venueBalanceCents: number; reason: string; auditUnchanged?: boolean }): Promise<BudgetControl> {
  return serialized(async () => {
    const stored = await readStored();
    const previousState = stored.control.state;
    try {
      const before = stored.control;
      stored.control = reconcileBudgetReservations(stored.control, input.targetReservedCents, input.venueBalanceCents);
      const reservationChanged = before.availableBudgetCents !== stored.control.availableBudgetCents || before.reservedBudgetCents !== stored.control.reservedBudgetCents;
      if (!reservationChanged && input.auditUnchanged === false) return before;
      if (stored.control.state === 'paused' && stored.control.pauseOrigin === 'system' && stored.control.autoResumeEligible) {
        stored.control.pauseReason = 'The uncertain Kalshi transaction was authoritatively reconciled; guarded auto-resume is checking all normal readiness blockers.';
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'Budget reconciliation failed.';
      stored.control = { ...stored.control, ...systemSuspensionFields(stored.control), revision: stored.control.revision + 1,
        pauseReason: reason, updatedAt: new Date().toISOString() };
      stored.audit.push(event(stored.control, { type: 'reconciled', reason, previousState, newState: 'paused' }));
      await writeStored(stored);
      throw error;
    }
    stored.audit.push(event(stored.control, {
      type: 'reconciled', reason: input.reason, previousState, newState: stored.control.state,
      amountCents: input.targetReservedCents, venue: 'kalshi',
    }));
    await writeStored(stored);
    return stored.control;
  });
}

export function recordTradingReconciliationFailure(reason: string): Promise<BudgetControl> {
  return serialized(async () => {
    const stored = await readStored();
    const previousState = stored.control.state;
    if (previousState !== 'unconfigured' && previousState !== 'depleted') stored.control = {
      ...stored.control, ...systemSuspensionFields(stored.control), revision: stored.control.revision + 1,
      pauseReason: `Kalshi reconciliation blocked: ${reason}`, updatedAt: new Date().toISOString(),
    };
    stored.audit.push(event(stored.control, { type: 'reconciled', reason: `Blocked: ${reason}`, previousState, newState: stored.control.state }));
    await writeStored(stored);
    return stored.control;
  });
}
