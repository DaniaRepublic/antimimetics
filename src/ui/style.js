// HUD stylesheet, injected once. Colours live in custom properties on #wic-hud.
// No external fonts: a typewriter stack for narrative text, a mono stack for UI labels.

const CSS = `
#wic-hud {
  --wic-ink: #ecdfd6;
  --wic-ink-rgb: 236, 223, 214;
  --wic-ink-dim: rgba(236, 223, 214, 0.62);
  --wic-ink-faint: rgba(236, 223, 214, 0.34);
  --wic-red: #e0442c;
  --wic-red-rgb: 224, 68, 44;
  --wic-red-deep: #8e140a;
  --wic-night: #060203;
  --wic-night-rgb: 6, 2, 3;
  --wic-mist: #d6ccc7;
  --wic-mist-ink: #1d1416;
  --wic-shadow: 0 0 2px rgba(0, 0, 0, 0.9), 0 1px 12px rgba(0, 0, 0, 0.75);
  --wic-type: "Courier New", Courier, "Nimbus Mono PS", "Courier 10 Pitch", "Liberation Mono", monospace;
  --wic-mono: ui-monospace, "SF Mono", Menlo, Consolas, "Liberation Mono", "DejaVu Sans Mono", monospace;
  position: fixed;
  inset: 0;
  z-index: 10;
  overflow: hidden;
  pointer-events: none;
  color: var(--wic-ink);
  font-family: var(--wic-type);
  font-size: 14px;
  line-height: 1.5;
  -webkit-font-smoothing: antialiased;
  -webkit-user-select: none;
  user-select: none;
}
#wic-hud *, #wic-hud *::before, #wic-hud *::after { box-sizing: border-box; }

/* ---------- shared bits ---------- */
.wic-kbd {
  display: inline-flex; align-items: center; justify-content: center;
  min-width: 1.9em; height: 1.9em; padding: 0 0.5em;
  border: 1px solid rgba(var(--wic-ink-rgb), 0.5); border-radius: 3px;
  background: rgba(var(--wic-night-rgb), 0.45);
  box-shadow: inset 0 -1px 0 rgba(var(--wic-ink-rgb), 0.16);
  color: var(--wic-ink);
  font: 600 10.5px/1 var(--wic-mono); letter-spacing: 0.04em; text-shadow: none;
  vertical-align: middle;
}
.wic-keys { display: inline-flex; align-items: center; gap: 4px; }
.wic-keys__sep { color: var(--wic-ink-faint); margin: 0 1px; }
.wic-word { display: inline-flex; align-items: center; height: 20px; font: 11px/1 var(--wic-mono); letter-spacing: 0.08em; color: var(--wic-ink); }
.wic-tw-rest { visibility: hidden; }
/* The caret is absolutely placed at its inline position so it never changes the wrapping. */
.wic-typing::after {
  content: ''; position: absolute; width: 0.5em; height: 0.95em; margin: 0.32em 0 0 0.1em;
  background: currentColor; opacity: 0.75;
  animation: wic-caret 1s steps(1) infinite;
}
.wic-redact {
  display: inline-block; width: 3.2em; height: 0.9em; vertical-align: -0.08em;
  background: rgba(var(--wic-ink-rgb), 0.28);
}
.wic-rule { width: 56px; height: 1px; background: rgba(var(--wic-ink-rgb), 0.3); }

/* ---------- in-game layer ---------- */
.wic-layer { position: absolute; inset: 0; opacity: 0; transition: opacity 0.6s ease; }
.wic-layer.is-on { opacity: 1; }
#wic-hud[data-state="caught"] .wic-layer { transition-duration: 0.2s; }

.wic-edge {
  position: absolute; inset: 0; opacity: 0;
  background:
    radial-gradient(ellipse 72% 66% at 50% 50%, rgba(140, 8, 0, 0) 40%, rgba(170, 14, 4, 0.45) 72%, rgba(120, 2, 0, 0.92) 100%);
  box-shadow: inset 0 0 90px 10px rgba(200, 20, 6, 0.55);
}
.wic-ring { position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%); }

.wic-cross { position: absolute; left: 50%; top: 50%; width: 0; height: 0; }
.wic-cross__dot {
  position: absolute; left: -2px; top: -2px; width: 4px; height: 4px; border-radius: 50%;
  background: var(--wic-ink); opacity: 0.5; box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.35);
  transition: transform 0.18s ease, opacity 0.18s ease;
}
.wic-cross.is-focus .wic-cross__dot { transform: scale(1.6); opacity: 0.95; }
.wic-hold {
  position: absolute; left: -21px; top: -21px; width: 42px; height: 42px;
  transform: rotate(-90deg); overflow: visible; opacity: 0; transition: opacity 0.2s ease;
}
.wic-hold.is-on { opacity: 1; }
.wic-hold circle { fill: none; }
.wic-hold__track { stroke: rgba(var(--wic-ink-rgb), 0.22); stroke-width: 1.5; }
.wic-hold__bar { stroke: var(--wic-ink); stroke-width: 2; stroke-linecap: round; filter: drop-shadow(0 0 3px rgba(255, 190, 160, 0.6)); }

.wic-prompt {
  position: absolute; left: 50%; top: calc(50% + 36px); transform: translateX(-50%);
  display: flex; align-items: center; gap: 0.7em; white-space: nowrap; opacity: 0;
  font: 13px/1 var(--wic-mono); letter-spacing: 0.08em; color: var(--wic-ink); text-shadow: var(--wic-shadow);
}
.wic-prompt__hold { font-size: 10px; letter-spacing: 0.26em; text-transform: uppercase; color: var(--wic-ink-dim); }

/* visibility eye + noise ripples + stamina */
.wic-eye {
  position: absolute; left: 50%; bottom: 16px; width: 180px; transform: translateX(-50%);
  display: flex; flex-direction: column; align-items: center;
}
.wic-eye__svg { display: block; width: 180px; height: 64px; overflow: visible; }
.wic-eye__glyph { transition: filter 0.4s ease; }
.wic-eye.is-lit .wic-eye__glyph { filter: drop-shadow(0 0 5px rgba(255, 196, 160, 0.85)) drop-shadow(0 0 14px rgba(255, 120, 80, 0.45)); }
.wic-eye__white { fill: rgba(var(--wic-night-rgb), 0.55); }
.wic-eye__lid { fill: none; stroke: var(--wic-ink); stroke-width: 1.4; stroke-linejoin: round; }
.wic-eye__iris { fill: rgba(var(--wic-ink-rgb), 0.16); stroke: var(--wic-ink); stroke-width: 1.1; }
.wic-eye__pupil { fill: var(--wic-ink); }
.wic-eye__lash { stroke: var(--wic-ink); stroke-width: 1.2; stroke-linecap: round; }
.wic-eye__ring { fill: none; stroke: var(--wic-ink); stroke-width: 1; }
.wic-eye__ring.is-breath { stroke: var(--wic-red); }
.wic-stamina { width: 76px; height: 2px; margin-top: 2px; background: rgba(var(--wic-ink-rgb), 0.16); opacity: 0; }
.wic-stamina__fill { width: 100%; height: 100%; background: var(--wic-ink); transform-origin: left center; }
.wic-stamina.is-exhausted .wic-stamina__fill { background: var(--wic-red); box-shadow: 0 0 6px var(--wic-red); }

.wic-bottles {
  position: absolute; right: 24px; bottom: 22px;
  display: flex; align-items: flex-end; gap: 7px; opacity: 0.85;
  font: 15px/1 var(--wic-mono); letter-spacing: 0.06em; color: var(--wic-ink); text-shadow: var(--wic-shadow);
  transform-origin: 100% 100%; transition: opacity 0.4s ease, color 0.2s ease;
}
.wic-bottles__icon { width: 11px; height: 28px; overflow: visible; filter: drop-shadow(0 1px 4px rgba(0, 0, 0, 0.8)); }
.wic-bottles__icon path { fill: rgba(var(--wic-ink-rgb), 0.18); stroke: var(--wic-ink); stroke-width: 1.1; stroke-linejoin: round; }
.wic-bottles__count { padding-bottom: 1px; }
.wic-bottles.is-empty { opacity: 0.32; }
.wic-bottles.is-denied { color: var(--wic-red); opacity: 1; }

/* zone title card */
.wic-zone {
  position: absolute; left: 0; right: 0; top: 13vh; padding: 0 16px;
  text-align: center; opacity: 0; text-shadow: var(--wic-shadow);
}
.wic-zone::before {
  content: ''; position: absolute; left: 50%; top: 50%; width: min(760px, 120vw); height: 260%;
  transform: translate(-50%, -50%); z-index: -1;
  background: radial-gradient(ellipse at center, rgba(var(--wic-night-rgb), 0.55) 0%, rgba(var(--wic-night-rgb), 0) 65%);
}
.wic-zone__index { font: 11px/1 var(--wic-mono); letter-spacing: 0.5em; margin-right: -0.5em; color: var(--wic-ink-dim); }
.wic-zone__name {
  margin: 14px 0 0; font-size: clamp(21px, 3.6vw, 42px); font-weight: 400; line-height: 1.15;
  text-transform: uppercase; white-space: nowrap;
}
.wic-zone__rule { margin: 16px auto 14px; width: 44px; }
.wic-zone__obj {
  max-width: 34em; margin: 0 auto; color: var(--wic-ink-dim);
  font-size: clamp(13px, 1.45vw, 16px); font-style: italic; letter-spacing: 0.04em;
}

/* level messages (graffiti, hints) */
.wic-msg {
  position: absolute; left: 50%; bottom: 25vh; width: min(88vw, 38em);
  transform: translateX(-50%); text-align: center; opacity: 0;
}
.wic-msg::before {
  content: ''; position: absolute; inset: -26px -12%; z-index: -1;
  background: radial-gradient(ellipse at center, rgba(var(--wic-night-rgb), 0.62) 0%, rgba(var(--wic-night-rgb), 0) 70%);
}
.wic-msg__text {
  font-size: clamp(14px, 1.65vw, 19px); line-height: 1.6; letter-spacing: 0.07em; color: var(--wic-ink);
  text-shadow: 0 0 2px #000, 0 0 16px rgba(0, 0, 0, 0.95);
}

/* tutorial hints */
.wic-tut {
  position: absolute; left: 50%; bottom: 104px; width: max-content; max-width: calc(100vw - 32px);
  transform: translateX(-50%); text-align: center; opacity: 0;
  font: 12px/2 var(--wic-mono); letter-spacing: 0.08em; color: var(--wic-ink-dim); text-shadow: var(--wic-shadow);
}
.wic-tut .wic-kbd { margin: 0 0.2em; }

/* found-footage tag + checkpoint mark */
.wic-rec {
  position: absolute; left: 22px; top: 18px;
  font: 11px/1 var(--wic-mono); letter-spacing: 0.24em; color: var(--wic-ink); text-shadow: var(--wic-shadow);
}
.wic-rec__line { display: flex; align-items: center; opacity: 0.5; }
.wic-rec__dot { width: 7px; height: 7px; margin-right: 9px; border-radius: 50%; background: var(--wic-red); box-shadow: 0 0 6px var(--wic-red); }
.wic-rec__time { margin-left: 12px; font-variant-numeric: tabular-nums; }
.wic-rec__mark { margin-top: 11px; display: flex; align-items: center; gap: 9px; opacity: 0; letter-spacing: 0.22em; text-transform: uppercase; font-size: 10.5px; }
.wic-rec__diamond { width: 6px; height: 6px; transform: rotate(45deg); border: 1px solid var(--wic-ink); }

.wic-notice {
  position: absolute; left: 50%; top: 10vh; transform: translateX(-50%);
  width: max-content; max-width: calc(100vw - 32px); padding: 9px 16px;
  border: 1px solid rgba(var(--wic-ink-rgb), 0.22); background: rgba(var(--wic-night-rgb), 0.72);
  font: 12px/1.5 var(--wic-mono); letter-spacing: 0.06em; text-align: center; opacity: 0;
}

.wic-debug {
  position: absolute; right: 10px; top: 10px; margin: 0; padding: 8px 10px;
  max-width: calc(100vw - 20px); max-height: calc(100% - 20px); overflow: hidden;
  background: rgba(0, 0, 0, 0.6); color: #cfe3c6;
  font: 11px/1.35 var(--wic-mono); white-space: pre; letter-spacing: 0;
}

/* ---------- screens ---------- */
.wic-screen {
  position: absolute; inset: 0; opacity: 0; visibility: hidden; pointer-events: none;
  transition: opacity 0.7s ease, visibility 0s linear 0.7s;
}
.wic-screen.is-on { opacity: 1; visibility: visible; pointer-events: auto; transition: opacity 0.7s ease; }

/* title */
.wic-title { cursor: pointer; }
.wic-title__shade {
  position: absolute; inset: 0;
  background:
    linear-gradient(90deg, rgba(var(--wic-night-rgb), 0.94) 0%, rgba(var(--wic-night-rgb), 0.78) 27%, rgba(var(--wic-night-rgb), 0.26) 54%, rgba(var(--wic-night-rgb), 0) 78%),
    linear-gradient(0deg, rgba(var(--wic-night-rgb), 0.88) 0%, rgba(var(--wic-night-rgb), 0) 42%),
    linear-gradient(180deg, rgba(var(--wic-night-rgb), 0.5) 0%, rgba(var(--wic-night-rgb), 0) 20%);
}
.wic-scan {
  position: absolute; inset: 0; opacity: 0.5; overflow: hidden;
  background: repeating-linear-gradient(0deg, rgba(0, 0, 0, 0.24) 0 1px, rgba(0, 0, 0, 0) 1px 3px);
}
/* A faint tracking band rolling down the tape. */
.wic-scan::after {
  content: ''; position: absolute; left: 0; right: 0; top: 0; height: 90px;
  background: linear-gradient(180deg, rgba(255, 220, 200, 0) 0%, rgba(255, 220, 200, 0.05) 55%, rgba(255, 220, 200, 0) 100%);
  animation: wic-roll 9s linear infinite;
}
.wic-title__inner {
  position: absolute; left: clamp(20px, 7vw, 124px); right: 20px; bottom: clamp(26px, 9vh, 112px);
  max-width: 780px;
}
.wic-title__file { font: 11px/1.5 var(--wic-mono); letter-spacing: 0.3em; text-transform: uppercase; color: var(--wic-red); }
.wic-title__ref { margin-top: 6px; font: 10px/1.5 var(--wic-mono); letter-spacing: 0.24em; text-transform: uppercase; color: var(--wic-ink-faint); }
.wic-title__name {
  position: relative; margin: 30px 0 0; font-weight: 400; line-height: 0.95;
  font-size: clamp(34px, 6.6vw, 104px); letter-spacing: 0.2em; color: #f2e5dd; white-space: nowrap;
  text-shadow: 0 0 28px rgba(var(--wic-red-rgb), 0.35), 0 0 2px rgba(0, 0, 0, 0.8);
  animation: wic-flicker 9s linear infinite;
}
.wic-title__name::after {
  content: attr(data-text); position: absolute; left: 0; top: 0; pointer-events: none;
  color: var(--wic-red); opacity: 0; text-shadow: none; animation: wic-ghost 11s linear infinite;
}
.wic-title__sub { margin: 20px 0 0; font-size: clamp(13px, 1.35vw, 16px); letter-spacing: 0.04em; color: var(--wic-ink-dim); }
.wic-title__sub i { color: var(--wic-ink); }
.wic-title__inner .wic-rule { margin: 30px 0 22px; }
/* Two key/label pairs per row; li is display: contents so all rows share column widths. */
.wic-controls {
  display: grid; grid-template-columns: repeat(4, max-content); align-items: center; column-gap: 14px; row-gap: 9px;
  margin: 0; padding: 0; list-style: none;
  font: 12px/1 var(--wic-mono); letter-spacing: 0.06em; color: var(--wic-ink-dim);
}
.wic-controls li { display: contents; }
.wic-controls li:nth-child(odd) > span:last-child { margin-right: 30px; }
.wic-title__foot { display: flex; flex-wrap: wrap; align-items: baseline; gap: 14px 38px; margin-top: 36px; }
.wic-title__begin {
  font-size: 15px; letter-spacing: 0.36em; text-transform: uppercase; color: var(--wic-ink);
  animation: wic-breathe 3s ease-in-out infinite;
}
.wic-title__begin::before { content: ''; display: inline-block; width: 22px; height: 1px; margin-right: 14px; vertical-align: 0.3em; background: var(--wic-red); }
.wic-title__phones { font: 10.5px/1 var(--wic-mono); letter-spacing: 0.26em; text-transform: uppercase; color: var(--wic-ink-faint); }

/* intro */
.wic-intro {
  display: flex; align-items: center; justify-content: center; padding: 24px; cursor: pointer;
  background: radial-gradient(ellipse at 50% 45%, rgba(12, 3, 4, 0.8) 0%, rgba(3, 1, 1, 0.96) 78%);
}
.wic-intro__body { width: min(100%, 40em); }
.wic-intro__head { margin-bottom: 2.6em; font: 11px/1 var(--wic-mono); letter-spacing: 0.32em; text-transform: uppercase; color: var(--wic-red); opacity: 0.85; }
.wic-intro__line {
  min-height: 1.7em; margin: 0 0 0.55em; font-size: clamp(15px, 1.85vw, 21px); line-height: 1.7; letter-spacing: 0.03em;
  transition: opacity 1.4s ease;
}
.wic-intro__line.is-past { opacity: 0.5; }
.wic-intro__line.is-old { opacity: 0.26; }
.wic-intro__line.is-final { margin-top: 1.2em; letter-spacing: 0.3em; text-transform: uppercase; color: #f6dccf; text-shadow: 0 0 18px rgba(var(--wic-red-rgb), 0.45); }
.wic-intro__skip {
  position: absolute; left: 0; right: 0; bottom: 26px; text-align: center;
  font: 10.5px/1 var(--wic-mono); letter-spacing: 0.3em; text-transform: uppercase; color: var(--wic-ink-faint);
  transition: color 0.6s ease;
}
.wic-intro__skip.is-wait { color: var(--wic-ink); animation: wic-breathe 3s ease-in-out infinite; }

/* pause */
.wic-pause {
  background: linear-gradient(90deg, rgba(var(--wic-night-rgb), 0.95) 0%, rgba(var(--wic-night-rgb), 0.84) 46%, rgba(var(--wic-night-rgb), 0.6) 100%);
  -webkit-backdrop-filter: blur(2px) saturate(0.7); backdrop-filter: blur(2px) saturate(0.7);
}
.wic-pause__panel {
  position: absolute; left: clamp(20px, 8vw, 128px); top: 50%; transform: translateY(-50%);
  width: min(500px, calc(100vw - 40px)); max-height: calc(100% - 32px); overflow-y: auto; padding: 4px 4px 4px 0;
}
.wic-pause__tag { display: flex; align-items: center; gap: 10px; font: 10.5px/1.3 var(--wic-mono); letter-spacing: 0.26em; text-transform: uppercase; color: var(--wic-red); }
.wic-pause__tag::before { content: ''; flex: none; width: 8px; height: 8px; background: var(--wic-red); }
.wic-pause__title { margin: 16px 0 24px; font-size: clamp(28px, 4vw, 46px); font-weight: 400; letter-spacing: 0.3em; line-height: 1; }
.wic-menu { display: flex; flex-direction: column; gap: 2px; margin-bottom: 24px; }
.wic-btn {
  position: relative; display: block; width: 100%; margin: 0; padding: 9px 0;
  background: none; border: 0; border-radius: 0;
  color: var(--wic-ink-dim); font: 17px/1.25 var(--wic-type); letter-spacing: 0.14em; text-align: left;
  cursor: pointer; transition: color 0.2s ease, padding 0.25s ease, opacity 0.3s ease;
}
.wic-btn::before {
  content: ''; position: absolute; left: 0; top: 50%; width: 0; height: 1px;
  background: var(--wic-red); transition: width 0.25s ease;
}
.wic-btn:hover:not(:disabled), .wic-btn:focus-visible { color: var(--wic-ink); padding-left: 28px; outline: none; }
.wic-btn:hover:not(:disabled)::before, .wic-btn:focus-visible::before { width: 18px; }
.wic-btn:disabled { opacity: 0.3; cursor: default; }
.wic-settings { display: flex; flex-direction: column; gap: 14px; padding-top: 22px; border-top: 1px solid rgba(var(--wic-ink-rgb), 0.12); }
.wic-slider { display: grid; grid-template-columns: 1fr auto; align-items: baseline; row-gap: 4px; }
.wic-slider__label { font: 10.5px/1 var(--wic-mono); letter-spacing: 0.24em; text-transform: uppercase; color: var(--wic-ink-dim); }
.wic-slider__value { font: 11px/1 var(--wic-mono); letter-spacing: 0.08em; color: var(--wic-ink); font-variant-numeric: tabular-nums; }
.wic-range {
  grid-column: 1 / -1; width: 100%; height: 20px; margin: 0; padding: 0;
  -webkit-appearance: none; appearance: none; background: transparent; cursor: pointer;
}
.wic-range:focus { outline: none; }
.wic-range:focus-visible { outline: 1px dotted var(--wic-ink-faint); outline-offset: 3px; }
.wic-range::-webkit-slider-runnable-track {
  height: 1px; border: 0;
  background: linear-gradient(90deg, var(--wic-ink) 0, var(--wic-ink) var(--p, 50%), rgba(var(--wic-ink-rgb), 0.22) var(--p, 50%));
}
.wic-range::-webkit-slider-thumb {
  -webkit-appearance: none; appearance: none; width: 9px; height: 15px; margin-top: -7px;
  border: 0; border-radius: 1px; background: var(--wic-ink); box-shadow: 0 0 0 3px rgba(var(--wic-night-rgb), 0.85);
}
.wic-range::-moz-range-track { height: 1px; border: 0; background: rgba(var(--wic-ink-rgb), 0.22); }
.wic-range::-moz-range-progress { height: 1px; background: var(--wic-ink); }
.wic-range::-moz-range-thumb { width: 9px; height: 15px; border: 0; border-radius: 1px; background: var(--wic-ink); }
.wic-pause .wic-controls { margin-top: 24px; padding-top: 20px; border-top: 1px solid rgba(var(--wic-ink-rgb), 0.12); column-gap: 12px; font-size: 11px; }
.wic-pause .wic-controls li:nth-child(odd) > span:last-child { margin-right: 22px; }

/* dead */
.wic-dead {
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  padding: 24px; text-align: center; background: #000; cursor: pointer;
  transition-duration: 0.35s;
}
.wic-dead.is-on { transition: opacity 0.35s ease; }
.wic-dead__line {
  max-width: 24em; margin-right: -0.3em; color: #e8cfc6;
  font-size: clamp(18px, 3.1vw, 38px); line-height: 1.45; letter-spacing: 0.3em;
  text-shadow: 0 0 22px rgba(var(--wic-red-rgb), 0.35);
  opacity: 0; filter: blur(8px); transition: opacity 1.8s ease 0.25s, filter 2.4s ease 0.25s;
}
.wic-dead.is-on .wic-dead__line { opacity: 1; filter: blur(0); }
.wic-dead__retry {
  margin-top: 46px; opacity: 0; transition: opacity 1s ease;
  font: 11px/1 var(--wic-mono); letter-spacing: 0.34em; margin-right: -0.34em; text-transform: uppercase; color: var(--wic-ink-dim);
}
.wic-dead.is-ready .wic-dead__retry { opacity: 1; }
.wic-dead__retry span { animation: wic-breathe 3s ease-in-out infinite; }

/* won: stepping out into pale mist */
.wic-won {
  display: flex; align-items: center; justify-content: center; padding: 24px;
  color: var(--wic-mist-ink);
  background:
    radial-gradient(ellipse 90% 70% at 50% 42%, rgba(222, 214, 209, 0.97) 0%, rgba(196, 184, 179, 0.97) 55%, rgba(138, 124, 120, 0.98) 100%);
}
.wic-won.is-on { transition: opacity 4s ease; }
.wic-won .wic-scan { opacity: 0.12; }
.wic-won__body { position: relative; width: min(100%, 36em); }
.wic-won__line { min-height: 1.7em; margin: 0 0 0.3em; font-size: clamp(16px, 2vw, 22px); line-height: 1.7; letter-spacing: 0.02em; }
.wic-won__end, .wic-won__stats { opacity: 0; transition: opacity 1.6s ease; }
.wic-won.is-done .wic-won__end, .wic-won.is-done .wic-won__stats { opacity: 1; }
.wic-won__end {
  display: flex; align-items: center; gap: 12px; margin-top: 3.2em;
  font: 11px/1 var(--wic-mono); letter-spacing: 0.36em; text-transform: uppercase; color: rgba(29, 20, 22, 0.6);
}
.wic-won__end::before { content: ''; width: 8px; height: 8px; background: var(--wic-red-deep); }
.wic-won__stats { display: flex; flex-wrap: wrap; gap: 18px 44px; margin-top: 22px; transition-delay: 0.4s; }
.wic-stat__k { font: 10px/1 var(--wic-mono); letter-spacing: 0.24em; text-transform: uppercase; color: rgba(29, 20, 22, 0.55); }
.wic-stat__v { margin-top: 8px; font-size: 24px; line-height: 1; font-variant-numeric: tabular-nums; }
.wic-won .wic-btn {
  width: auto; margin-top: 30px; color: rgba(29, 20, 22, 0.7); opacity: 0; pointer-events: none;
  transition: opacity 1.6s ease 0.9s, color 0.2s ease, padding 0.25s ease;
}
.wic-won.is-done .wic-btn { opacity: 1; pointer-events: auto; }
.wic-won .wic-btn::before { background: var(--wic-red-deep); }
.wic-won .wic-btn:hover:not(:disabled), .wic-won .wic-btn:focus-visible { color: var(--wic-mist-ink); }

@keyframes wic-roll { 0% { transform: translateY(-120px); } 100% { transform: translateY(120vh); } }
@keyframes wic-caret { 0% { opacity: 0.75; } 50% { opacity: 0; } }
@keyframes wic-breathe { 0%, 100% { opacity: 0.4; } 50% { opacity: 1; } }
@keyframes wic-flicker {
  0%, 100% { opacity: 1; }
  40% { opacity: 1; } 40.4% { opacity: 0.6; } 40.8% { opacity: 1; } 41.3% { opacity: 0.82; } 41.8% { opacity: 1; }
  76% { opacity: 1; } 76.4% { opacity: 0.7; } 76.9% { opacity: 1; }
}
@keyframes wic-ghost {
  0%, 86%, 100% { opacity: 0; transform: translate(0, 0); }
  86.6% { opacity: 0.55; transform: translate(5px, 0); }
  87.2% { opacity: 0.25; transform: translate(-4px, 1px); }
  87.8% { opacity: 0.4; transform: translate(2px, 0); }
  88.4% { opacity: 0; transform: translate(0, 0); }
}

@media (max-width: 640px) {
  .wic-title__shade {
    background:
      linear-gradient(0deg, rgba(var(--wic-night-rgb), 0.97) 0%, rgba(var(--wic-night-rgb), 0.88) 58%, rgba(var(--wic-night-rgb), 0.3) 100%);
  }
  .wic-title__inner { left: 20px; right: 20px; bottom: 26px; }
  .wic-title__name { letter-spacing: 0.12em; margin-top: 22px; }
  .wic-title__file { letter-spacing: 0.2em; }
  .wic-controls { grid-template-columns: repeat(2, max-content); row-gap: 7px; }
  .wic-controls li:nth-child(odd) > span:last-child { margin-right: 0; }
  .wic-title__inner .wic-rule { margin: 22px 0 18px; }
  .wic-title__foot { margin-top: 26px; }
  .wic-rec { left: 16px; top: 14px; }
  .wic-bottles { right: 16px; bottom: 18px; }
  .wic-zone__name { white-space: normal; }
  .wic-won__stats { gap: 16px 22px; }
  .wic-stat__k { letter-spacing: 0.16em; }
}
@media (max-height: 520px) {
  .wic-title__inner .wic-rule, .wic-controls { display: none; }
}
@media (prefers-reduced-motion: reduce) {
  .wic-title__name, .wic-title__name::after, .wic-scan::after { animation: none; }
}
`;

export function injectStyles() {
  if (document.getElementById('wic-hud-style')) return;
  const style = document.createElement('style');
  style.id = 'wic-hud-style';
  style.textContent = CSS;
  document.head.appendChild(style);
}
