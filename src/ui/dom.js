// Tiny DOM helpers for the HUD: element builders and change-only writers so per-frame
// updates don't thrash style recalculation.

const SVG_NS = 'http://www.w3.org/2000/svg';

export function el(tag, className, parent, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  if (parent) parent.appendChild(node);
  return node;
}

export function svgEl(tag, attrs, parent) {
  const node = document.createElementNS(SVG_NS, tag);
  if (attrs) for (const k in attrs) node.setAttribute(k, attrs[k]);
  if (parent) parent.appendChild(node);
  return node;
}

function cacheOf(node) {
  return node.__wic || (node.__wic = Object.create(null));
}

// Numbers are rounded so tiny float drift does not cause a DOM write every frame.
const norm = (v) => (typeof v === 'number' ? Math.round(v * 1000) / 1000 : v);

export function setStyle(node, prop, value) {
  const c = cacheOf(node);
  const v = norm(value);
  if (c[prop] === v) return;
  c[prop] = v;
  if (prop.startsWith('--')) node.style.setProperty(prop, String(v));
  else node.style[prop] = String(v);
}

export function setAttr(node, name, value) {
  const c = cacheOf(node);
  const key = '@' + name;
  const v = norm(value);
  if (c[key] === v) return;
  c[key] = v;
  node.setAttribute(name, String(v));
}

export function setText(node, text) {
  const c = cacheOf(node);
  if (c.$text === text) return;
  c.$text = text;
  node.textContent = text;
}

export function toggleClass(node, cls, on) {
  const c = cacheOf(node);
  const key = '.' + cls;
  if (c[key] === on) return;
  c[key] = on;
  node.classList.toggle(cls, on);
}

// Renders a key hint such as 'W A S D', 'click / F' or 'Shift' into keycaps.
// Plain words (mouse, click, hold) render as small text instead of caps.
const WORDS = new Set(['mouse', 'click', 'hold', 'or', 'drag']);
export function keycaps(parent, spec) {
  const wrap = el('span', 'wic-keys', parent);
  for (const token of spec.split(' ')) {
    if (!token) continue;
    if (token === '/') el('span', 'wic-keys__sep', wrap, '/');
    else if (WORDS.has(token.toLowerCase())) el('span', 'wic-word', wrap, token);
    else el('kbd', 'wic-kbd', wrap, token);
  }
  return wrap;
}

// Inline rich line: text with [Key] tokens turned into keycaps, e.g. '[C] crouch'.
export function richLine(parent, text) {
  parent.textContent = '';
  const parts = String(text).split(/(\[[^\]]+\])/g);
  for (const part of parts) {
    if (!part) continue;
    const m = /^\[([^\]]+)\]$/.exec(part);
    if (m) el('kbd', 'wic-kbd', parent, m[1]);
    else parent.appendChild(document.createTextNode(part));
  }
  return parent;
}

// 0 -> 1 over fadeIn, hold, 1 -> 0 over fadeOut (t in seconds).
export function envelope(t, fadeIn, hold, fadeOut) {
  if (t <= 0) return 0;
  if (t < fadeIn) return t / fadeIn;
  if (t < fadeIn + hold) return 1;
  const k = (t - fadeIn - hold) / fadeOut;
  return k >= 1 ? 0 : 1 - k;
}
