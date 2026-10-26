// A blocking message over everything (WebGL context lost, rendering failed, the game could not
// start). Plain DOM with inline styles so it works under any page template and before the HUD
// exists. One notice at a time: showNotice() replaces the current one.

const ID = 'wic-notice';

export function showNotice({ title = '', text = '', detail = '', action = null } = {}) {
  if (typeof document === 'undefined' || !document.body) return null;
  hideNotice();
  const root = document.createElement('div');
  root.id = ID;
  root.setAttribute('role', 'alertdialog');
  root.style.cssText = [
    'position:fixed', 'inset:0', 'z-index:2147483000', 'display:grid', 'place-items:center',
    'background:rgba(7,3,4,0.9)', 'color:#e8d9d2', 'pointer-events:auto',
    'font:14px/1.6 "Courier New",ui-monospace,Menlo,Consolas,monospace', 'text-align:center',
    'padding:16px', 'box-sizing:border-box',
  ].join(';');
  const box = document.createElement('div');
  box.style.cssText = 'max-width:34em';
  if (title) {
    const h = document.createElement('div');
    h.textContent = title;
    h.style.cssText = 'letter-spacing:0.35em;font-size:12px;color:#d23a26;margin-bottom:1.2em';
    box.appendChild(h);
  }
  const p = document.createElement('p');
  p.textContent = text;
  p.style.cssText = 'margin:0 0 1em';
  box.appendChild(p);
  if (detail) {
    const d = document.createElement('p');
    d.textContent = detail;
    d.style.cssText = 'margin:0 0 1em;font-size:11px;color:#9c8a84;word-break:break-word';
    box.appendChild(d);
  }
  if (action) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = action.label;
    b.style.cssText = 'font:inherit;letter-spacing:0.2em;color:#e8d9d2;background:transparent;border:1px solid #9c8a84;padding:0.5em 1.4em;cursor:pointer';
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      action.onClick();
    });
    box.appendChild(b);
  }
  // Clicks on the notice must not reach the game (e.g. a "click to begin" title screen).
  for (const type of ['click', 'mousedown', 'pointerdown']) root.addEventListener(type, (e) => e.stopPropagation());
  root.appendChild(box);
  document.body.appendChild(root);
  return root;
}

export function hideNotice() {
  if (typeof document === 'undefined') return;
  document.getElementById(ID)?.remove();
}

export const reloadAction = (label = 'RELOAD') => ({ label, onClick: () => window.location.reload() });
