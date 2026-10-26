// Gameplay bot playtest: plays the real level zone by zone with injected input (see
// tools/playtest-bot.mjs for the bot, tools/playtest-policies.mjs for the per-zone policies) and
// prints a pass/fail table per zone x policy.
//
//   node build.mjs && node tools/playtest.mjs [--zones 1,2] [--policies intended,careless]
//        [--runs 5] [--offsets 0,7,13,21,29] [--trace] [--log] [--json out.json]
//
// Every run starts with an ordinary respawn at the zone's checkpoint (no teleporting during a
// run), waits a varied offset, then follows the policy. Expectations: 'intended' must reach the
// next checkpoint (Z4: the exit) in >= 4/5 runs; careless policies should mostly fail (caught,
// or at least spotted and chased) in Z1-Z4.
import { launch } from './harness.mjs';
import { installBot } from './playtest-bot.mjs';
import { installPolicies } from './playtest-policies.mjs';
import { CONFIG } from '../src/config.js';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const opt = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
const zones = opt('--zones', '0,1,2,3,4').split(',').map(Number);
const policyFilter = opt('--policies', null)?.split(',');
const runs = Number(opt('--runs', 5));
const offsets = opt('--offsets', null)?.split(',').map(Number);
const showLog = args.includes('--log');
const showPerf = args.includes('--perf');
const trace = args.includes('--trace');
const jsonOut = opt('--json', null);
const html = opt('--html', 'dist/index.html');
const outDir = opt('--out', 'dist/playtest');
const onlyRuns = opt('--only-runs', null)?.split(',').map(Number);

const DEFAULT_OFFSETS = [0, 7.3, 13.9, 21.4, 29.2, 3.6, 17.1, 25.5, 10.2, 33.8];
const all = [];
let errors = [];
const open = async (zone) => {
  const h = await launch({ html, query: `autostart&quality=0&mute&cp=${zone}`, timeout: 120000 });
  await h.eval(installBot, [CONFIG, { fastModels: !args.includes('--full-models') }]);
  await h.eval(installPolicies);
  return h;
};
for (const zone of zones) {
  let h = await open(zone);
  const names = await h.eval((z) => Object.keys(window.__policies[z] || {}), zone);
  const traces = [];
  for (const name of names) {
    if (policyFilter && !policyFilter.includes(name)) continue;
    for (let i = 0; i < runs; i++) {
      if (onlyRuns && !onlyRuns.includes(i)) continue;
      const offset = offsets ? offsets[i % offsets.length] : DEFAULT_OFFSETS[i % DEFAULT_OFFSETS.length];
      let r;
      for (let attempt = 0; ; attempt++) {
        try {
          r = await h.eval(([z, n, i, o]) => window.__bot.runPolicy(z, n, i, o), [zone, name, i, { offset, trace }]);
          break;
        } catch (err) {
          // A headless renderer occasionally dies under heavy machine load: reopen and retry.
          errors = errors.concat(h.errors);
          await h.close().catch(() => {});
          if (attempt >= 2) throw err;
          console.log(`  (page crashed: ${String(err.message).split('\n')[0]}; reopening)`);
          h = await open(zone);
        }
      }
      all.push(r);
      const flag = r.outcome === 'goal' ? 'OK  ' : 'FAIL';
      console.log(`Z${zone} ${name.padEnd(12)} #${i} off ${String(offset).padStart(4)}s  ${flag} ${r.outcome.padEnd(8)} t=${String(r.time).padStart(6)}s  alerts=${r.alerts} susp=${r.suspicious} maxThreat=${r.maxThreat} chase=${r.chaseTime}s${r.footBlocks ? ' footBlocks=' + r.footBlocks : ''}${r.caughtBy ? ' by ' + r.caughtBy : ''} end=${r.pos}${showPerf ? ` | wall ${r.wall}s paths ${r.paths} (${r.pathMs} ms, max ${r.maxPathMs})` : ''}`);
      if (r.error) console.log(r.error);
      if (showLog) console.log('   ' + r.log.join('\n   '));
      if (r.trace) traces.push({ points: r.trace, caught: r.outcome === 'caught', color: r.outcome === 'goal' ? (name === 'intended' ? '#40e0ff' : '#ffe040') : '#ff4040' });
    }
  }
  if (trace) {
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, `trace-z${zone}.json`), JSON.stringify(traces));
  }
  errors = errors.concat(h.errors);
  await h.close();
}

// Summary table
console.log('\nzone  policy        success  caught  spotted(alert)  mean time');
const groups = new Map();
for (const r of all) {
  const k = `${r.zone}|${r.name}`;
  if (!groups.has(k)) groups.set(k, []);
  groups.get(k).push(r);
}
for (const [k, rs] of groups) {
  const [z, n] = k.split('|');
  const ok = rs.filter((r) => r.outcome === 'goal');
  const caught = rs.filter((r) => r.outcome === 'caught').length;
  const spotted = rs.filter((r) => r.alerts > 0).length;
  const mean = ok.length ? (ok.reduce((a, r) => a + r.time, 0) / ok.length).toFixed(1) : '-';
  console.log(`Z${z}    ${n.padEnd(12)}  ${ok.length}/${rs.length}      ${caught}/${rs.length}     ${spotted}/${rs.length}            ${mean}`);
}
if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify(all, null, 1));
if (errors.length) {
  console.log('PAGE ERRORS:\n' + errors.join('\n'));
  process.exitCode = 1;
}
