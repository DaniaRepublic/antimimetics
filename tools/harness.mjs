// Shared Playwright harness for headless checks of the built game (WebGL via SwiftShader).
//
//   import { launch } from './harness.mjs';
//   const h = await launch({ html: 'dist/index.html', query: 'autostart&god' });
//   await h.page.evaluate(() => window.__game.simulate(5));
//   await h.shot('/path/out.png');
//   console.log(h.errors);
//   await h.close();
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';

// Playwright is pre-installed globally (resolved through NODE_PATH), so load it via require.
const { chromium } = createRequire(import.meta.url)('playwright');

export async function launch({ html = 'dist/index.html', query = 'autostart', width = 1280, height = 720, timeout = 60000 } = {}) {
  const browser = await chromium.launch({
    args: [
      '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader',
      '--ignore-gpu-blocklist',
      '--autoplay-policy=no-user-gesture-required',
    ],
  });
  const page = await browser.newPage({ viewport: { width, height } });
  const errors = [];
  const logs = [];
  page.on('console', (msg) => {
    const line = `[${msg.type()}] ${msg.text()}`;
    logs.push(line);
    if (msg.type() === 'error') errors.push(line);
  });
  page.on('pageerror', (err) => errors.push(`[pageerror] ${err.message}\n${err.stack || ''}`));
  const url = 'file://' + path.resolve(html) + (query ? `?${query}` : '');
  await page.goto(url);
  await page.waitForFunction(() => !!window.__game, null, { timeout });
  // Let a few real frames render (shader compilation etc).
  await page.waitForTimeout(500);

  const shot = async (file) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // Two rAFs so any camera change made by the caller is rendered.
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    await page.screenshot({ path: file, timeout: 180000 });
    return file;
  };

  // Point the camera somewhere for a screenshot: cam([x,y,z],[tx,ty,tz]); cam(null) restores the player view.
  const cam = (pos, target) => page.evaluate(([p, t]) => {
    window.__game.debugCamera = p ? { pos: p, target: t } : null;
  }, [pos, target]);

  return {
    browser, page, errors, logs, shot, cam,
    eval: (fn, arg) => page.evaluate(fn, arg),
    close: () => browser.close(),
  };
}
