import { verifyExecutionLedgerAt } from '../src/lib/execution-ledger-compaction';

verifyExecutionLedgerAt()
  .then((result) => console.log(JSON.stringify({ ok: true, ...result }, null, 2)))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
