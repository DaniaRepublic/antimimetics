# When It Calls

A small first-person stealth-horror proof of concept inspired by the dead-city imagery of qntm's
*There Is No Antimemetics Division*. A fan work: all text, art and sound are original.

The city has been taken. Caped snatchers wearing what is left of its people walk the red-misted
streets. They don't run. Above the rooftops something enormous walks on stilt legs, and when it
calls, everything stops to listen. Get to the bridge. Don't be seen.

## Play

- **Open `docs/index.html`** in a desktop browser (Chrome, Edge, Firefox, Safari). It is one
  self-contained file: no install, no network, all meshes/textures/sounds generated in code.
- Or build it yourself: `npm install && npm run build` → `dist/index.html`.
- Headphones recommended. A run takes about 8–12 minutes.

| Key | Action |
|---|---|
| WASD / arrows | move |
| Mouse | look (click to capture the mouse; drag to look where capture is unavailable) |
| C | crouch (toggle) — quiet and hard to see |
| Shift | sprint — fast, loud, limited stamina |
| E | pick up / interact (hold to cut the chain) |
| Left click / F | throw a bottle |
| Esc / P | pause (brightness, sensitivity, volume, FOV) |

The rules you can learn: snatchers notice you gradually (watch the ring around the crosshair);
light and noise give you away; bottles and car alarms pull them away; and when the Leviathan
calls, every snatcher freezes and looks up. Five zones, a checkpoint at each.

URL options: `?quality=0|1|2` (post-processing; it also steps down automatically on slow GPUs),
`?debug` (AI states, fps), `?god`, `?cp=N` (start at checkpoint N), `?mute`.

## How it is built

Three.js 0.170 bundled by esbuild into a single HTML file. Everything is procedural: the city
(buildings, facades, props, graffiti), the snatchers (skinned rigs, cloth capes, painted faces),
the Leviathan (IK gait planting its feet on rooftops), the atmosphere (height fog, volumetric mist,
red sky, bloom, film grade) and all audio (WebAudio synthesis with generated reverb).

- `DESIGN.md` — the game design: zones, rules, tone.
- `ARCHITECTURE.md` — module contracts, events, conventions, tooling.
- `src/` — `core/` (collision, jump-point-search navigation, input), `player/`, `world/` (level,
  atmosphere, leviathan), `ai/` (perception, state machine, director, snatcher model), `audio/`, `ui/`.
- `tools/` — headless Playwright checks: `smoke.mjs`, `playtest.mjs` (an input-driving bot that
  plays every zone with careful and careless policies), `playtest-flow.mjs` (death cam, respawn,
  checkpoints, win), `robust-session.mjs` (long-session leak check), and per-module checks.

```
npm run build                      # dist/index.html
npm run smoke -- --query "autostart&quality=0"
node tools/playtest.mjs --zones 1,2,3,4 --runs 5
```
