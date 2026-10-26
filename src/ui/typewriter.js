// Reveals text one character at a time with short pauses on punctuation. Driven by
// update(dt) (not timers) so it also advances under game.simulate() in tests.
//
// The untyped remainder stays in the DOM as an invisible span, so the final layout
// (wrapping, centring) is fixed from the first character and nothing jumps while typing.

const LONG_PAUSE = '.!?';
const SHORT_PAUSE = ',;:—';

export class Typewriter {
  constructor(node, { cps = 38, caretClass = 'wic-typing' } = {}) {
    this.node = node;
    this.cps = cps;
    this.caretClass = caretClass;
    this.typed = document.createElement('span');
    this.rest = document.createElement('span');
    this.rest.className = 'wic-tw-rest';
    this.text = '';
    this.shown = 0;
    this.wait = 0;
    this.done = true;
  }

  // Lay out the text invisibly without starting to type (reserves its space).
  prime(text) {
    this.text = String(text ?? '');
    this.shown = 0;
    this.done = true;
    this.attach();
    this.typed.classList.remove(this.caretClass);
    this.render();
  }

  start(text, delay = 0) {
    this.text = String(text ?? '');
    this.shown = 0;
    this.wait = delay;
    this.done = this.text.length === 0;
    this.attach();
    this.typed.classList.toggle(this.caretClass, !this.done);
    this.render();
  }

  // Jump to the end of the current text.
  finish() {
    this.shown = this.text.length;
    this.render();
    this.complete();
  }

  clear() {
    this.text = '';
    this.shown = 0;
    this.done = true;
    this.typed.classList.remove(this.caretClass);
    this.render();
  }

  attach() {
    if (this.typed.parentNode !== this.node) {
      this.node.textContent = '';
      this.node.append(this.typed, this.rest);
    }
  }

  complete() {
    this.done = true;
    this.typed.classList.remove(this.caretClass);
  }

  update(dt) {
    if (this.done) return true;
    this.wait -= dt;
    const before = this.shown;
    const n = this.text.length;
    while (this.wait <= 0 && this.shown < n) {
      const ch = this.text[this.shown++];
      const next = this.text[this.shown];
      let pause = 1 / this.cps;
      if (next === undefined || next === ' ') {
        if (LONG_PAUSE.includes(ch)) pause += 0.32;
        else if (SHORT_PAUSE.includes(ch)) pause += 0.14;
      }
      this.wait += pause;
    }
    if (this.shown !== before) this.render();
    if (this.shown >= n && this.wait <= 0) this.complete();
    return this.done;
  }

  render() {
    this.typed.textContent = this.text.slice(0, this.shown);
    this.rest.textContent = this.text.slice(this.shown);
  }
}
