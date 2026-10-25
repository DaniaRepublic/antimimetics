// Minimal synchronous event bus. See ARCHITECTURE.md for the event catalogue.
export class EventBus {
  constructor() {
    this.handlers = new Map();
  }

  on(type, fn) {
    if (!this.handlers.has(type)) this.handlers.set(type, new Set());
    this.handlers.get(type).add(fn);
    return () => this.off(type, fn);
  }

  off(type, fn) {
    this.handlers.get(type)?.delete(fn);
  }

  emit(type, payload) {
    const set = this.handlers.get(type);
    if (!set) return;
    for (const fn of [...set]) fn(payload);
  }
}
