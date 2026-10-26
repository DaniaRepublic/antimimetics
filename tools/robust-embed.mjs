// Robustness checks of the built page in hostile environments (headless Chromium):
//   1. sandboxed iframe (sandbox="allow-scripts": no pointer lock, no storage): boots, the title ->
//      intro -> playing flow works with real clicks, drag-to-look and keyboard movement work;
//   2. WebGL context loss / restore: the game pauses behind a notice, then renders again;
//   3. a system that throws every frame does not freeze the game (and is reported);
//   4. a post-processing chain that keeps failing falls back to plain rendering;
//   5. no WebGL at all: a readable message instead of an endless LOADING;
//   6. an embed that starts at 0 x 0 (hidden) and is shown later.
//   node tools/robust-embed.mjs [--html dist/index.html] [--shots dir]
import path from 'node:path';
import { launch } from './harness.mjs';

const args = process.argv.slice(2);
const opt = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
const html = opt('--html', 'dist/index.html');
const shots = opt('--shots', null);
let failures = 0;
const check = (ok, msg, extra = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}${extra ? `  ${extra}` : ''}`);
  if (!ok) failures++;
};
const realErrors = (h, allow = []) => h.errors.filter((e) => !allow.some((re) => re.test(e)));

// --- 1. sandboxed iframe -----------------------------------------------------------------------
{
  const h = await launch({ html, query: 'quality=0&mute', iframe: 'allow-scripts', pointerLock: true });
  const g0 = await h.eval(() => ({ state: window.__game.state, origin: window.origin, storage: (() => {
    try {
      return typeof window.localStorage.getItem('x');
    } catch (e) {
      return `throws ${e.name}`;
    }
  })() }));
  check(g0.state === 'title', 'iframe: boots to the title screen', JSON.stringify(g0));
  // Title -> intro with a real click (the frame fills the viewport). The screens ignore clicks for
  // their first fraction of a second of game time (slow headless frames: wait for it).
  await h.page.waitForFunction(() => window.__game.stateTime > 0.35, null, { timeout: 60000, polling: 100 });
  await h.top.mouse.click(640, 360);
  await h.top.waitForTimeout(400);
  let st = await h.eval(() => ({ state: window.__game.state, failed: window.__game.input.pointerLockFailed, locked: window.__game.input.locked }));
  check(st.state === 'intro', 'iframe: click on the title begins', JSON.stringify(st));
  check(st.failed && !st.locked, 'iframe: pointer lock refused -> drag-to-look mode', JSON.stringify(st));
  await h.page.waitForFunction(() => window.__game.stateTime > 0.6, null, { timeout: 60000, polling: 100 });
  await h.top.mouse.click(640, 360);
  await h.top.waitForTimeout(400);
  st = await h.eval(() => window.__game.state);
  check(st === 'playing', 'iframe: click skips the intro', st);
  // Drag to look.
  const yaw0 = await h.eval(() => window.__game.player.yaw);
  await h.top.mouse.move(640, 360);
  await h.top.mouse.down();
  for (let i = 1; i <= 8; i++) {
    await h.top.mouse.move(640 - i * 20, 360);
    await h.top.waitForTimeout(60);
  }
  await h.top.mouse.up();
  await h.top.waitForTimeout(200);
  const yaw1 = await h.eval(() => window.__game.player.yaw);
  check(Math.abs(yaw1 - yaw0) > 0.05, 'iframe: dragging turns the view', `${yaw0.toFixed(3)} -> ${yaw1.toFixed(3)}`);
  // Keyboard reaches the frame after the click.
  const z0 = await h.eval(() => window.__game.player.position.z);
  await h.top.keyboard.down('KeyW');
  const f0 = await h.eval(() => window.__game.frames);
  await h.page.waitForFunction((f0) => window.__game.frames > f0 + 10, f0, { timeout: 60000, polling: 100 });
  await h.top.keyboard.up('KeyW');
  const z1 = await h.eval(() => window.__game.player.position.z);
  const moved = await h.eval(() => window.__game.state);
  check(Math.abs(z1 - z0) > 0.1, 'iframe: W moves the player', `${z0.toFixed(2)} -> ${z1.toFixed(2)} (${moved})`);
  // Settings survive without storage.
  const saved = await h.eval(() => {
    const g = window.__game;
    g.settings.fov = 80;
    g.saveSettings();
    return g.settings.fov;
  });
  check(saved === 80, 'iframe: saving settings without storage is harmless');
  if (shots) await h.shot(path.join(shots, 'embed-iframe.png'));
  // Chrome itself logs one error for the first (refused) lock request; the game must not keep asking.
  const blocked = h.errors.filter((e) => /frame is sandboxed/.test(e)).length;
  check(blocked <= 2, 'iframe: pointer lock is requested once, not on every click', `${blocked} sandbox messages`);
  const errs = realErrors(h, [/frame is sandboxed/]);
  check(!errs.length, 'iframe: no other console errors', errs.join(' | '));
  await h.close();
}

// --- 2. WebGL context loss and restore -------------------------------------------------------------
{
  const h = await launch({ html, query: 'autostart&quality=0&mute' });
  const lost = await h.eval(async () => {
    const g = window.__game;
    const ext = g.renderer.getContext().getExtension('WEBGL_lose_context');
    if (!ext) return { ext: false };
    window.__ext = ext;
    ext.loseContext();
    await new Promise((r) => setTimeout(r, 300));
    return { ext: true, state: g.state, lost: g.contextLost, notice: !!document.getElementById('wic-notice'), text: document.getElementById('wic-notice')?.textContent.slice(0, 60) };
  });
  check(lost.ext, 'context: WEBGL_lose_context available');
  if (lost.ext) {
    check(lost.state === 'paused' && lost.lost && lost.notice, 'context: lost -> paused behind a notice', JSON.stringify(lost));
    const resumeBlocked = await h.eval(() => window.__game.resume());
    check(resumeBlocked === false, 'context: cannot resume while the picture is gone');
    const back = await h.eval(async () => {
      const g = window.__game;
      window.__ext.restoreContext();
      await new Promise((r) => setTimeout(r, 500));
      const out = { lost: g.contextLost, notice: !!document.getElementById('wic-notice') };
      out.resumed = g.resume();
      const f0 = g.frames;
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(r))));
      out.frames = g.frames - f0;
      out.calls = g.renderer.info.render.calls;
      out.errors = g.errorLog.length;
      return out;
    });
    check(!back.lost && !back.notice && back.resumed && back.frames > 0 && back.calls > 20, 'context: restored -> notice gone, resumes and draws', JSON.stringify(back));
    if (shots) await h.shot(path.join(shots, 'embed-context-restored.png'));
  }
  const errs = realErrors(h, [/CONTEXT_LOST_WEBGL/i, /context lost/i]);
  check(!errs.length, 'context: no unexpected console errors', errs.slice(0, 3).join(' | '));
  await h.close();
}

// --- 3. a system that throws every frame -----------------------------------------------------------
{
  const h = await launch({ html, query: 'autostart&quality=0&mute' });
  const r = await h.eval(async () => {
    const g = window.__game;
    g.leviathan.update = () => {
      throw new Error('injected leviathan failure');
    };
    const t0 = g.time, p0 = g.player.position.z, f0 = g.frames;
    g.input.keys.add('KeyW');
    g.simulate(1);
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    g.input.keys.delete('KeyW');
    return { dt: g.time - t0, moved: Math.abs(g.player.position.z - p0), frames: g.frames - f0, log: g.errorLog.map((e) => `${e.source}:${e.count}`) };
  });
  check(r.dt > 0.9 && r.moved > 1 && r.frames >= 2, 'throwing system: the rest of the game keeps running', JSON.stringify(r));
  check(r.log.some((s) => s.startsWith('leviathan:')), 'throwing system: reported in game.errorLog');
  const logged = h.errors.filter((e) => /injected leviathan failure/.test(e)).length;
  check(logged >= 1 && logged <= 4, 'throwing system: logged a few times, not every frame', `${logged} console errors`);
  await h.close();
}

// --- 4. post-processing keeps failing -> plain render ------------------------------------------------
{
  const h = await launch({ html, query: 'autostart&quality=0&mute' });
  const r = await h.eval(async () => {
    const g = window.__game;
    g.atmosphere.render = () => {
      throw new Error('injected post failure');
    };
    for (let i = 0; i < 20; i++) await new Promise((r) => requestAnimationFrame(r));
    return { fallback: g.renderFallback, calls: g.renderer.info.render.calls, state: g.state };
  });
  check(r.fallback && r.calls > 0 && r.state === 'playing', 'render failure: falls back to the plain scene', JSON.stringify(r));
  if (shots) await h.shot(path.join(shots, 'embed-render-fallback.png'));
  await h.close();
}

// --- 5. no WebGL ------------------------------------------------------------------------------------
{
  const { createRequire } = await import('node:module');
  const { chromium } = createRequire(import.meta.url)('playwright');
  const browser = await chromium.launch({ args: ['--disable-gpu', '--disable-webgl', '--disable-3d-apis'] });
  const page = await browser.newPage();
  const logs = [];
  page.on('console', (m) => logs.push(m.text()));
  await page.goto('file://' + path.resolve(html) + '?quality=0');
  const r = await page.waitForFunction(() => window.__gameError || window.__game, null, { timeout: 30000 }).then(() => page.evaluate(() => ({
    error: !!window.__gameError,
    notice: document.getElementById('wic-notice')?.textContent || '',
    boot: !!document.getElementById('boot'),
  })));
  check(r.error && /WebGL/.test(r.notice) && !r.boot, 'no WebGL: explains instead of LOADING forever', r.notice.slice(0, 80));
  await browser.close();
}

// --- 6. boots hidden at 0 x 0, shown later; and shrinks to 0 x 0 while running ----------------------
{
  const h = await launch({
    html, query: 'autostart&quality=0&mute', width: 1280, height: 720, iframe: 'allow-scripts', settle: 300,
    frameStyle: 'width:0;height:0',
  });
  const hidden = await h.eval(() => {
    const g = window.__game;
    return { aspect: g.camera.aspect, w: g.renderer.domElement.width, finite: Number.isFinite(g.camera.projectionMatrix.elements[0]) };
  });
  check(hidden.finite && hidden.aspect > 0, 'hidden embed: boots at 0 x 0 with a finite projection', JSON.stringify(hidden));
  const size = () => h.eval(() => {
    const g = window.__game;
    return { aspect: g.camera.aspect, w: g.renderer.domElement.width, h: g.renderer.domElement.height, finite: Number.isFinite(g.camera.projectionMatrix.elements[0]), frames: g.frames };
  });
  const show = async (on) => {
    await h.top.evaluate((on) => {
      const f = document.getElementById('game');
      f.style.width = on ? '100%' : '0px';
      f.style.height = on ? '100%' : '0px';
    }, on);
    // a few real frames so the coalesced resize is applied
    await h.page.waitForFunction(() => (window.__f0 ??= window.__game.frames) + 3 <= window.__game.frames, null, { timeout: 120000, polling: 100 });
    await h.eval(() => delete window.__f0);
  };
  await show(true);
  let r = await size();
  check(r.finite && r.w > 100 && Math.abs(r.aspect - 1280 / 720) < 0.01, 'hidden embed: resizes correctly once shown', JSON.stringify(r));
  await h.top.evaluate(async () => {
    const f = document.getElementById('game');
    f.style.width = '0px';
    f.style.height = '0px';
    await new Promise((res) => setTimeout(res, 400));
  });
  await show(true);
  r = await size();
  check(r.finite && r.w > 100 && Math.abs(r.aspect - 1280 / 720) < 0.01, 'hidden embed: survives shrinking to 0 x 0 and back', JSON.stringify(r));
  const errs = realErrors(h);
  check(!errs.length, 'hidden embed: no console errors', errs.slice(0, 3).join(' | '));
  await h.close();
}

// --- 7. state machine under failure: no playing blind, respawn survives a failing reset -------------
{
  const h = await launch({ html, query: 'quality=0&mute' });
  const r = await h.eval(async () => {
    const g = window.__game;
    g.stop();
    const out = {};
    const ext = g.renderer.getContext().getExtension('WEBGL_lose_context');
    // Enter on the dead screen while the picture is gone must not start play behind the notice.
    g.startPlaying();
    g.bus.emit('player:caught', { enemy: g.director.snatchers[0] });
    g.simulate(3);
    ext.loseContext();
    await new Promise((res) => setTimeout(res, 200));
    g.simulate(1.5);
    out.before = g.state;
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Enter', key: 'Enter' }));
    g.simulate(0.2);
    out.afterEnter = g.state;
    ext.restoreContext();
    await new Promise((res) => setTimeout(res, 300));
    out.resumed = g.resume();
    // A reset that throws must not strand the player on the dead screen.
    const reset = g.director.reset;
    g.director.reset = () => {
      throw new Error('injected reset failure');
    };
    g.bus.emit('player:caught', { enemy: g.director.snatchers[0] });
    g.simulate(3);
    out.dead = g.state;
    out.respawned = g.respawn();
    out.afterRespawn = g.state;
    g.director.reset = reset;
    out.log = g.errorLog.map((e) => e.source);
    return out;
  });
  check(r.before === 'dead' && r.afterEnter === 'paused' && r.resumed, 'context lost on the dead screen: Enter respawns into pause, not blind play', JSON.stringify(r));
  check(r.dead === 'dead' && r.respawned && r.afterRespawn === 'playing' && r.log.includes('respawn:director'), 'respawn: a throwing reset is reported, the player still respawns', JSON.stringify(r));
  await h.close();
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall embed/robustness checks passed');
process.exitCode = failures ? 1 : 0;
