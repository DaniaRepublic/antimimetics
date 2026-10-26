// Shared Playwright harness for headless checks of the built game (WebGL via SwiftShader).
//
//   import { launch } from './harness.mjs';
//   const h = await launch({ html: 'dist/index.html', query: 'autostart&god' });
//   await h.page.evaluate(() => window.__game.simulate(5));
//   await h.shot('/path/out.png');
//   console.log(h.errors);
//   await h.close();
//
// Options: iframe: 'allow-scripts' loads the game inside <iframe sandbox="allow-scripts"> (no
// pointer lock, no storage) and h.page / h.eval then target that frame; settle: ms of real frames
// to let render after boot (default 500); args: extra Chromium flags.
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';

// Playwright is pre-installed globally (resolved through NODE_PATH), so load it via require.
const { chromium } = createRequire(import.meta.url)('playwright');

export async function launch({
  html = 'dist/index.html', query = 'autostart', width = 1280, height = 720, timeout = 60000, iframe = null, settle = 500,
  args = [],
} = {}) {
  const browser = await chromium.launch({
    args: [
      '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader',
      '--ignore-gpu-blocklist',
      '--autoplay-policy=no-user-gesture-required',
      '--allow-file-access-from-files', // lets a file:// wrapper page frame the game (iframe mode)
      ...args,
    ],
  });
  const top = await browser.newPage({ viewport: { width, height } });
  const errors = [];
  const logs = [];
  top.on('console', (msg) => {
    const line = `[${msg.type()}] ${msg.text()}`;
    logs.push(line);
    if (msg.type() === 'error') errors.push(line);
  });
  top.on('pageerror', (err) => errors.push(`[pageerror] ${err.message}\n${err.stack || ''}`));
  const url = 'file://' + path.resolve(html) + (query ? `?${query}` : '');
  let target = top;
  if (iframe) {
    // A wrapper page next to the game so the frame loads it as a sibling file.
    const wrapper = path.join(path.dirname(path.resolve(html)), '.harness-frame.html');
    const sandbox = iframe === true ? 'allow-scripts' : String(iframe);
    fs.writeFileSync(wrapper, `<!doctype html><meta charset="utf-8"><style>html,body{margin:0;height:100%;background:#000}iframe{border:0;width:100%;height:100%;display:block}</style>
<iframe id="game" sandbox="${sandbox}" src="${path.basename(html)}${query ? `?${query}` : ''}"></iframe>`);
    await top.goto('file://' + wrapper);
    const handle = await top.waitForSelector('#game');
    target = await handle.contentFrame();
  } else {
    await top.goto(url);
  }
  await target.waitForFunction(() => !!window.__game || !!window.__gameError, null, { timeout, polling: 100 });
  const bootError = await target.evaluate(() => window.__gameError || null);
  if (bootError) errors.push(`[boot] ${bootError}`);
  // Let a few real frames render (shader compilation etc).
  await top.waitForTimeout(settle);

  const shot = async (file) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // Two rAFs so any camera change made by the caller is rendered.
    await target.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    await top.screenshot({ path: file, timeout: 180000 });
    return file;
  };

  // Point the camera somewhere for a screenshot: cam([x,y,z],[tx,ty,tz]); cam(null) restores the player view.
  const cam = (pos, target_) => target.evaluate(([p, t]) => {
    window.__game.debugCamera = p ? { pos: p, target: t } : null;
  }, [pos, target_]);

  return {
    browser, page: target, top, errors, logs, shot, cam, bootError,
    eval: (fn, arg) => target.evaluate(fn, arg),
    close: () => browser.close(),
  };
}
