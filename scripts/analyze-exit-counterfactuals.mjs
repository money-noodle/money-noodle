// Buy-and-hold versus buy-plus-exit, split by exit policy. Reads the order ledger only; changes nothing.
// Run: node scripts/analyze-exit-counterfactuals.mjs > reports/exit-counterfactual-analysis-<date>.md
import fs from 'node:fs';

const orders = JSON.parse(fs.readFileSync(`${process.cwd()}/data/paper-orders.json`, 'utf8')).orders;
const stakeOf = (o) => o.actualStakeCents ?? o.stakeCents;
const pnlOf = (o) => o.actualPnlCents ?? o.pnlCents ?? 0;
const mean = (a) => a.length ? a.reduce((s, x) => s + x, 0) / a.length : null;
const cents = (x) => x === null ? '—' : `${x >= 0 ? '+' : ''}${x.toFixed(1)}¢`;
const pct = (x) => x === null ? '—' : `${x >= 0 ? '+' : ''}${(x * 100).toFixed(1)}%`;

function cluster(rows, value) {
  const byWindow = new Map();
  for (const row of rows) byWindow.set(row.closesAt, [...(byWindow.get(row.closesAt) ?? []), value(row)]);
  const perWindow = [...byWindow.values()].map(mean);
  const m = mean(perWindow);
  const se = perWindow.length > 1
    ? Math.sqrt(perWindow.reduce((s, x) => s + (x - m) ** 2, 0) / (perWindow.length - 1) / perWindow.length) : null;
  return { windows: perWindow.length, mean: m, se, t: se ? m / se : null };
}

const line = (cellArray) => `| ${cellArray.join(' | ')} |`;
const rows = [];
for (const mode of ['live', 'paper']) {
  const mine = orders.filter((o) => o.executionMode === mode && !o.id.includes(':exit:'));
  const exits = mine.filter((o) => o.status === 'sold' && !o.switchedToOrderId && o.counterfactualHoldPnlCents !== undefined);
  const held = mine.filter((o) => (o.status === 'won' || o.status === 'lost') && o.latestNetLiquidationCents !== undefined);

  for (const policy of ['strict-value-v1', 'profit-reversal-75-v1']) {
    const z = exits.filter((o) => o.standaloneExitPolicy === policy);
    if (!z.length) continue;
    const delta = cluster(z, (o) => (pnlOf(o) - o.counterfactualHoldPnlCents) / stakeOf(o));
    rows.push({
      mode, arm: `EXIT vs HOLD · ${policy}`, basis: 'authoritative', n: z.length, windows: delta.windows,
      exitReturn: cluster(z, (o) => pnlOf(o) / stakeOf(o)).mean,
      holdReturn: cluster(z, (o) => o.counterfactualHoldPnlCents / stakeOf(o)).mean,
      totalCents: z.reduce((s, o) => s + pnlOf(o) - o.counterfactualHoldPnlCents, 0),
      delta,
      holdWinRate: z.filter((o) => o.counterfactualHoldOutcome === o.side).length / z.length,
    });
  }

  const holdArms = [
    ['HOLD vs EXIT · exit-at-last-observation', held, (o) => o.latestNetLiquidationCents],
    ['HOLD vs EXIT · exit-at-armed-peak', held.filter((o) => o.profitLockArmedAt && o.peakNetLiquidationCents !== undefined), (o) => o.peakNetLiquidationCents],
  ];
  for (const [arm, group, liquidation] of holdArms) {
    if (!group.length) continue;
    const incremental = (o) => (pnlOf(o) - (liquidation(o) - stakeOf(o))) / stakeOf(o);
    rows.push({
      mode, arm, basis: 'approximate', n: group.length, windows: cluster(group, incremental).windows,
      exitReturn: cluster(group, (o) => (liquidation(o) - stakeOf(o)) / stakeOf(o)).mean,
      holdReturn: cluster(group, (o) => pnlOf(o) / stakeOf(o)).mean,
      totalCents: group.reduce((s, o) => s + pnlOf(o) - (liquidation(o) - stakeOf(o)), 0),
      delta: cluster(group, incremental),
      holdWinRate: group.filter((o) => o.status === 'won').length / group.length,
    });
  }
}

console.log(`# Exit counterfactual analysis — ${new Date().toISOString().slice(0, 10)}\n`);
console.log('Buy-and-hold versus buy-plus-exit for each standalone exit policy, plus the reverse arm for positions\n'
  + 'held to settlement. Positive incremental return means the action actually taken beat the alternative it\n'
  + 'rejected. Means and standard errors are clustered by settlement window. Reporting only.\n');
console.log(line(['Mode', 'Arm', 'Basis', 'n', 'Windows', 'Action return', 'Alternative return', 'Incremental', '±SE', 't', 'Total']));
console.log(line(Array(11).fill('---')));
for (const r of rows) {
  const [action, alternative] = r.arm.startsWith('EXIT') ? [r.exitReturn, r.holdReturn] : [r.holdReturn, r.exitReturn];
  console.log(line([r.mode, r.arm, r.basis, r.n, r.windows, pct(action), pct(alternative),
    pct(r.delta.mean), r.delta.se === null ? '—' : `${(r.delta.se * 100).toFixed(1)}pp`,
    r.delta.t === null ? '—' : r.delta.t.toFixed(2), cents(r.totalCents)]));
}
console.log('\n## Reading the table\n');
console.log('- **Incremental** is the equal-weighted per-window mean of per-stake incremental return; **Total** is the raw\n'
  + '  cent sum. They can disagree in sign, because stake sizing rose from roughly 9¢ to as much as 140¢ per order\n'
  + '  during the recorded history, so the cent sum is dominated by the largest-stake era. The per-stake mean is the\n'
  + '  comparable figure; the cent sum is what the account actually felt.\n'
  + '- The `approximate` HOLD arms price the rejected exit from an executable bid recorded while the position was\n'
  + '  open, not from a settled outcome. `exit-at-armed-peak` prices it at the high-water mark, which is the best\n'
  + '  exit that population could conceivably have taken rather than one any policy could reliably hit. A negative\n'
  + '  arm there is expected by construction and only its magnitude is informative.\n');
console.log('## Counterfactual hold win rate at exit\n');
for (const r of rows.filter((x) => x.arm.startsWith('EXIT'))) {
  console.log(`- ${r.mode} ${r.arm}: holding would have settled in the money on ${(r.holdWinRate * 100).toFixed(1)}% of ${r.n} exits.`);
}
