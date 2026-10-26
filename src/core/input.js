// Keyboard + mouse input with pointer lock, and a drag-to-look fallback for
// embeds where pointer lock is unavailable (sandboxed iframes, some browsers).
//
// Usage per frame: read `input.down(code)`, `input.pressed(code)` (edge, true for
// one frame), `input.consumeLook()` -> {dx, dy} in pixels, then `input.endFrame()`.

const GAME_KEYS = new Set([
  'KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyC', 'KeyE', 'KeyQ', 'KeyF', 'KeyR',
  'ShiftLeft', 'ShiftRight', 'Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
]);

export class Input {
  constructor(element, bus) {
    this.el = element;
    this.bus = bus;
    this.keys = new Set();
    this.pressedKeys = new Set();
    this.mouseButtons = new Set();
    this.pressedButtons = new Set();
    this.lookDX = 0;
    this.lookDY = 0;
    this.locked = false;
    this.everLocked = false;
    this.pointerLockFailed = false;
    this.dragging = false;
    this.enabled = true;
    this.lastX = 0;
    this.lastY = 0;
    this.releaseRequested = false;
    this.lockBlocked = false; // pointer lock can never work here (sandboxed frame): don't ask again

    window.addEventListener('keydown', (e) => {
      // Only swallow keys while playing, so menus keep arrow-key sliders and Tab focus.
      if (this.enabled && GAME_KEYS.has(e.code)) e.preventDefault();
      if (e.repeat) return;
      this.keys.add(e.code);
      this.pressedKeys.add(e.code);
      this.bus.emit('input:key', { code: e.code });
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.reset());

    element.addEventListener('mousedown', (e) => {
      this.mouseButtons.add(e.button);
      this.pressedButtons.add(e.button);
      if (!this.locked) {
        this.dragging = true;
        this.lastX = e.clientX;
        this.lastY = e.clientY;
      }
    });
    window.addEventListener('mouseup', (e) => {
      this.mouseButtons.delete(e.button);
      this.dragging = false;
    });
    element.addEventListener('contextmenu', (e) => e.preventDefault());

    window.addEventListener('mousemove', (e) => {
      if (!this.enabled) return;
      if (this.locked) {
        this.lookDX += e.movementX || 0;
        this.lookDY += e.movementY || 0;
      } else if (this.dragging && this.pointerLockFailed) {
        this.lookDX += e.clientX - this.lastX;
        this.lookDY += e.clientY - this.lastY;
        this.lastX = e.clientX;
        this.lastY = e.clientY;
      }
    });

    document.addEventListener('pointerlockchange', () => {
      const was = this.locked;
      this.locked = document.pointerLockElement === this.el;
      if (this.locked) {
        this.everLocked = true;
        this.pointerLockFailed = false;
      }
      // `requested`: the game released the lock itself (a menu opened). The exit lands
      // asynchronously, possibly after the game has already resumed, so listeners must not treat
      // it as the player pressing Esc.
      if (was && !this.locked) {
        const requested = this.releaseRequested;
        this.releaseRequested = false;
        this.bus.emit('input:unlock', { requested });
      }
      if (!was && this.locked) {
        this.releaseRequested = false;
        this.bus.emit('input:lock');
      }
    });
    document.addEventListener('pointerlockerror', () => this.lockRefused());
  }

  // Must be called from a user gesture (click). Falls back silently.
  requestLock() {
    if (this.locked || this.lockBlocked) return;
    try {
      const p = this.el.requestPointerLock?.();
      if (p && typeof p.catch === 'function') p.catch((err) => this.lockRefused(err));
      else if (!this.el.requestPointerLock) this.lockRefused({ name: 'NotSupportedError' });
    } catch (err) {
      this.lockRefused(err);
    }
  }

  // A refusal after a successful lock is temporary (browsers refuse re-locking for ~1 s after
  // Esc), so only switch to drag-to-look when the lock has never worked in this session. A sandboxed
  // iframe without allow-pointer-lock (or no API at all) is final: stop asking, since every refused
  // request also prints an error in the console. (Other SecurityErrors, e.g. "the user has exited
  // the lock before this request was completed", are transient.)
  lockRefused(err) {
    const sandboxed = err?.name === 'SecurityError' && /sandbox/i.test(String(err.message));
    if (sandboxed || err?.name === 'NotSupportedError') this.lockBlocked = true;
    if (!this.everLocked || this.lockBlocked) this.pointerLockFailed = true;
    this.bus.emit('input:lockfailed');
  }

  releaseLock() {
    if (!document.pointerLockElement) return;
    this.releaseRequested = true;
    document.exitPointerLock?.();
  }

  down(code) {
    return this.enabled && this.keys.has(code);
  }

  pressed(code) {
    return this.enabled && this.pressedKeys.has(code);
  }

  mouseDown(button = 0) {
    return this.enabled && this.mouseButtons.has(button);
  }

  mousePressed(button = 0) {
    return this.enabled && this.pressedButtons.has(button);
  }

  consumeLook() {
    const d = { dx: this.lookDX, dy: this.lookDY };
    this.lookDX = 0;
    this.lookDY = 0;
    return d;
  }

  endFrame() {
    this.pressedKeys.clear();
    this.pressedButtons.clear();
  }

  reset() {
    this.keys.clear();
    this.pressedKeys.clear();
    this.mouseButtons.clear();
    this.pressedButtons.clear();
    this.lookDX = 0;
    this.lookDY = 0;
    this.dragging = false;
  }
}
