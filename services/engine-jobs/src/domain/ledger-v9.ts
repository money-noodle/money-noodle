// The v1 execution ledger, version 9: one hot JSON file holding every paper and
// live order with the paper bankroll, plus immutable content-addressed evidence
// batches that terminal rows point at. Verification ported from the v1 archive's
// execution-ledger-storage and execution-ledger-compaction modules, sanitized to
// the fields this transform reads; no identifier, path or figure from real data.

import type { DataTree } from './archive-source.js';
import { readTreeJson } from './archive-source.js';
import { SHA256_HEX, sha256Hex } from './sha256.js';

export const LEDGER_FILE = 'paper-orders.json';
export const EVIDENCE_DIRECTORY = 'execution-order-evidence';
export const EVIDENCE_BATCH_VERSION = 'execution-order-evidence-batch-v1';
export const EVIDENCE_REF_VERSION = 'execution-order-evidence-ref-v1';

export type ExecutionMode = 'paper' | 'live';

export interface BankrollCorrection {
  at: string;
  reason: string;
  orderIds: string[];
  availableCents: number;
  realizedPnlCents: number;
}

export interface PaperBudget {
  startingCents: number;
  availableCents: number;
  realizedPnlCents: number;
  resets?: number;
  startedAt?: string;
  fundingId?: string;
  fundingSequence?: number;
  makerFeeCorrections?: BankrollCorrection[];
  strategyLeakCorrections?: BankrollCorrection[];
  reconciliationCorrections?: BankrollCorrection[];
}

export interface EvidenceReference {
  version: typeof EVIDENCE_REF_VERSION;
  file: string;
  sha256: string;
  rowKey: string;
}

export interface LedgerOrder {
  id: string;
  executionMode: ExecutionMode;
  status: string;
  stakeCents: number;
  pnlCents?: number;
  strategyId?: string;
  paperBankrollId?: string;
  budgetEpochId?: string;
  /**
   * Set on a non-edge position sold under its own exit policy. It is the one way
   * another strategy's payout reached the paper bankroll, so it decides whether
   * such a record contributes to the realized figure (`paper-bankroll.ts`).
   */
  standaloneExitPolicy?: string;
  archivedEvidence?: EvidenceReference;
  executionMirrorPair?: { version: 'entry-execution-mirror-pair-v1'; id: string };
  [key: string]: unknown;
}

export interface StoredLedger {
  version?: number;
  paperBudget?: PaperBudget;
  orders: LedgerOrder[];
  signalPersistence?: Record<string, unknown>;
  portfolioDecisions?: Record<string, unknown>;
  switchPersistence?: Record<string, unknown>;
  liveCorrections?: unknown[];
  lastLiveSkip?: unknown;
  [key: string]: unknown;
}

export interface EvidenceBatch {
  version: typeof EVIDENCE_BATCH_VERSION;
  orders: Record<string, { orderId: string; evidence: unknown }>;
}

export class LedgerVerificationError extends Error {
  override readonly name = 'LedgerVerificationError';
}

export interface LedgerVerification {
  version: number;
  orders: number;
  paperOrders: number;
  liveOrders: number;
  compactOrders: number;
  evidenceBatches: number;
  /**
   * False when the active load scope leaves the batch bodies in the archive. The
   * references are still checked — version, content-addressed file name against
   * the hash, and no two orders claiming the same file at different hashes — but
   * the row inside the batch cannot be resolved without the body.
   */
  evidenceBodiesVerified: boolean;
}

export interface LedgerVerificationOptions {
  /** Read each referenced batch and resolve the row it must hold. Default true. */
  readonly evidenceBodies?: boolean;
}

function validateReference(reference: EvidenceReference): void {
  if (reference.version !== EVIDENCE_REF_VERSION) {
    throw new LedgerVerificationError(
      `Unsupported execution evidence reference version: ${String(reference.version)}`,
    );
  }
  if (
    !SHA256_HEX.test(reference.sha256) ||
    !SHA256_HEX.test(reference.rowKey) ||
    reference.file !== `batch.${reference.sha256}.json`
  ) {
    throw new LedgerVerificationError(
      `Execution evidence reference filename/hash disagree: ${reference.file}`,
    );
  }
}

export function readLedger(tree: DataTree): StoredLedger {
  const stored = readTreeJson<StoredLedger>(tree, LEDGER_FILE);
  if (!stored) throw new LedgerVerificationError(`The restored tree holds no ${LEDGER_FILE}.`);
  if (!Array.isArray(stored.orders)) {
    throw new LedgerVerificationError('Execution ledger orders are malformed.');
  }
  if (stored.version !== undefined && stored.version !== 8 && stored.version !== 9) {
    throw new LedgerVerificationError(
      `Unsupported execution ledger version: ${String(stored.version)}`,
    );
  }
  if (stored.version !== 9 && stored.orders.some((order) => order.archivedEvidence)) {
    throw new LedgerVerificationError(
      'A pre-v9 execution ledger contains archived evidence references.',
    );
  }
  return stored;
}

/** Reads and checks one evidence batch by its content address. */
export function readEvidenceBatch(tree: DataTree, reference: EvidenceReference): EvidenceBatch {
  validateReference(reference);
  const raw = tree.get(`${EVIDENCE_DIRECTORY}/${reference.file}`);
  if (!raw) {
    throw new LedgerVerificationError(`Execution evidence batch ${reference.file} is absent.`);
  }
  if (sha256Hex(raw) !== reference.sha256) {
    throw new LedgerVerificationError(
      `Execution evidence checksum mismatch for ${reference.file}.`,
    );
  }
  const batch = JSON.parse(Buffer.from(raw).toString('utf8')) as Partial<EvidenceBatch>;
  if (
    batch.version !== EVIDENCE_BATCH_VERSION ||
    !batch.orders ||
    Array.isArray(batch.orders) ||
    typeof batch.orders !== 'object'
  ) {
    throw new LedgerVerificationError(
      `Execution evidence batch ${reference.file} is malformed or unsupported.`,
    );
  }
  return batch as EvidenceBatch;
}

/**
 * The ledger v9 semantic verifier: every evidence reference resolves to a batch
 * whose checksum matches and which holds the referenced row for that order, and
 * every row is structurally sound. Throws on the first failure, as v1 did.
 *
 * With `evidenceBodies: false` the batch bodies are not in the restored tree at
 * all, because the active load scope left them in the archive. The reference
 * checks still run — they are what the restore loads as the evidence batch index —
 * and the result says the bodies were not verified rather than implying they were.
 */
export function verifyLedgerV9(
  tree: DataTree,
  options: LedgerVerificationOptions = {},
): LedgerVerification {
  const evidenceBodies = options.evidenceBodies !== false;
  const stored = readLedger(tree);
  const byFile = new Map<string, { reference: EvidenceReference; orders: LedgerOrder[] }>();
  for (const order of stored.orders) {
    const reference = order.archivedEvidence;
    if (!reference) continue;
    validateReference(reference);
    const current = byFile.get(reference.file);
    if (current && current.reference.sha256 !== reference.sha256) {
      throw new LedgerVerificationError(
        `Execution evidence file ${reference.file} has conflicting hashes.`,
      );
    }
    if (current) current.orders.push(order);
    else byFile.set(reference.file, { reference, orders: [order] });
  }
  if (evidenceBodies) {
    for (const { reference, orders } of byFile.values()) {
      const batch = readEvidenceBatch(tree, reference);
      for (const order of orders) {
        const stored = batch.orders[order.archivedEvidence!.rowKey];
        if (!stored || stored.orderId !== order.id) {
          throw new LedgerVerificationError(
            `Execution evidence batch ${reference.file} does not contain referenced row ${order.archivedEvidence!.rowKey} for ${order.id}.`,
          );
        }
      }
    }
  }
  for (const order of stored.orders) {
    if (!order.id || !order.executionMode || !order.status || !Number.isFinite(order.stakeCents)) {
      throw new LedgerVerificationError(
        `Execution order ${order.id || '<missing>'} is structurally malformed.`,
      );
    }
  }
  return {
    version: stored.version ?? 8,
    orders: stored.orders.length,
    paperOrders: stored.orders.filter((order) => order.executionMode === 'paper').length,
    liveOrders: stored.orders.filter((order) => order.executionMode !== 'paper').length,
    compactOrders: stored.orders.filter((order) => order.archivedEvidence).length,
    evidenceBatches: byFile.size,
    evidenceBodiesVerified: evidenceBodies,
  };
}
