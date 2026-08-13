import 'server-only';

import postgres, { type JSONValue, type Sql } from 'postgres';
import type { PublicPaperBudget, PublicPaperExecutionRecord, PublicPaperPerformance } from './types';

const DATABASE_URL = 'MONEY_NOODLE_DATABASE_URL';

interface BudgetRow {
  starting_cents: string | number;
  available_cents: string | number;
  equity_cents: string | number;
  reserved_cents: string | number;
  proposed_stake_cents: string | number;
  running: boolean;
  depleted: boolean;
  open_orders: string | number;
  settled_orders: string | number;
  realized_pnl_cents: string | number;
  bankroll_resets: string | number;
}

interface ExecutionRow {
  symbol: string;
  venue: PublicPaperExecutionRecord['venue'];
  side: PublicPaperExecutionRecord['side'];
  status: PublicPaperExecutionRecord['status'];
  created_at: Date | string;
  closes_at: Date | string;
  ask_price: string | number;
  quantity: string | number;
  stake_cents: string | number;
  fee_cents: string | number;
  pnl_cents: string | number | null;
  outcome: PublicPaperExecutionRecord['outcome'] | null;
  no_fill_reason: PublicPaperExecutionRecord['noFillReason'] | null;
  liquidity_role: PublicPaperExecutionRecord['liquidityRole'] | null;
}

declare global {
  // eslint-disable-next-line no-var
  var __moneyNoodlePostgres: Sql | undefined;
}

function databaseUrl(): string | undefined {
  const value = process.env[DATABASE_URL]?.trim();
  return value || undefined;
}

function sql(): Sql | undefined {
  const url = databaseUrl();
  if (!url) return undefined;
  globalThis.__moneyNoodlePostgres ??= postgres(url, {
    max: 1,
    prepare: false,
    idle_timeout: 20,
    connect_timeout: 10,
  });
  return globalThis.__moneyNoodlePostgres;
}

const numeric = (value: string | number | null | undefined) => value === null || value === undefined ? undefined : Number(value);
const timestamp = (value: Date | string) => value instanceof Date ? value.toISOString() : value;

/** The local worker remains authoritative; this only enables a bounded hosted-dashboard projection. */
export function postgresPaperProjectionSyncEnabled(): boolean {
  return Boolean(databaseUrl()) && process.env.MONEY_NOODLE_POSTGRES_PAPER_SYNC === 'true';
}

/** Vercel reads this projection when a read-only database URL is configured. */
export async function readPublicPaperBudgetFromPostgres(): Promise<PublicPaperBudget | null> {
  const connection = sql();
  if (!connection) return null;
  try {
    const [budget] = await connection<BudgetRow[]>`
      select starting_cents, available_cents, equity_cents, reserved_cents, proposed_stake_cents,
             running, depleted, open_orders, settled_orders, realized_pnl_cents, bankroll_resets
      from money_noodle_public_paper_budget
      where singleton = true
      limit 1
    `;
    if (!budget) return null;
    const executions = await connection<ExecutionRow[]>`
      select symbol, venue, side, status, created_at, closes_at, ask_price, quantity,
             stake_cents, fee_cents, pnl_cents, outcome, no_fill_reason, liquidity_role
      from money_noodle_public_paper_executions
      order by created_at desc
      limit 30
    `;
    return {
      durable: true,
      startingCents: numeric(budget.starting_cents) ?? 0,
      availableCents: numeric(budget.available_cents) ?? 0,
      equityCents: numeric(budget.equity_cents) ?? 0,
      reservedCents: numeric(budget.reserved_cents) ?? 0,
      proposedStakeCents: numeric(budget.proposed_stake_cents) ?? 0,
      running: budget.running,
      depleted: budget.depleted,
      openOrders: numeric(budget.open_orders) ?? 0,
      settledOrders: numeric(budget.settled_orders) ?? 0,
      realizedPnlCents: numeric(budget.realized_pnl_cents) ?? 0,
      bankrollResets: numeric(budget.bankroll_resets) ?? 0,
      recentExecutions: executions.map((row) => ({
        symbol: row.symbol, venue: row.venue, side: row.side, status: row.status,
        createdAt: timestamp(row.created_at), closesAt: timestamp(row.closes_at),
        askPrice: numeric(row.ask_price) ?? 0, quantity: numeric(row.quantity) ?? 0,
        stakeCents: numeric(row.stake_cents) ?? 0, feeCents: numeric(row.fee_cents) ?? 0,
        pnlCents: numeric(row.pnl_cents), outcome: row.outcome ?? undefined,
        noFillReason: row.no_fill_reason ?? undefined, liquidityRole: row.liquidity_role ?? undefined,
      })),
    };
  } catch (error) {
    console.error('Postgres public paper projection read failed:', error);
    return null;
  }
}

interface PerformanceRow {
  payload: unknown;
  source_updated_at: Date | string;
}

/**
 * Vercel reads this projection to serve the public paper track record. The payload is stored as one
 * document, so `durable` and `generatedAt` are re-derived here from the replication timestamp rather
 * than trusted from the stored copy.
 */
export async function readPublicPaperPerformanceFromPostgres(): Promise<PublicPaperPerformance | null> {
  const connection = sql();
  if (!connection) return null;
  try {
    const [row] = await connection<PerformanceRow[]>`
      select payload, source_updated_at
      from money_noodle_public_paper_performance
      where singleton = true
      limit 1
    `;
    if (!row?.payload || typeof row.payload !== 'object') return null;
    const payload = row.payload as Omit<PublicPaperPerformance, 'durable' | 'generatedAt'>;
    // A projection missing its scored halves is a failed or partial replication, not an empty record.
    if (!payload.summary || !payload.paperRecord) return null;
    return { ...payload, durable: true, generatedAt: timestamp(row.source_updated_at) };
  } catch (error) {
    console.error('Postgres public paper performance read failed:', error);
    return null;
  }
}

/**
 * Replicates the public track record. Throttled because scoring the whole forecast log is far more
 * expensive than the budget aggregate, and a ledger write can happen every few seconds.
 */
export async function syncPublicPaperPerformanceToPostgres(payload: Omit<PublicPaperPerformance, 'durable' | 'generatedAt'>): Promise<void> {
  if (!postgresPaperProjectionSyncEnabled()) return;
  const connection = sql();
  if (!connection) return;
  const now = new Date().toISOString();
  // The driver's JSONValue demands index signatures a precise interface cannot satisfy; the payload is
  // plain serializable JSON by construction, having just been assembled from scored numbers and strings.
  const document = payload as unknown as JSONValue;
  await connection`
    insert into money_noodle_public_paper_performance (singleton, payload, source_updated_at)
    -- json() and not JSON.stringify(): the driver serializes parameters itself, so passing pre-encoded
    -- text stores a JSON string scalar rather than the object, and every read then fails its shape check.
    values (true, ${connection.json(document)}, ${now})
    on conflict (singleton) do update set
      payload = excluded.payload,
      source_updated_at = excluded.source_updated_at
  `;
}

/**
 * Best-effort replication only. A database outage must never block a local ledger write, execution
 * lifecycle, reconciliation, or restart barrier. Run db/migrations/001_public_paper_projection.sql first.
 */
export async function syncPublicPaperBudgetToPostgres(budget: PublicPaperBudget): Promise<void> {
  if (!postgresPaperProjectionSyncEnabled()) return;
  const connection = sql();
  if (!connection) return;
  const now = new Date().toISOString();
  await connection.begin(async (transaction) => {
    await transaction`
      insert into money_noodle_public_paper_budget (
        singleton, starting_cents, available_cents, equity_cents, reserved_cents,
        proposed_stake_cents, running, depleted, open_orders, settled_orders,
        realized_pnl_cents, bankroll_resets, source_updated_at
      ) values (
        true, ${budget.startingCents}, ${budget.availableCents}, ${budget.equityCents}, ${budget.reservedCents},
        ${budget.proposedStakeCents}, ${budget.running}, ${budget.depleted}, ${budget.openOrders}, ${budget.settledOrders},
        ${budget.realizedPnlCents}, ${budget.bankrollResets}, ${now}
      ) on conflict (singleton) do update set
        starting_cents = excluded.starting_cents,
        available_cents = excluded.available_cents,
        equity_cents = excluded.equity_cents,
        reserved_cents = excluded.reserved_cents,
        proposed_stake_cents = excluded.proposed_stake_cents,
        running = excluded.running,
        depleted = excluded.depleted,
        open_orders = excluded.open_orders,
        settled_orders = excluded.settled_orders,
        realized_pnl_cents = excluded.realized_pnl_cents,
        bankroll_resets = excluded.bankroll_resets,
        source_updated_at = excluded.source_updated_at
    `;
    if (!budget.recentExecutions.length) return;
    const rows = budget.recentExecutions.map((record) => ({
      execution_key: `${record.createdAt}:${record.symbol}:${record.side}:${record.venue}`,
      symbol: record.symbol, venue: record.venue, side: record.side, status: record.status,
      created_at: record.createdAt, closes_at: record.closesAt, ask_price: record.askPrice,
      quantity: record.quantity, stake_cents: record.stakeCents, fee_cents: record.feeCents,
      pnl_cents: record.pnlCents ?? null, outcome: record.outcome ?? null,
      no_fill_reason: record.noFillReason ?? null, liquidity_role: record.liquidityRole ?? null,
      source_updated_at: now,
    }));
    await transaction`
      insert into money_noodle_public_paper_executions ${transaction(rows,
        'execution_key', 'symbol', 'venue', 'side', 'status', 'created_at', 'closes_at', 'ask_price',
        'quantity', 'stake_cents', 'fee_cents', 'pnl_cents', 'outcome', 'no_fill_reason', 'liquidity_role', 'source_updated_at')}
      on conflict (execution_key) do update set
        status = excluded.status,
        closes_at = excluded.closes_at,
        ask_price = excluded.ask_price,
        quantity = excluded.quantity,
        stake_cents = excluded.stake_cents,
        fee_cents = excluded.fee_cents,
        pnl_cents = excluded.pnl_cents,
        outcome = excluded.outcome,
        no_fill_reason = excluded.no_fill_reason,
        liquidity_role = excluded.liquidity_role,
        source_updated_at = excluded.source_updated_at
    `;
  });
}
