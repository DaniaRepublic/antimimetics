// Shared by tools/robust-session.mjs and tools/perf-systems.mjs: an in-page 'bot' that plays
// the game through window.__game with real input, plus the zone tour it follows.
//   await h.eval(installBot);  window.__bot.walk([[x, z], ...]); window.__bot.run(seconds, 'caught')

// Runs in the page (pass it to page.evaluate). spikes: also time every event dispatch, snatcher
// update, path search and nav rebuild, recording each one over 4 ms in window.__spikes.
export function installBot({ spikes: trackSpikes = true } = {}) {
  const g = window.__game;
  g.audio.init(); // audio voices/nodes are part of the leak check (no-op with ?mute)
  const bot = {
    queue: [],
    target: null,
    sprint: false,
    crouch: false,
    respawns: 0,
    caught: 0,
    stuckT: 0,
    lastD: Infinity,
    until: {
      noTarget: () => !bot.target,
      caught: () => g.state === 'caught',
      calling: () => g.leviathan.calling,
    },
    walk(points, { sprint = false, crouch = false } = {}) {
      this.queue = points.map(([x, z]) => ({ x, z }));
      this.target = this.queue.shift() || null;
      this.sprint = sprint;
      this.crouch = crouch;
      this.stuckT = 0;
      this.lastD = Infinity;
    },
    steer(step) {
      const p = g.player, inp = g.input;
      inp.keys.delete('KeyW');
      inp.keys.delete('ShiftLeft');
      if (!this.target || g.state !== 'playing') return;
      const dx = this.target.x - p.position.x, dz = this.target.z - p.position.z;
      const d = Math.hypot(dx, dz);
      if (d < 1.2) {
        this.target = this.queue.shift() || null;
        this.lastD = Infinity;
        return;
      }
      // Not getting closer (wedged against a wreck): hop past the obstacle.
      if (d > this.lastD - 0.02) this.stuckT += step;
      else this.stuckT = 0;
      this.lastD = Math.min(this.lastD, d);
      if (this.stuckT > 3) {
        g.teleport(p.position.x + (dx / d) * 2.5, p.position.z + (dz / d) * 2.5, p.yaw);
        this.stuckT = 0;
        this.lastD = Infinity;
      }
      p.yaw = Math.atan2(-dx, -dz);
      inp.keys.add('KeyW');
      if (this.sprint && p.stamina > 0.4) inp.keys.add('ShiftLeft');
      if (this.crouch !== p.crouched && !this.sprint) inp.pressedKeys.add('KeyC');
    },
    // Advance `seconds` of game time (fixed 1/30 s steps), steering; respawns from the dead
    // screen. Returns true once the named `until` predicate holds.
    run(seconds, until = null) {
      const step = 1 / 30;
      const n = Math.ceil(seconds / step);
      const stop = until ? this.until[until] : null;
      for (let i = 0; i < n; i++) {
        if (g.state === 'dead' && g.stateTime > 1.2) {
          g.respawn();
          this.respawns++;
          this.target = null;
        }
        this.steer(step);
        const was = g.state;
        g.tick(step);
        if (was !== 'caught' && g.state === 'caught') this.caught++;
        if (stop && stop()) return true;
      }
      return false;
    },
    metrics() {
      if (window.gc) window.gc();
      let objects = 0;
      g.scene.traverse(() => objects++);
      const mem = g.renderer.info.memory;
      let cellEntries = 0;
      for (const c of g.world.grid.values()) cellEntries += c.length;
      const a = g.audio.stats();
      return {
        t: Math.round(g.time),
        state: g.state,
        children: g.scene.children.length,
        objects,
        colliders: g.world.colliders.length,
        levFeet: g.world.colliders.filter((c) => c.tag === 'leviathan-foot').length,
        hashCells: g.world.grid.size,
        hashEntries: cellEntries,
        geometries: mem.geometries,
        textures: mem.textures,
        programs: g.renderer.info.programs?.length ?? 0,
        heapMB: performance.memory ? +(performance.memory.usedJSHeapSize / 1048576).toFixed(1) : null,
        listeners: g.bus.listenerCount(),
        dom: document.getElementsByTagName('*').length,
        voices: a.voices,
        audioNodes: a.nodes,
        projectiles: g.projectiles.items.length + g.projectiles.shards.length,
        pathCache: g.director.pathCache.size,
        pathQueue: g.director.pathQueue.length,
        calls: g.leviathan.calls,
        footfalls: g.leviathan.footfalls,
        errors: g.errorLog.reduce((s, e) => s + e.count, 0),
      };
    },
  };
  window.__bot = bot;

  // Spike finder: any single event dispatch, snatcher update, path search or nav rebuild that
  // takes longer than 4 ms is recorded with when/where it happened (nested costs included).
  const spikes = (window.__spikes = []);
  if (!trackSpikes) return;
  const note = (what, ms) => {
    if (ms > 4) spikes.push({ what, ms: +ms.toFixed(1), t: +g.time.toFixed(1), zone: g.level.currentZone, state: g.state });
  };
  const timed = (obj, name, label) => {
    const orig = obj[name].bind(obj);
    obj[name] = (...a) => {
      const t0 = performance.now();
      const r = orig(...a);
      note(typeof label === 'function' ? label(a) : label, performance.now() - t0);
      return r;
    };
  };
  timed(g.bus, 'emit', (a) => `event ${a[0]}`);
  for (const s of g.director.snatchers) {
    timed(s, 'update', `snatcher ${s.id}`);
    timed(s, 'updateDormant', `dormant ${s.id}`);
  }
  timed(g.director, 'processPaths', 'director.processPaths');
  timed(g.director, 'reset', 'director.reset');
  timed(g.nav, 'rebuildArea', 'nav.rebuildArea');
  timed(g.level, 'resetDynamic', 'level.resetDynamic');
  timed(g.leviathan, 'onRespawn', 'leviathan.onRespawn');
}

// Zones: checkpoint index, a walk through it, and what to set off there.
export const ZONES = [
  { cp: 0, walk: [[0, -6], [0, -19]] },
  { cp: 1, walk: [[2.5, -40], [4, -58], [0, -95]], alarm: 'main_alarm' },
  { cp: 2, walk: [[12, -150], [-8, -168], [-4, -186]], alarm: 'plaza_alarm' },
  { cp: 3, walk: [[2, -236], [-2, -270], [1, -310]], crouch: true },
  { cp: 4, walk: [[-8, -362], [-2, -384]], gate: true },
];
