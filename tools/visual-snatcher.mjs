// Pose sheet for the snatcher model in the sandbox: the sleeper's slump (seated -> standing) from
// the front, the side and 3/4, plus a contact sheet of the get-up transition.
//   node tools/visual-snatcher.mjs [--no-build] [--studio] [--out dir]
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { launch } from './harness.mjs';

const args = process.argv.slice(2);
const opt = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
const out = opt('--out', 'dist/shots/visual/snatcher');
const html = 'dist/sandbox-snatcher-model.html';
if (!args.includes('--no-build')) {
  execFileSync('node', ['build.mjs', '--entry', 'tools/sandbox/snatcher-model.js', '--out', html], { stdio: 'inherit' });
}
const h = await launch({ html, query: `paused${args.includes('--studio') ? '&studio' : ''}` });

// Four snatchers side by side at fixed slump values, driven directly (the sandbox has no slump).
const pose = (slumps, yaw, cam, target, settle = 2.5) => h.eval(([slumps, yaw, cam, target, settle]) => {
  const g = window.__game;
  g.setup(slumps.map((s, i) => ({ seed: 3 + i, mode: 'idle', x: (i - (slumps.length - 1) / 2) * 1.6, z: -3, yaw })));
  const n = Math.ceil(settle * 60);
  for (let f = 0; f < n; f++) {
    g.models.forEach((m, i) => m.model.update(1 / 60, { mode: 'idle', speed: 0, slump: slumps[i], headPitch: 0, headYaw: 0 }));
  }
  g.debugCamera = { pos: cam, target };
}, [slumps, yaw, cam, target, settle]);

await pose([1, 0.6, 0.3, 0], Math.PI, [0, 1.3, 1.6], [0, 0.7, -3]);
await h.shot(path.join(out, 'slump_front.png'));
await pose([1, 0.6, 0.3, 0], Math.PI / 2, [0, 1.3, 1.6], [0, 0.7, -3]);
await h.shot(path.join(out, 'slump_side.png'));
await pose([1, 1, 1, 1], Math.PI * 0.75, [0, 1.6, 0.6], [0, 0.4, -3]);
await h.shot(path.join(out, 'slump_quarter.png'));

// The get-up, as the AI drives it: slump falls linearly 1 -> 0 over 1.5 s; frames every 0.3 s.
await h.eval(() => {
  const g = window.__game;
  const times = [0, 0.3, 0.6, 0.9, 1.2, 1.5, 2.0];
  g.setup(times.map((_, i) => ({ seed: 5, mode: 'idle', x: (i - 3) * 1.25, z: -3.6, yaw: Math.PI / 2 })));
  // settle seated
  for (let f = 0; f < 150; f++) g.models.forEach((m) => m.model.update(1 / 60, { mode: 'idle', slump: 1 }));
  g.models.forEach((m, i) => {
    let t = 0;
    while (t < times[i]) {
      t += 1 / 60;
      m.model.update(1 / 60, { mode: 'idle', slump: Math.max(0, 1 - t / 1.5), headPitch: -0.6 + 0.65 * Math.min(1, t / 1.5) });
    }
  });
  g.debugCamera = { pos: [0, 1.2, 2.6], target: [0, 0.8, -3.6] };
});
await h.shot(path.join(out, 'slump_getup.png'));
console.log(h.errors.length ? h.errors.join('\n') : 'no console errors');
await h.close();
