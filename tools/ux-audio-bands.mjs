// Spectral split of single synths, rendered dry in the offline sandbox: how much of each sound
// is left on small speakers (laptop / phone: next to nothing below ~200 Hz).
//
//   node tools/ux-audio-bands.mjs [--no-build] [synth[:json-opts] ...]
//
// Prints full-band RMS, the RMS above 200 Hz and above 400 Hz (dBFS), and the difference.
import { execFileSync } from 'node:child_process';
import { launch } from './harness.mjs';

const args = process.argv.slice(2);
if (!args.includes('--no-build')) {
  execFileSync('node', ['build.mjs', '--entry', 'tools/sandbox/audio.js', '--out', 'dist/sandbox-audio.html'], { stdio: 'inherit' });
}
const wanted = args.filter((a) => !a.startsWith('--'));
const cases = wanted.length ? wanted.map((w) => {
  const [name, json] = w.split(/:(.+)/);
  return [name, json ? JSON.parse(json) : {}];
}) : [
  ['footfall', { intensity: 1 }], ['footfall', { intensity: 0.5 }], ['footfall', { intensity: 0.15 }],
  ['leviathanCall', { duration: 4.6, brightness: 1 }], ['leviathanCall', { duration: 4.6, brightness: 0.35 }],
  ['grab', {}], ['shriek', {}], ['creatureStep', {}], ['creatureStep', { chasing: true }],
  ['footstep', { mode: 'crouch' }], ['footstep', { mode: 'walk' }], ['footstep', { mode: 'sprint' }],
  ['swell', {}], ['stinger', {}],
];

const h = await launch({ html: 'dist/sandbox-audio.html', query: '' });
console.log('synth'.padEnd(44), '  full  >200Hz  >400Hz   (dB RMS over the loudest 1 s)');
for (const [name, opts] of cases) {
  const res = await h.eval(([n, o]) => window.bandSplit(n, o), [name, opts]);
  const f1 = (v) => v.toFixed(1).padStart(6);
  console.log(`${name} ${JSON.stringify(opts)}`.padEnd(44), f1(res.full), ' ', f1(res.hi200), ' ', f1(res.hi400), `   (${(res.hi200 - res.full).toFixed(1)} dB above 200 Hz)`);
}
if (h.errors.length) console.log(h.errors.join('\n'));
await h.close();
