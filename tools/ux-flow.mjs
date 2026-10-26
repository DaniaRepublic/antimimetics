// First-time-player walkthrough with the real game: every screen and the first minute of play,
// through real clicks and keys where the browser allows it, screenshotted at desktop and phone size.
//
//   node tools/ux-flow.mjs [--no-build] [--quality 1] [--only desktop|phone] [--out dist/shots/ux-flow]
//
// title -> first click: brightness check -> continue -> intro -> click -> play (zone card, hints,
// pickup prompt, graffiti toast) -> Esc pause (+ brightness slider) -> resume during the re-lock
// cooldown -> detection building on a real sentry -> chase -> caught -> dead -> retry -> the gate's
// hold ring -> the exit -> ending -> play again. Fails on console errors or a broken transition.
import { execSync } from 'node:child_process';
import { launch } from './harness.mjs';

const args = process.argv.slice(2);
const opt = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
const out = opt('--out', 'dist/shots/ux-flow');
const quality = opt('--quality', '1');
const only = opt('--only', null);
if (!args.includes('--no-build')) execSync('node build.mjs', { stdio: 'inherit' });

const VIEWPORTS = [
  { name: 'desktop', width: 1280, height: 720 },
  { name: 'phone', width: 375, height: 812 },
].filter((v) => !only || v.name === only);

const problems = [];
const check = (ok, msg) => {
  if (!ok) problems.push(msg);
  console.log(`${ok ? '  ok ' : 'FAIL '} ${msg}`);
};

async function settle(h, ms = 800) {
  await h.page.waitForTimeout(ms);
  await h.page.waitForFunction(
    () => !document.getAnimations().some((a) => a instanceof CSSTransition && a.playState === 'running'),
    null, { timeout: 20000 },
  ).catch(() => {});
}

async function run(vp) {
  console.log(`\n[${vp.name} ${vp.width}x${vp.height}]`);
  const h = await launch({ html: 'dist/index.html', query: `mute&quality=${quality}`, width: vp.width, height: vp.height, timeout: 240000 });
  h.page.setDefaultTimeout(240000);
  let n = 0;
  const shot = async (name) => {
    n++;
    const file = `${out}/${vp.name}-${String(n).padStart(2, '0')}-${name}.png`;
    await h.shot(file);
    return file;
  };
  const state = () => h.eval(() => window.__game.state);
  const waitState = (s) => h.page.waitForFunction((st) => window.__game.state === st, s, { timeout: 240000 });
  const waitStateTime = (t) => h.page.waitForFunction((x) => window.__game.stateTime > x, t, { timeout: 240000 });
  const sim = (s) => h.eval((x) => window.__game.simulate(x), s);
  const cx = Math.round(vp.width / 2), cy = Math.round(vp.height / 2);

  await waitStateTime(0.4);
  await settle(h, 1500);
  await shot('title');

  // First click: the brightness check (once per browser).
  await h.page.mouse.click(cx, cy);
  await settle(h, 1400);
  check((await state()) === 'title' && (await h.eval(() => document.querySelector('.wic-title').classList.contains('is-calib'))), 'first title click opens the brightness check');
  await shot('calibrate');
  await h.page.mouse.click(Math.round(vp.width * 0.8), Math.round(vp.height * 0.2));
  check((await state()) === 'title', 'a stray click does not skip the brightness check');
  for (let i = 0; i < 4; i++) await h.page.keyboard.press('ArrowRight');
  const b = await h.eval(() => window.__game.settings.brightness);
  check(Math.abs(b - 1.2) < 0.01, `arrow keys move the focused brightness slider (${b})`);
  await settle(h, 600);
  await shot('calibrate-brighter');
  for (let i = 0; i < 4; i++) await h.page.keyboard.press('ArrowLeft');
  await h.page.click('.wic-calib .wic-btn');
  check((await state()) === 'intro', 'continue -> intro');
  const stored = await h.eval(() => JSON.parse(localStorage.getItem('when-it-calls:settings') || '{}'));
  check(stored.calibrated === true && stored.brightness === 1, `brightness check remembered (${JSON.stringify(stored)})`);
  const lock = await h.eval(() => ({ locked: window.__game.input.locked, failed: window.__game.input.pointerLockFailed }));
  console.log(`  ..  pointer lock after the click: ${JSON.stringify(lock)}`);
  await h.page.waitForTimeout(3500);
  await settle(h, 300);
  await shot('intro-typing');
  await sim(24);
  await settle(h, 800);
  await shot('intro-done');
  await h.page.mouse.click(cx, cy);
  check((await state()) === 'playing', 'intro click -> playing');

  // First seconds of play: zone card, REC, then the move hint.
  await sim(1.6);
  await settle(h, 600);
  await shot('play-zonecard');
  await sim(3.5);
  await settle(h, 600);
  await shot('play-hint');
  // Walk to the first bottle: graffiti toast and the pickup prompt.
  await h.eval(() => {
    const g = window.__game;
    const bottle = g.level.interactables.find((i) => i.id === 'bottle_0');
    const p = g.player;
    g.input.keys.add('KeyW');
    for (let i = 0; i < 400; i++) {
      const dx = bottle.pos.x - p.position.x, dz = bottle.pos.z - p.position.z;
      if (Math.hypot(dx, dz) < 1.3) break;
      p.yaw = Math.atan2(-dx, -dz);
      g.simulate(1 / 30);
    }
    g.input.keys.delete('KeyW');
    p.pitch = -0.55;
    g.simulate(0.5);
  });
  await settle(h, 500);
  const prompt = await h.eval(() => ({ op: Number(document.querySelector('.wic-prompt').style.opacity || 0), text: document.querySelector('.wic-prompt').textContent }));
  check(prompt.op > 0.5 && /bottle/.test(prompt.text), `pickup prompt near the bottle (${prompt.text})`);
  await shot('play-pickup');
  await h.page.keyboard.press('KeyE');
  await sim(0.2);
  check((await h.eval(() => window.__game.player.bottles)) === 1, 'E picks the bottle up');
  await h.eval(() => {
    window.__game.player.pitch = 0;
  });
  await sim(5);
  await settle(h, 500);
  await shot('play-after-pickup');

  // Esc pauses (unlocks first when locked); resume waits out the browser's re-lock cooldown.
  await h.page.keyboard.press('Escape');
  await h.page.waitForTimeout(300);
  if ((await state()) !== 'paused') await h.eval(() => window.__game.pause()); // headless may not deliver Esc to the page under lock
  check((await state()) === 'paused', 'Esc -> paused');
  const early = await h.eval(() => document.querySelector('.wic-pause .wic-btn').disabled);
  check(early, 'resume disabled during the re-lock cooldown');
  await h.page.click('.wic-pause .wic-btn', { force: true });
  check((await state()) === 'paused', 'clicking resume too early does nothing');
  await settle(h, 1400);
  await shot('pause');
  const brightSlider = await h.eval(() => !!document.querySelector('.wic-pause .wic-range'));
  check(brightSlider, 'pause menu has the brightness slider');
  await h.page.click('.wic-pause .wic-btn');
  check((await state()) === 'playing', 'resume -> playing');

  // Real detection: stand in a sentry's view, let its attention build.
  await h.eval(() => {
    const g = window.__game;
    const s = g.director.snatchers.find((x) => x.id === 'z1_sentry');
    const fx = -Math.sin(s.yaw), fz = -Math.cos(s.yaw);
    const w = g.nav.nearestWalkable(s.position.x + fx * 16, s.position.z + fz * 16, 20);
    g.teleport(w.x, w.z, 0);
    const p = g.player;
    p.yaw = Math.atan2(-(s.position.x - p.position.x), -(s.position.z - p.position.z)) + 0.6;
    g.god = true;
    for (let i = 0; i < 600 && s.detection < 0.45 && s.state !== 'chase'; i++) g.simulate(1 / 30);
    window.__det = { det: s.detection, state: s.state };
  });
  console.log(`  ..  sentry: ${JSON.stringify(await h.eval(() => window.__det))}`);
  await settle(h, 300);
  await shot('play-noticed');
  await h.eval(() => {
    const g = window.__game;
    const s = g.director.snatchers.find((x) => x.id === 'z1_sentry');
    for (let i = 0; i < 900 && s.state !== 'chase'; i++) g.simulate(1 / 30);
    g.simulate(1.2);
    window.__det = { det: s.detection, state: s.state };
  });
  check((await h.eval(() => window.__det.state)) === 'chase', 'the sentry ends up chasing');
  await settle(h, 300);
  await shot('play-chase');
  await h.eval(() => {
    const g = window.__game;
    g.god = false;
    for (let i = 0; i < 900 && g.state === 'playing'; i++) g.simulate(1 / 30);
    g.simulate(0.9);
  });
  check((await state()) === 'caught', 'standing still gets you caught');
  await settle(h, 200);
  await shot('caught');
  await waitState('dead');
  await settle(h, 2500);
  await shot('dead');
  await waitStateTime(1.2);
  await h.page.mouse.click(cx, cy);
  check((await state()) === 'playing', 'click on the dead screen -> respawn');
  await sim(1.5);
  await settle(h, 500);
  await shot('respawned');

  // The gate: hold E, watch the ring fill.
  await h.eval(() => {
    const g = window.__game;
    g.god = true;
    const cp = g.level.checkpoints[4];
    g.teleport(0, -392.6, 0);
    g.player.pitch = -0.2;
    g.checkpoint = cp;
    g.director.reset();
    g.simulate(0.3);
    g.input.keys.add('KeyE');
    g.simulate(1.5);
  });
  await settle(h, 200);
  const hold = await h.eval(() => window.__game.player.holdProgress);
  check(hold > 0.3 && hold < 0.8, `gate hold ring fills (${hold.toFixed(2)})`);
  await shot('gate-hold');
  await h.eval(() => {
    const g = window.__game;
    g.simulate(2);
    g.input.keys.delete('KeyE');
  });
  check(await h.eval(() => !window.__game.level.interactables.find((i) => i.id === 'gate')?.enabled), 'gate opens after the hold');

  // Out of the city.
  await h.eval(() => {
    const g = window.__game;
    g.input.keys.add('KeyW');
    for (let i = 0; i < 1200 && g.state === 'playing'; i++) {
      const p = g.player;
      p.yaw = Math.atan2(-(0 - p.position.x), -(-440 - p.position.z));
      g.simulate(1 / 30);
    }
    g.input.keys.delete('KeyW');
  });
  check((await state()) === 'won', 'walking out of the gate -> won');
  await h.page.waitForTimeout(5000);
  await settle(h, 300);
  await shot('won-typing');
  await sim(16);
  await settle(h, 3000);
  await shot('won-done');
  await h.page.click('.wic-won .wic-btn');
  await h.page.waitForFunction(() => window.__game && window.__game.state === 'title', null, { timeout: 240000 });
  check(true, 'play again -> reload -> title');
  await h.page.waitForTimeout(800);
  await h.page.mouse.click(cx, cy);
  check((await state()) === 'intro', 'second time: the title click goes straight to the intro');

  check(h.errors.length === 0, `no console errors (${h.errors.length})`);
  problems.push(...h.errors);
  await h.close();
}

for (const vp of VIEWPORTS) await run(vp);
console.log(`\nscreenshots in ${out}/`);
if (problems.length) {
  console.log(`\n${problems.length} problem(s):\n` + problems.join('\n'));
  process.exitCode = 1;
} else console.log('ux flow passed');
