// Minimal synchronous event bus. See ARCHITECTURE.md for the event catalogue.
//
// A listener that throws does not stop the other listeners of that event (one module's bug must
// not silence another's reaction). The error goes to `bus.onError(err, type)`; by default it is
// re-thrown asynchronously so it still surfaces as an uncaught error with its original stack.
export class EventBus {
  constructor() {
    this.handlers = new Map();
    this.onError = (err) => {
      queueMicrotask(() => {
        throw err;
      });
    };
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
    if (!set || !set.size) return;
    // Iterate a snapshot: listeners may subscribe/unsubscribe while we dispatch.
    for (const fn of [...set]) {
      try {
        fn(payload);
      } catch (err) {
        this.onError(err, type);
      }
    }
  }

  // Number of listeners (all events, or one type): lets tests catch listeners that pile up.
  listenerCount(type) {
    if (type) return this.handlers.get(type)?.size ?? 0;
    let n = 0;
    for (const set of this.handlers.values()) n += set.size;
    return n;
  }
}
