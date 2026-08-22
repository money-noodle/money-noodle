import { beforeEach, describe, expect, it, vi } from 'vitest';

const runtimeKey = Symbol.for('money-noodle.execution-ledger-runtime');
const globals = globalThis as typeof globalThis & { [runtimeKey]?: unknown };

describe('process-global execution ledger runtime', () => {
  beforeEach(() => {
    delete globals[runtimeKey];
    vi.resetModules();
  });

  it('serializes operations from independently loaded server module copies', async () => {
    const first = await import('./execution-ledger-runtime');
    vi.resetModules();
    const second = await import('./execution-ledger-runtime');
    const events: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });

    const a = first.serializeExecutionLedgerOperation(async () => {
      events.push('a:start');
      await gate;
      events.push('a:end');
    });
    const b = second.serializeExecutionLedgerOperation(async () => { events.push('b'); });
    await vi.waitFor(() => expect(events).toEqual(['a:start']));
    release();
    await Promise.all([a, b]);
    expect(events).toEqual(['a:start', 'a:end', 'b']);
  });

  it('shares committed state across independently loaded server module copies', async () => {
    const first = await import('./execution-ledger-runtime');
    first.getExecutionLedgerRuntime<{ revision: number }>().committed = { revision: 7 };
    vi.resetModules();
    const second = await import('./execution-ledger-runtime');
    expect(second.getExecutionLedgerRuntime<{ revision: number }>().committed).toEqual({ revision: 7 });
  });

  it('continues the queue after a failed operation', async () => {
    const runtime = await import('./execution-ledger-runtime');
    await expect(runtime.serializeExecutionLedgerOperation(async () => { throw new Error('failed'); })).rejects.toThrow('failed');
    await expect(runtime.serializeExecutionLedgerOperation(async () => 42)).resolves.toBe(42);
  });
});
