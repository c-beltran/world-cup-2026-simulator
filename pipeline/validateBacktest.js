// Offline integrity checks for the 2022 backtest. Pure assertions, no network.
//   npm run validate:backtest      (run after backtest2022.js + buildBacktest.js)

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const btPath = join(import.meta.dirname, 'out', 'backtest-2022.json');
const accPath = join(ROOT, 'app', 'accuracy-data.json');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`  ✓ ${m}`); } else { fail++; console.error(`  ✗ ${m}`); } };

if (!existsSync(btPath) || !existsSync(accPath)) {
  console.error('Missing backtest output — run `npm run backtest && npm run build:backtest` first.');
  process.exit(1);
}
const bt = JSON.parse(readFileSync(btPath, 'utf8'));
const acc = JSON.parse(readFileSync(accPath, 'utf8'));
const cal = bt.calibration;

console.log('\n[1] Sanity — the engine reproduces the real 2022 outcome');
ok(bt.sanity.ok && bt.realChampion === 'Argentina', `clamp-all champion is Argentina (got ${bt.realChampion})`);

console.log('\n[2] Calibration metrics are well-formed and beat the baseline');
ok(cal.brier >= 0 && cal.brier <= 1, `Brier in [0,1] (${cal.brier.toFixed(4)})`);
ok(cal.brier < cal.brierBaseline, `Brier beats naive baseline (${cal.brier.toFixed(4)} < ${cal.brierBaseline.toFixed(4)})`);
ok(cal.matchBrier < cal.matchBrierBaseline, `per-match Brier beats baseline (${cal.matchBrier.toFixed(4)} < ${cal.matchBrierBaseline.toFixed(4)})`);
const binN = cal.reliability.reduce((s, b) => s + b.n, 0);
ok(binN === cal.n, `reliability bins partition all ${cal.n} predictions (got ${binN})`);
ok(cal.reliability.every((b) => b.obs >= 0 && b.obs <= 1 && b.meanP >= 0 && b.meanP <= 1), 'every bin obs/meanP in [0,1]');

console.log('\n[3] Outright probabilities are coherent');
const titleSum = bt.outright.reduce((s, o) => s + o.prob.title, 0);
ok(Math.abs(titleSum - 1) < 0.005, `title probabilities sum to 1 across teams (${titleSum.toFixed(4)})`);
ok(bt.outright.every((o) => ['r16', 'qf', 'sf', 'final', 'title'].every((r) => o.prob[r] >= 0 && o.prob[r] <= 1)), 'all reach probabilities in [0,1]');
// nested monotonicity: P(reach R16) >= P(QF) >= ... >= P(title) for every team
ok(bt.outright.every((o) => o.prob.r16 >= o.prob.qf - 1e-9 && o.prob.qf >= o.prob.sf - 1e-9 && o.prob.sf >= o.prob.final - 1e-9 && o.prob.final >= o.prob.title - 1e-9),
  'reach probabilities are monotone (R16 ≥ QF ≥ SF ≥ Final ≥ Title)');

console.log('\n[4] Bookmaker comparison de-vigged correctly');
const mSum = acc.market.reduce((s, x) => s + x.market, 0);
ok(Math.abs(mSum - 1) < 0.01, `de-vigged market probabilities sum to ~1 (${mSum.toFixed(4)})`);
ok(acc.market.every((x) => x.market > 0 && x.market < 1 && x.model >= 0 && x.model <= 1), 'all model/market probs in (0,1)');

console.log('\n[5] Receipts present and consistent');
ok(acc.receipts.length >= 3, `at least 3 receipts (${acc.receipts.length})`);
ok(acc.receipts.find((r) => r.kind === 'champion')?.name === 'Argentina', 'champion receipt is Argentina');

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} checks passed, ${fail} failed.`);
process.exit(fail === 0 ? 0 : 1);
