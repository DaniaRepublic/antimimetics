// HUD check: screenshots every screen and the in-game HUD (fake indicators, hold prompt,
// toasts, ripples...) at desktop and phone sizes, then drives the click flow
// title -> intro -> playing -> paused -> playing -> dead -> playing. Fails on any console error.
//
//   node tools/check-hud.mjs [--no-build] [--out dist/shots/hud] [--only desktop|phone|flow] [--query quality=0]
//
// --query appends URL params to every page (e.g. quality=0 to speed up SwiftShader once the
// real atmosphere is merged; frames of the full scene can take seconds each headless).
import { execSync } from 'node:child_process';
import { launch as rawLaunch } from './harness.mjs';

const args = process.argv.slice(2);
const opt = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
const out = opt('--out', 'dist/shots/hud');
const only = opt('--only', null);
const extra = opt('--query', '');
if (!args.includes('--no-build')) execSync('node build.mjs', { stdio: 'inherit' });

async function launch(o) {
  const h = await rawLaunch({ ...o, query: [o.query, extra].filter(Boolean).join('&'), timeout: 180000 });
  h.page.setDefaultTimeout(180000);
  return h;
}

const VIEWPORTS = [
  { name: 'desktop', width: 1280, height: 720 },
  { name: 'phone', width: 375, height: 812 },
].filter((v) => !only || v.name === only);

const problems = [];
const check = (ok, msg) => {
  if (!ok) problems.push(msg);
  console.log(`${ok ? '  ok ' : 'FAIL '} ${msg}`);
};

// Wait for real frames so CSS transitions settle (slow SwiftShader frames can leave a 0.2 s
// transition mid-way after a fixed wait, which shows up as ghost UI in the screenshot).
async function settle(h, ms = 900) {
  await h.page.waitForTimeout(ms);
  await h.page.waitForFunction(
    () => !document.getAnimations().some((a) => a instanceof CSSTransition && a.playState === 'running'),
    null, { timeout: 15000 },
  ).catch(() => {});
}

async function screens(vp) {
  const h = await launch({ html: 'dist/index.html', query: 'mute', width: vp.width, height: vp.height });
  const shot = (name) => h.shot(`${out}/${vp.name}-${name}.png`);
  console.log(`\n[${vp.name} ${vp.width}x${vp.height}]`);

  await settle(h, 1200);
  await shot('01-title');
  check(await h.eval(() => window.__game.state === 'title'), 'boots into title');
  await h.eval(() => window.__game.scene.background?.setHex?.(0xb4401f));
  await shot('01b-title-bright');
  await h.eval(() => window.__game.scene.background?.setHex?.(0x3a0d08));

  await h.eval(() => {
    const g = window.__game;
    g.setState('intro');
    g.simulate(8);
  });
  await settle(h);
  await shot('02-intro-typing');
  await h.eval(() => window.__game.simulate(22));
  await settle(h, 700);
  await shot('03-intro-done');
  check(await h.eval(() => window.__game.state === 'intro'), 'intro waits for a click when the mouse is not locked');

  // In-game HUD with fake detection indicators.
  await h.eval(() => {
    const g = window.__game;
    g.setState('playing');
    g.player.bottles = 2;
    window.__fakes = [
      { enemy: { id: 'fa' }, detection: 0.3, bearing: 0.55, state: 'suspicious', distance: 15 },
      { enemy: { id: 'fb' }, detection: 0.88, bearing: -1.25, state: 'investigate', distance: 9 },
      { enemy: { id: 'fc' }, detection: 1, bearing: 2.75, state: 'chase', distance: 6 },
      { enemy: { id: 'fd' }, detection: 0.05, bearing: -0.2, state: 'search', distance: 18 },
    ];
    g.director.getIndicators = () => window.__fakes;
    g.simulate(1.0);
  });
  await settle(h, 700);
  await shot('04-hud-indicators');

  // Busy frame: zone card, message toast, hold prompt, footstep ripple, stamina, checkpoint.
  await h.eval(() => {
    const g = window.__game;
    window.__fakes = window.__fakes.filter((f) => f.state !== 'chase');
    // One behind the player: its arc sits just above the message toast and must not cross it.
    window.__fakes.push({ enemy: { id: 'fe' }, detection: 0.9, bearing: 3.05, state: 'investigate', distance: 7 });
    const p = g.player;
    const fwd = p.forward(p.position.clone()).setY(0).normalize();
    g.level.interactables.push({
      id: 'test-gate', pos: p.position.clone().addScaledVector(fwd, 1.2), prompt: 'E — cut the chain', holdTime: 8,
      enabled: true, onInteract() {},
    });
    g.bus.emit('zone:enter', {
      index: 1,
      zone: { name: 'Main Street', objective: 'Stay low behind the wrecks. Keep out of the light.', hint: 'Keep the wrecks between you and them.' },
    });
    g.bus.emit('level:message', { text: 'WHEN IT CALLS THEY LISTEN. Move while it calls; stand still when it stops.', duration: 10 });
    g.bus.emit('game:checkpoint', { checkpoint: { id: 'test' } });
    g.input.keys.add('KeyE');
    g.simulate(2.2);
    p.stamina = 0.45;
    g.bus.emit('player:footstep', { mode: 'sprint', pos: p.position.clone() });
    g.bus.emit('player:footstep', { mode: 'walk', pos: p.position.clone() });
    g.simulate(0.25);
  });
  await shot('05-hud-busy');
  const hold = await h.eval(() => window.__game.player.holdProgress);
  check(hold > 0.1 && hold < 1, `hold progress drives the ring (${hold.toFixed(2)})`);

  // Same frame over a bright red sky: text must stay legible.
  await h.eval(() => {
    const g = window.__game;
    g.debugCamera = { pos: [0, 1.6, 0], target: [0, 12, -60] };
    g.scene.background?.setHex?.(0xb4401f);
    g.scene.fog?.color?.setHex?.(0xa53a1e);
  });
  await shot('05b-hud-bright');
  await h.eval(() => {
    const g = window.__game;
    g.debugCamera = null;
    g.scene.background?.setHex?.(0x3a0d08);
    g.scene.fog?.color?.setHex?.(0x3a0d08);
  });

  // JS cost of one HUD frame with four live indicators.
  const cost = await h.eval(() => {
    const g = window.__game;
    const t0 = performance.now();
    for (let i = 0; i < 600; i++) g.hud.update(1 / 60);
    return (performance.now() - t0) / 600;
  });
  console.log(`  ..  hud.update ≈ ${cost.toFixed(3)} ms/frame with indicators`);
  check(cost < 1, 'hud.update stays well under 1 ms');

  // Lit eye + chase glow + tutorial hint, no prompt.
  await h.eval(() => {
    const g = window.__game;
    g.input.keys.delete('KeyE');
    g.level.interactables.length = 0;
    window.__fakes = [{ enemy: { id: 'fc' }, detection: 1, bearing: -2.4, state: 'chase', distance: 5 }];
    g.atmosphere.lightLevelAt = () => 0.85;
    g.simulate(7);
    g.player.stamina = 0.08;
    g.player.exhausted = true;
  });
  await settle(h, 400);
  await shot('06-hud-lit-chase');
  check(await h.eval(() => getComputedStyle(document.querySelector('.wic-hold')).opacity === '0'), 'hold ring hidden without focus');

  // Pointer-lock fallback notice, calm HUD.
  await h.eval(() => {
    const g = window.__game;
    window.__fakes = [];
    g.atmosphere.lightLevelAt = () => 0.15;
    g.input.pointerLockFailed = true;
    g.player.bottles = 0;
    g.simulate(4);
  });
  await settle(h, 400);
  await shot('07-hud-lock-notice');

  const disabledAtPause = await h.eval(() => {
    const g = window.__game;
    g.setState('paused');
    g.tick(0.1);
    return document.querySelector('.wic-pause .wic-btn').disabled;
  });
  check(disabledAtPause, 'resume is briefly disabled after pausing');
  await settle(h);
  await shot('08-paused');
  await h.eval(() => window.__game.simulate(1.5));
  await h.page.hover('.wic-pause .wic-btn');
  await settle(h, 400);
  await shot('08b-paused-ready');

  await h.eval(() => {
    const g = window.__game;
    g.setState('playing');
    g.caughtBy = g.director.snatchers[0] || null;
    g.setState('caught');
    g.simulate(1);
  });
  await settle(h, 1100);
  await shot('09-caught');
  await h.eval(() => window.__game.simulate(3.5));
  await settle(h, 2600);
  await shot('10-dead');
  check(await h.eval(() => window.__game.state === 'dead'), 'caught -> dead');

  await h.eval(() => {
    const g = window.__game;
    g.stats.playTime = 463.4;
    g.stats.spotted = 4;
    g.stats.deaths = 2;
    g.setState('playing');
    g.setState('won');
    g.simulate(6);
  });
  await settle(h, 1800);
  await shot('11-won-typing');
  await h.eval(() => window.__game.simulate(14));
  await settle(h, 2600);
  await shot('12-won-done');

  check(h.errors.length === 0, `no console errors (${h.errors.length})`);
  problems.push(...h.errors);
  await h.close();
}

async function debugOverlay(vp) {
  const h = await launch({ html: 'dist/index.html', query: 'autostart&debug&mute', width: vp.width, height: vp.height });
  await h.eval(() => window.__game.simulate(2));
  await settle(h, 600);
  await h.shot(`${out}/${vp.name}-13-debug.png`);
  check(await h.eval(() => /fps/.test(document.querySelector('.wic-debug')?.textContent || '')), 'debug overlay renders');
  check(h.errors.length === 0, `debug: no console errors (${h.errors.length})`);
  problems.push(...h.errors);
  await h.close();
}

// Real clicks/keys through the state machine.
async function flow() {
  console.log('\n[flow]');
  const h = await launch({ html: 'dist/index.html', query: 'mute', width: 1280, height: 720 });
  const state = () => h.eval(() => window.__game.state);
  const waitStateTime = (s) => h.page.waitForFunction((t) => window.__game.stateTime > t, s, { timeout: 300000 });
  await waitStateTime(0.3);
  await h.page.mouse.click(640, 360);
  check((await state()) === 'title' && (await h.eval(() => window.__game.hud.screens.title.calibrating)), 'first title click -> brightness check');
  await h.page.keyboard.press('ArrowRight');
  const bright = await h.eval(() => window.__game.settings.brightness);
  check(Math.abs(bright - 1.05) < 1e-6, `arrow key nudges brightness (${bright})`);
  await h.page.keyboard.press('ArrowLeft');
  await h.page.keyboard.press('Enter');
  check((await state()) === 'intro', 'enter on the brightness check -> intro');
  await waitStateTime(0.6);
  await h.page.keyboard.press('Space');
  check((await state()) === 'playing', 'space skips intro -> playing');
  await h.eval(() => window.__game.pause());
  check((await state()) === 'paused', 'pause');
  await h.page.mouse.click(1000, 360);
  check((await state()) === 'paused', 'clicking the backdrop does not resume');
  await waitStateTime(1.25);
  // The input layer cancels arrow keys at window level; a focused slider must still take them.
  const fov0 = await h.eval(() => window.__game.settings.fov);
  await h.page.focus('.wic-pause .wic-slider:nth-of-type(4) .wic-range');
  await h.page.keyboard.press('ArrowRight');
  const fov1 = await h.eval(() => window.__game.settings.fov);
  check(fov1 === Math.min(95, fov0 + 1), `arrow keys adjust a focused slider (fov ${fov0} -> ${fov1})`);
  await h.page.click('.wic-pause .wic-btn');
  check((await state()) === 'playing', 'resume button -> playing');
  check(await h.eval(() => !document.querySelector('.wic-pause').contains(document.activeElement)), 'no pause control keeps focus after resuming');
  await h.eval(() => {
    const g = window.__game;
    g.caughtBy = g.director.snatchers[0] || null;
    g.setState('caught');
    g.simulate(2.8); // (not real frames: a loaded machine can drop to a frame every few seconds)
  });
  check((await state()) === 'dead', 'caught -> dead');
  // A click the moment the dead screen comes up (dispatched in the same task, so slow headless
  // frames can't make it "late") must not skip it.
  const early = await h.eval(() => {
    const g = window.__game;
    // (through 'caught' so the dead screen is shown afresh: re-entering the same state is a
    // no-op for the HUD, and its real-time clock would still count from the simulated entry)
    g.setState('caught');
    g.setState('dead');
    window.dispatchEvent(new MouseEvent('click', { button: 0 }));
    return g.state;
  });
  check(early === 'dead', 'retry ignores an immediate click');
  await h.eval(() => window.__game.simulate(1.2));
  await h.page.keyboard.press('Enter');
  check((await state()) === 'playing', 'enter on dead screen -> respawn');
  const canvasHit = await h.eval(() => document.elementFromPoint(640, 360) === window.__game.renderer.domElement);
  check(canvasHit, 'clicks at the crosshair reach the canvas while playing');
  check(h.errors.length === 0, `flow: no console errors (${h.errors.length})`);
  problems.push(...h.errors);
  await h.close();
}

// Tutorial pacing: hints wait for level messages and skip what the player already did.
async function tutorial() {
  console.log('\n[tutorial]');
  const h = await launch({ html: 'dist/index.html', query: 'mute', width: 1280, height: 720 });
  const tut = () => h.eval(() => {
    const el = document.querySelector('.wic-tut');
    return { text: el.textContent, op: Number(el.style.opacity || 0) };
  });
  // Shown hint texts while simulating `seconds`.
  const watch = (seconds) => h.eval((s) => {
    const g = window.__game;
    const texts = new Set();
    for (let t = 0; t < s; t += 0.25) {
      g.simulate(0.25);
      const el = document.querySelector('.wic-tut');
      if (Number(el.style.opacity || 0) > 0.3) texts.add(el.textContent);
    }
    return [...texts];
  }, seconds);
  await h.eval(() => {
    const g = window.__game;
    // Keep the real level's own triggers (graffiti messages, zone cards) out of this timing test.
    g.level.update = () => {};
    g.setState('playing');
    g.player.bottles = 0;
    g.bus.emit('level:message', { text: 'SOMETHING IS WRITTEN ON THE WALL', duration: 3 });
  });
  let shown = await watch(3.5);
  check(shown.length === 0, `no tutorial hint while a level message is on screen (${shown.join(' | ') || '-'})`);
  await h.eval(() => window.__game.simulate(4.5));
  let t = await tut();
  check(/move/.test(t.text) && t.op > 0.5, `move hint follows once the message is gone (${t.text})`);
  // The player walks and crouches before the crouch hint's turn: it is skipped, throw comes next.
  await h.eval(() => {
    const g = window.__game;
    g.teleport(0, -8, 0);
    g.player.crouched = true;
    g.simulate(0.2);
    g.player.crouched = false;
    g.player.bottles = 1;
  });
  shown = await watch(14);
  check(!shown.some((s) => /crouch/.test(s)), `crouch hint skipped once the player has crouched (${shown.join(' | ')})`);
  check(shown.some((s) => /throw/.test(s)), 'throw hint shown when holding a bottle');
  // Zone card: steps aside when the player is spotted, never ghosts back after a respawn.
  const card = () => h.eval(() => Number(document.querySelector('.wic-zone').style.opacity || 0));
  await h.eval(() => {
    const g = window.__game;
    g.bus.emit('zone:enter', { index: 1, zone: { name: 'Main Street', objective: 'Get up the street.' } });
    g.simulate(2);
  });
  const before = await card();
  await h.eval(() => {
    const g = window.__game;
    g.bus.emit('enemy:alert', { enemy: { id: 'x' }, pos: g.player.position.clone() });
    g.simulate(0.7);
  });
  const after = await card();
  check(before > 0.9 && after === 0, `zone card dismissed when spotted (${before} -> ${after})`);
  await h.eval(() => {
    const g = window.__game;
    g.bus.emit('zone:enter', { index: 2, zone: { name: 'The Plaza' } });
    g.simulate(6);
    g.bus.emit('game:respawn', { checkpoint: g.checkpoint });
    g.simulate(0.5);
  });
  check((await card()) === 0, 'zone card hidden on respawn');
  check(h.errors.length === 0, `tutorial: no console errors (${h.errors.length})`);
  problems.push(...h.errors);
  await h.close();
}

for (const vp of VIEWPORTS) {
  await screens(vp);
  await debugOverlay(vp);
}
if (!only || only === 'flow') {
  await flow();
  await tutorial();
}

console.log(`\nscreenshots in ${out}/`);
if (problems.length) {
  console.log(`\n${problems.length} problem(s):\n` + problems.join('\n'));
  process.exitCode = 1;
} else console.log('all HUD checks passed');
