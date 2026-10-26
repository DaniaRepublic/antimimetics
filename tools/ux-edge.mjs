// Pointer-lock and focus edge cases of the HUD, with the real game (fast: ?quality=0).
//
//   node tools/ux-edge.mjs [--no-build] [--out dist/shots/ux-edge]
//
// - resume refused by the browser (re-lock cooldown) -> back to the pause menu with a note
// - lock never available (sandboxed iframe) -> drag-to-look notice, no re-pause loop
// - window blur while playing -> paused
// - a zone's hint is dropped once the player has left the zone
// - the chase tip cuts a running lesson short
import { execSync } from 'node:child_process';
import { launch } from './harness.mjs';

const args = process.argv.slice(2);
const opt = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
const out = opt('--out', 'dist/shots/ux-edge');
if (!args.includes('--no-build')) execSync('node build.mjs', { stdio: 'inherit' });

const problems = [];
const check = (ok, msg) => {
  if (!ok) problems.push(msg);
  console.log(`${ok ? '  ok ' : 'FAIL '} ${msg}`);
};

const h = await launch({ html: 'dist/index.html', query: 'autostart&mute&quality=0', timeout: 240000 });
h.page.setDefaultTimeout(240000);

// 1. Resume refused.
const relock = await h.eval(() => {
  const g = window.__game;
  g.pause();
  g.simulate(1.5); // past the cooldown in game time
  g.hud.resume();
  const resumed = g.state;
  g.bus.emit('input:lockfailed', {});
  const note = document.querySelector('.wic-pause__note');
  return { resumed, after: g.state, note: getComputedStyle(note).display !== 'none' };
});
check(relock.resumed === 'playing' && relock.after === 'paused' && relock.note, `refused re-lock -> back to pause with a note (${JSON.stringify(relock)})`);
await h.page.waitForTimeout(900);
await h.shot(`${out}/relock-note.png`);
const noteCleared = await h.eval(() => {
  const g = window.__game;
  g.resume();
  g.pause();
  return getComputedStyle(document.querySelector('.wic-pause__note')).display === 'none';
});
check(noteCleared, 'the note is gone the next time the menu opens');

// 2. Lock unavailable: drag-to-look notice, and a refusal does not bounce back to the menu.
const drag = await h.eval(() => {
  const g = window.__game;
  g.resume();
  g.input.pointerLockFailed = true;
  g.hud.resumedAt = performance.now();
  g.bus.emit('input:lockfailed', {});
  g.simulate(1);
  return { state: g.state, notice: Number(document.querySelector('.wic-notice').style.opacity || 0) };
});
check(drag.state === 'playing' && drag.notice > 0.5, `no lock at all -> keep playing, drag-to-look notice (${JSON.stringify(drag)})`);
await h.shot(`${out}/drag-notice.png`);

// 3. Window blur.
const blur = await h.eval(() => {
  const g = window.__game;
  window.dispatchEvent(new Event('blur'));
  const s = g.state;
  g.resume();
  return s;
});
check(blur === 'paused', 'window blur pauses');

// 4. Stale zone hint.
const zone = await h.eval(() => {
  const g = window.__game;
  const t = g.hud.tutorial;
  t.zoneHint(1, 'ZONE ONE HINT');
  const queued = t.queue.some((q) => q.id === 'zone:1');
  g.level.currentZone = 3;
  t.update(0.1, g, false);
  return { queued, after: t.queue.some((q) => q.id === 'zone:1') };
});
check(zone.queued && !zone.after, `zone hint dropped after leaving the zone (${JSON.stringify(zone)})`);

// 5. Chase tip preempts a lesson.
const chase = await h.eval(() => {
  const g = window.__game;
  const t = g.hud.tutorial;
  t.current = null;
  t.queue.length = 0;
  t.enqueue('crouch', '[C] crouch', { min: 3, max: 12, done: () => false });
  t.idle = 5;
  t.quiet = 5;
  t.update(0.05, g, false);
  const first = t.current?.id;
  g.bus.emit('enemy:alert', { enemy: { id: 'x' }, pos: g.player.position.clone() });
  for (let i = 0; i < 10; i++) t.update(0.05, g, false);
  return { first, now: t.current?.id, crouchSeen: t.seen.has('crouch') };
});
check(chase.first === 'crouch' && chase.now === 'chase' && !chase.crouchSeen, `chase tip cuts a lesson short; the lesson comes back later (${JSON.stringify(chase)})`);

check(h.errors.length === 0, `no console errors (${h.errors.length})`);
problems.push(...h.errors);
await h.close();
console.log(`\nscreenshots in ${out}/`);
if (problems.length) {
  console.log(`\n${problems.length} problem(s):\n` + problems.join('\n'));
  process.exitCode = 1;
} else console.log('ux edge cases passed');
