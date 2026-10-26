// In-page playtest bot library (installed with page.evaluate(installBot)). It plays the real level by
// injecting input -- held keys (game.input.keys), one-frame presses (game.input.pressedKeys) and the
// player's yaw/pitch -- and stepping the game itself in fixed 1/30 s ticks. It never teleports
// during a run (a run starts with an ordinary respawn at a checkpoint).
//
//   window.__bot.run(zone, policyName, runIndex, opts) -> result
//   policies register themselves on window.__policies[zone][name] = (B, ctx) => { ... }
//
// Primitives (all block, ticking the game, and throw on caught / goal reached / timeout):
//   B.moveTo(x, z, {stance:'crouch'|'walk'|'sprint', tol, timeout, pauseIf, abortIf, direct})
//   B.path([[x, z], ...], opts)     B.wait(s)     B.waitUntil(fn, timeout)     B.stance(s)
//   B.throwAt({x, y, z, collider})  B.pickup(x, z, opts)   B.cutChain(opts)
//   B.det() max detection   B.calling()   B.callLeft()   B.s(id) snatcher by id
export function installBot([CFG, { fastModels = true } = {}]) {
  const g = window.__game;
  window.__THREE_V = g.player.position.constructor; // THREE.Vector3
  window.__PLAYER_CFG = CFG.player;
  window.__CONFIG = { callDuration: CFG.leviathan.callDuration };
  const DT = 1 / 30;
  const realTick = g.__realTick || (g.__realTick = g.tick.bind(g));
  // The page's own rAF loop must not advance the world between (or during) bot runs.
  g.tick = () => {};
  g.render = () => {};
  // Stop the page's frame loop altogether (compositing an idle canvas still costs CPU headless).
  window.__rAF = window.__rAF || window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = () => 0;
  // Skinned snatcher animation is ~80% of a headless tick and purely visual (the AI's eyes are
  // computed from the body, not the rig): skip it unless a test needs the real head position.
  if (fastModels) for (const s of g.director.snatchers) s.model.update = () => {};
  const dirToYaw = (dx, dz) => Math.atan2(-dx, -dz);
  const CAUGHT = { reason: 'caught' }, GOAL = { reason: 'goal' }, TIMEOUT = { reason: 'timeout' };

  const B = { g, DT, held: new Set(), press: new Set(), run: null, verbose: false };
  const log = (...a) => {
    if (B.run) B.run.log.push(`[${B.run.t.toFixed(1)}] ` + a.join(' '));
  };
  B.log = log;

  // --- events -----------------------------------------------------------------------------------
  const on = (type, fn) => g.bus.on(type, (e) => B.run && fn(e));
  on('player:caught', (e) => {
    B.run.caught = true;
    B.run.caughtBy = e.enemy?.id;
    log('CAUGHT by', e.enemy?.id);
  });
  on('enemy:alert', (e) => {
    B.run.alerts++;
    B.run.alertIds.push(e.enemy?.id);
    log('alert', e.enemy?.id);
  });
  on('enemy:suspicious', () => B.run.suspicious++);
  on('enemy:lost', (e) => log('lost', e.enemy?.id));
  on('enemy:giveup', (e) => {
    B.run.giveups = (B.run.giveups || 0) + 1;
    log('giveup', e.enemy?.id);
  });
  on('alarm:start', (e) => {
    B.run.alarms++;
    log('alarm', e.id);
  });
  on('level:checkpoint', (e) => {
    B.run.checkpoints.push(e.checkpoint.id);
    log('checkpoint', e.checkpoint.id);
    if (e.checkpoint.id === B.run.goal) B.run.success = true;
  });
  on('level:exit', () => {
    B.run.exits++;
    log('EXIT');
    if (B.run.goal === 'exit') B.run.success = true;
  });
  on('leviathan:call:start', () => log('call start'));
  on('gate:open', () => log('gate open'));

  // --- stepping ---------------------------------------------------------------------------------
  B.tick = () => {
    const r = B.run;
    const inp = g.input;
    inp.keys.clear();
    for (const k of B.held) inp.keys.add(k);
    for (const k of B.press) inp.pressedKeys.add(k);
    B.press.clear();
    realTick(DT);
    r.t += DT;
    r.frames++;
    const th = g.director.threat;
    if (th > r.maxThreat) r.maxThreat = th;
    if (g.director.chasing > 0) r.chaseTime += DT;
    if (r.trace && r.frames % 10 === 0) r.trace.push([+g.player.position.x.toFixed(2), +g.player.position.z.toFixed(2)]);
    if (r.onTick) r.onTick();
    if (r.caught || g.state === 'caught' || g.state === 'dead') throw CAUGHT;
    if (r.success && !r.continueAfterGoal) throw GOAL;
    if (r.t > r.timeLimit) throw TIMEOUT;
  };
  B.wait = (s) => {
    const end = B.run.t + s;
    B.held.clear();
    while (B.run.t < end) B.tick();
  };
  B.waitUntil = (fn, timeout = 120) => {
    const end = B.run.t + timeout;
    B.held.clear();
    while (B.run.t < end) {
      if (fn()) return true;
      B.tick();
    }
    return false;
  };
  B.stance = (s) => {
    const p = g.player;
    if (s === 'crouch' && !p.crouched) B.press.add('KeyC');
    if ((s === 'walk' || s === 'stand') && p.crouched) B.press.add('KeyC');
  };
  B.setStanceNow = (s) => {
    B.stance(s);
    B.tick();
  };

  // --- perception helpers (what a player can see on screen) --------------------------------------
  B.s = (id) => g.director.snatchers.find((s) => s.id === id);
  B.det = () => {
    let m = 0;
    for (const s of g.director.snatchers) if (s.active && s.detection > m) m = s.detection;
    return m;
  };
  B.chasing = () => g.director.chasing > 0;
  B.calling = () => !!g.leviathan.calling;
  B.callLeft = () => (g.leviathan.calling ? (window.__CONFIG?.callDuration ?? 4.6) - g.leviathan.callTime : 0);
  B.dist = (s, x, z) => Math.hypot(s.position.x - x, s.position.z - z);
  B.pdist = (x, z) => Math.hypot(g.player.position.x - x, g.player.position.z - z);
  B.engaged = () => g.director.snatchers.some((s) => s.active && ['chase', 'search', 'investigate', 'suspicious'].includes(s.state));
  // Could snatcher `s` see a crouched player at (x, z) right now (cone + LOS, ignoring light)?
  B.couldSee = (s, x, z, { range = 28, eye = 0.95, margin = 0 } = {}) => {
    const e = s.getEyePos(new window.__THREE_V());
    const dx = x - e.x, dz = z - e.z;
    const d = Math.hypot(dx, dz);
    if (d > range) return false;
    const a = Math.abs(Math.atan2(Math.sin(dirToYaw(dx, dz) - (s.yaw + s.headYaw)), Math.cos(dirToYaw(dx, dz) - (s.yaw + s.headYaw))));
    if (a > (115 * Math.PI) / 360 + margin) return false;
    const t = new window.__THREE_V(x, eye, z);
    const c = new window.__THREE_V(x, eye * 0.62, z);
    return !g.world.segmentBlocked(e, t) || !g.world.segmentBlocked(e, c);
  };

  // Estimated detection per second a crouch-moving player at (x, z) would give snatcher `s` right
  // now (the AI's own model, simplified): what a careful player judges by watching them. The cone
  // is widened by `margin` radians because heads scan and patrols glance around.
  const CURVE = [[0, 3.0], [3, 2.0], [6, 1.3], [10, 0.7], [15, 0.42], [20, 0.28], [28, 0.15], [40, 0.1]];
  const curve = (d) => {
    if (d <= 0) return CURVE[0][1];
    for (let i = 1; i < CURVE.length; i++) {
      if (d <= CURVE[i][0]) {
        const [x0, y0] = CURVE[i - 1], [x1, y1] = CURVE[i];
        return y0 + (y1 - y0) * ((d - x0) / (x1 - x0));
      }
    }
    return 0;
  };
  const _e = () => new window.__THREE_V();
  B.exposure = (s, x, z, { margin = 0.35, stance = 0.5, eye = 0.95 } = {}) => {
    if (!s.active || s.state === 'rapture' || s.state === 'grab') return 0;
    if (g.director.calling && s.brain.raptureAt === null) return 0;
    if (g.time < s.brain.ignoreUntil) return 0;
    const e = s.getEyePos(_e());
    const dx = x - e.x, dz = z - e.z;
    const d = Math.hypot(dx, dz);
    const range = s.brain.asleep ? 9 : 28 * (s.state === 'search' ? 1.1 : 1);
    if (d > range) return 0;
    const look = s.yaw + s.headYaw;
    const a = Math.abs(Math.atan2(Math.sin(dirToYaw(dx, dz) - look), Math.cos(dirToYaw(dx, dz) - look)));
    if (a > (115 * Math.PI) / 360 + margin) return 0;
    const head = new window.__THREE_V(x, eye, z);
    const chest = new window.__THREE_V(x, eye * 0.62, z);
    const v1 = !g.world.segmentBlocked(e, head), v2 = !g.world.segmentBlocked(e, chest);
    const vis = v1 && v2 ? 1 : v1 || v2 ? 0.6 : 0;
    if (!vis) return 0;
    const focus = a < 0.35 + margin ? 1 : 0.45;
    const light = 0.45 + 0.9 * g.atmosphere.lightLevelAt({ x, z });
    const sf = { suspicious: 1.3, investigate: 1.3, search: 1.6, alarm: 0.35 }[s.state] ?? 1;
    return curve(d) * focus * stance * light * sf * vis * (s.brain.asleep ? 0.25 : 1) * (s.def.kind === 'devout' ? 1.5 : 1);
  };
  // Worst exposure along the straight hop from the player to (x, z) (sampled every metre).
  B.hopExposure = (x, z, o = {}) => {
    const p = g.player.position;
    const n = Math.max(1, Math.ceil(Math.hypot(x - p.x, z - p.z)));
    let worst = 0, who = null;
    for (const s of g.director.snatchers) {
      if (!s.active) continue;
      for (let k = 0; k <= n; k++) {
        const v = B.exposure(s, p.x + ((x - p.x) * k) / n, p.z + ((z - p.z) * k) / n, o);
        if (v > worst) {
          worst = v;
          who = s.id;
        }
      }
    }
    return { worst, who };
  };
  B.hereExposure = (o = {}) => {
    const p = g.player.position;
    let worst = 0;
    for (const s of g.director.snatchers) worst = Math.max(worst, B.exposure(s, p.x, p.z, o));
    return worst;
  };
  // Cover-to-cover: for each point, wait (crouched, still) until the hop there looks unwatched,
  // then crouch-walk it. Stops mid-hop if it becomes watched while we are still unseen.
  B.sneak = (pts, o = {}) => {
    const th = o.threshold ?? 0.09;
    for (const [x, z, extra] of pts) {
      const waitMax = extra?.wait ?? o.wait ?? 60;
      const okWait = B.waitUntil(() => B.det() < (o.detMax ?? 0.25) && B.hopExposure(x, z, o).worst < th && (!extra?.until || extra.until()), waitMax);
      if (!okWait) log('sneak: gave up waiting at', g.player.position.x.toFixed(1), g.player.position.z.toFixed(1), 'for hop to', x, z, 'exposure', B.hopExposure(x, z, o).worst.toFixed(2), B.hopExposure(x, z, o).who);
      if (!B.moveTo(x, z, { stance: extra?.stance || o.stance || 'crouch', tol: 0.5, keepMoving: false,
        pauseIf: () => B.hereExposure(o) < th * 0.5 && B.hopExposure(x, z, o).worst >= th * 1.5 && B.run.t < (B._pauseCap ?? Infinity) })) return false;
    }
    return true;
  };

  // --- fleeing ---------------------------------------------------------------------------------
  // Sprint to a spot 10-28 m away, away from whoever is chasing, with something solid between
  // them and it; crouch there and keep still until nobody is chasing or searching any more.
  // Flees again if a searcher comes too close. Returns true once they have all given up.
  B.hunters = () => g.director.snatchers.filter((s) => s.active && (s.state === 'chase' || s.state === 'search' || s.state === 'suspicious' && s.detection > 0.6));
  B.pickHide = () => {
    const p = g.player.position;
    const hunters = B.hunters();
    const V = window.__THREE_V;
    const eye = new V(), pt = new V();
    let best = null;
    // Where each of them will start looking: where it last saw us, a little along our way.
    const searchFrom = hunters.map((s) => {
      const b = s.brain;
      return { x: b.lastSeenPos.x + b.lastSeenVel.x * 1.6, z: b.lastSeenPos.z + b.lastSeenVel.z * 1.6 };
    });
    for (let k = 0; k < 200; k++) {
      const a = (k / 200) * Math.PI * 2 * 7.3;
      const r = 12 + (k % 12) * 2;
      const x = p.x + Math.cos(a) * r, z = p.z + Math.sin(a) * r;
      if (!g.nav.isWalkable(x, z) || !g.nav.sameRegion(p.x, p.z, x, z)) continue;
      let score = 0, ok = true;
      hunters.forEach((s, i) => {
        const dx = x - s.position.x, dz = z - s.position.z;
        const away = ((x - p.x) * (p.x - s.position.x) + (z - p.z) * (p.z - s.position.z)) / (r * (Math.hypot(p.x - s.position.x, p.z - s.position.z) || 1));
        if (away < 0.2) ok = false;
        s.getEyePos(eye);
        pt.set(x, 0.7, z);
        if (!g.world.segmentBlocked(eye, pt)) score -= 3;
        const sf = searchFrom[i];
        const ds = Math.hypot(x - sf.x, z - sf.z);
        if (ds < 11) score -= (11 - ds) * 0.4; // inside its search circle
        score += Math.min(Math.hypot(dx, dz), 30) * 0.1 + away;
      });
      // nowhere near the others either (a shriek is about to bring them)
      for (const s of g.director.snatchers) if (s.active && !hunters.includes(s) && Math.hypot(x - s.position.x, z - s.position.z) < 9) score -= 3;
      // something tall right next to it to crouch behind
      const cover = g.world.query(x - 1.2, z - 1.2, x + 1.2, z + 1.2).some((c) => c.enabled && c.blocksSight && c.maxY >= 1.0 && c.minY < 0.5);
      if (cover) score += 1.5;
      if (!ok) continue;
      if (g.atmosphere.lightLevelAt({ x, z }) > 0.35) score -= 2;
      if (!best || score > best.score) {
        // Only somewhere we can actually run to without a long detour or passing them.
        const path = g.nav.findPath(p, { x, z }, { maxExpansions: 6000 });
        if (!path) continue;
        let len = 0, px = p.x, pz = p.z, nearHunter = false;
        for (const q of path) {
          len += Math.hypot(q.x - px, q.z - pz);
          px = q.x;
          pz = q.z;
          for (const s of g.director.snatchers) {
            if (s.active && Math.hypot(q.x - s.position.x, q.z - s.position.z) < (hunters.includes(s) ? 4 : 6)) nearHunter = true;
          }
        }
        if (nearHunter || len > r * 1.5 + 3) continue;
        best = { x, z, score };
      }
    }
    return best;
  };
  B.fleeAndHide = ({ maxFlees = 4, hideTime = 60 } = {}) => {
    for (let n = 0; n < maxFlees; n++) {
      const spot = B.pickHide();
      if (!spot) {
        log('flee: nowhere to hide');
        return false;
      }
      log('flee ->', spot.x.toFixed(1), spot.z.toFixed(1), 'score', spot.score.toFixed(1));
      B.moveTo(spot.x, spot.z, { stance: 'sprint', tol: 0.8, timeout: 20 });
      B.setStanceNow('crouch');
      const t0 = B.run.t;
      let fleeAgain = false;
      while (B.run.t - t0 < hideTime) {
        B.held.clear();
        B.tick();
        if (!B.hunters().length && g.director.snatchers.every((s) => !s.active || s.state !== 'investigate' || B.dist(s, g.player.position.x, g.player.position.z) > 8)) {
          log('flee: they gave up');
          return true;
        }
        const close = g.director.snatchers.some((s) => s.active && (s.state === 'chase' || s.state === 'search') && B.dist(s, g.player.position.x, g.player.position.z) < (s.state === 'chase' ? 9 : 5));
        if (close) {
          fleeAgain = true;
          break;
        }
      }
      if (!fleeAgain) return !B.hunters().length;
    }
    return false;
  };

  // --- movement ---------------------------------------------------------------------------------
  B.findPath = (x, z) => g.nav.findPath(g.player.position, { x, z }, { maxExpansions: 400000 });
  B.moveTo = (x, z, o = {}) => {
    const stance = o.stance || 'crouch';
    const tol = o.tol ?? 0.6;
    const start = B.run.t;
    const p = g.player.position;
    let path = o.direct ? [{ x, z }] : B.findPath(x, z) || [{ x, z }];
    let i = 0;
    let lastT = B.run.t, lastX = p.x, lastZ = p.z, repaths = 0, strafeUntil = -1, strafeKey = 'KeyA';
    for (;;) {
      if (Math.hypot(x - p.x, z - p.z) < tol) break;
      if (o.abortIf && o.abortIf()) {
        B.held.clear();
        return false;
      }
      if (o.pauseIf && o.pauseIf()) {
        B.held.clear();
        if (stance !== 'sprint') B.stance(stance);
        B.tick();
        lastT = B.run.t;
        continue;
      }
      while (i < path.length - 1 && Math.hypot(path[i].x - p.x, path[i].z - p.z) < 0.5) i++;
      const wp = path[i];
      g.player.yaw = dirToYaw(wp.x - p.x, wp.z - p.z);
      if (o.pitch !== undefined) g.player.pitch = o.pitch;
      B.held.clear();
      B.held.add('KeyW');
      // Something the nav grid doesn't know about (a leviathan needle) is in the way: strafe.
      if (B.run.t < strafeUntil) B.held.add(strafeKey);
      if (stance === 'sprint') B.held.add('ShiftLeft');
      else B.stance(stance);
      B.tick();
      if (B.run.t - lastT > 0.8) {
        if (Math.hypot(p.x - lastX, p.z - lastZ) < 0.25) {
          const feet = g.world.query(p.x - 1.5, p.z - 1.5, p.x + 1.5, p.z + 1.5).filter((c) => c.enabled && c.tag === 'leviathan-foot').length;
          if (feet) B.run.footBlocks = (B.run.footBlocks || 0) + 1;
          if (++repaths > 7) {
            log('moveTo stuck at', p.x.toFixed(1), p.z.toFixed(1), '->', x, z, 'path', JSON.stringify(path.map((q) => [+q.x.toFixed(1), +q.z.toFixed(1)])), 'i', i,
              'walkable', g.nav.isWalkable(p.x, p.z), 'feet', feet, 'speed', g.player.speed.toFixed(2), 'state', g.state);
            B.held.clear();
            return false;
          }
          strafeKey = repaths % 2 ? 'KeyA' : 'KeyD';
          strafeUntil = B.run.t + 0.5 + repaths * 0.15;
          if (repaths > 2) {
            path = B.findPath(x, z) || [{ x, z }];
            i = 0;
          }
        }
        lastT = B.run.t;
        lastX = p.x;
        lastZ = p.z;
      }
      if (B.run.t - start > (o.timeout ?? 90)) {
        log('moveTo timeout ->', x, z);
        B.held.clear();
        return false;
      }
    }
    if (!o.keepMoving) B.held.clear();
    return true;
  };
  B.path = (pts, o = {}) => {
    for (const [x, z] of pts) if (!B.moveTo(x, z, { ...o, keepMoving: true })) return false;
    B.held.clear();
    return true;
  };

  // --- throwing ---------------------------------------------------------------------------------
  // Simulate the real projectile (same integration as Projectiles.update) for a given pitch.
  B.simulateThrow = (yaw, pitch) => {
    const P = window.__PLAYER_CFG;
    const pl = g.player;
    const cp = Math.cos(pitch);
    const fwd = { x: -Math.sin(yaw) * cp, y: Math.sin(pitch), z: -Math.cos(yaw) * cp };
    const pos = new window.__THREE_V(pl.position.x + fwd.x * 0.4, pl.position.y + pl.eyeHeight + fwd.y * 0.4 - 0.15, pl.position.z + fwd.z * 0.4);
    const vel = new window.__THREE_V(fwd.x * P.throwSpeed + pl.velocity.x * 0.5, fwd.y * P.throwSpeed + P.throwUp, fwd.z * P.throwSpeed + pl.velocity.z * 0.5);
    const dir = new window.__THREE_V();
    // (mirrors Projectiles: alarm cars have a padded hit box, except the one thrown from beside)
    const padCar = (q, skip) => {
      for (const col of g.world.query(q.x - 0.6, q.z - 0.6, q.x + 0.6, q.z + 0.6)) {
        if (!col.enabled || !col.data?.alarmCar || col === skip || q.y > col.maxY + 0.9) continue;
        const dx = q.x - col.cx, dz = q.z - col.cz;
        if (Math.abs(col.cos * dx - col.sin * dz) <= col.hx + 0.6 && Math.abs(col.sin * dx + col.cos * dz) <= col.hz + 0.6) return col;
      }
      return null;
    };
    const skip = padCar(pos, null);
    for (let age = 0; age < 6; age += DT) {
      vel.y -= 9.8 * DT;
      const step = vel.length() * DT;
      dir.copy(vel).normalize();
      const hit = g.world.raycast(pos, dir, step, { filter: (c) => c.blocksMove || c.blocksSight });
      if (hit) return { x: hit.point.x, y: hit.point.y, z: hit.point.z, collider: hit.collider };
      pos.addScaledVector(vel, DT);
      const col = padCar(pos, skip);
      if (col) return { x: pos.x, y: pos.y, z: pos.z, collider: col };
      if (pos.y <= 0.03) return { x: pos.x, y: 0.03, z: pos.z, collider: null };
    }
    return { x: pos.x, y: pos.y, z: pos.z, collider: null };
  };
  // Aim at a target: {x, y, z} (+ optional collider: a direct hit on it is preferred). Returns the
  // predicted impact, or null if nothing lands within maxMiss metres.
  B.solveThrow = (t, { maxMiss = 1.5, prefer = 'low' } = {}) => {
    const p = g.player.position;
    const yaw = dirToYaw(t.x - p.x, t.z - p.z);
    let best = null;
    for (let pitch = -0.4; pitch <= 1.25; pitch += 0.005) {
      const imp = B.simulateThrow(yaw, pitch);
      const direct = t.collider && imp.collider === t.collider;
      const miss = direct ? 0 : Math.hypot(imp.x - t.x, imp.z - t.z);
      const score = miss + (prefer === 'low' ? pitch * 0.01 : -pitch * 0.01);
      if (!best || score < best.score) best = { yaw, pitch, imp, miss, score, direct };
      if (direct && prefer === 'low') break;
    }
    return best && best.miss <= maxMiss ? best : null;
  };
  B.throwAt = (t, o = {}) => {
    if (g.player.bottles <= 0) {
      log('throwAt: no bottles');
      return false;
    }
    B.held.clear();
    B.waitUntil(() => g.player.speed < 0.05 && Math.hypot(g.player.velocity.x, g.player.velocity.z) < 0.05, 2);
    const sol = B.solveThrow(t, o);
    if (!sol) {
      log('throwAt: no solution for', t.x, t.z);
      return false;
    }
    g.player.yaw = sol.yaw;
    g.player.pitch = sol.pitch;
    B.press.add('KeyF');
    B.tick();
    log('throw -> predicted impact', sol.imp.x.toFixed(1), sol.imp.z.toFixed(1), sol.direct ? '(direct hit)' : `miss ${sol.miss.toFixed(2)}`);
    B.run.throws++;
    g.player.pitch = 0;
    return sol;
  };

  // --- interaction ------------------------------------------------------------------------------
  B.pickup = (x, z, o = {}) => {
    const before = g.player.bottles;
    if (!B.moveTo(x, z, { ...o, tol: 1.1 })) return false;
    const p = g.player.position;
    g.player.yaw = dirToYaw(x - p.x, z - p.z);
    g.player.pitch = -0.6;
    const ok = B.waitUntil(() => g.player.focus && g.player.focus.id?.startsWith('bottle'), 1);
    if (ok) B.press.add('KeyE');
    B.tick();
    B.tick();
    g.player.pitch = 0;
    const got = g.player.bottles > before;
    log('pickup at', x, z, got ? 'ok' : 'FAILED', 'bottles', g.player.bottles);
    return got;
  };
  B.cutChain = (o = {}) => {
    const gate = g.level.gate;
    if (!gate || gate.open) return true;
    const ip = gate.interactable.pos;
    if (!B.moveTo(ip.x, ip.z + 1.0, { stance: o.stance || 'crouch', tol: 0.4, ...o })) return false;
    const p = g.player.position;
    g.player.yaw = dirToYaw(ip.x - p.x, ip.z - p.z);
    const start = B.run.t;
    B.held.clear();
    while (!gate.open) {
      if (o.abortIf && o.abortIf()) {
        B.held.clear();
        return false;
      }
      B.held.add('KeyE');
      B.tick();
      if (B.run.t - start > 6) {
        log('cutChain: no progress, focus', g.player.focus?.id);
        B.held.clear();
        return false;
      }
    }
    B.held.clear();
    return true;
  };

  // --- running a policy -------------------------------------------------------------------------
  const GOALS = ['main', 'plaza', 'boulevard', 'overpass', 'exit'];
  B.reset = (cpIndex) => {
    const L = g.level;
    const cp = L.checkpoints[cpIndex];
    for (const pk of L.pickups) if (pk.taken) L.setPickup(pk, false);
    L.reached.clear();
    for (const c of L.checkpoints) if ((c.order ?? 0) <= (cp.order ?? 0)) L.reached.add(c.id);
    g.checkpoint = cp;
    g.checkpointBottles = cp.bottles ?? 0;
    g.input.reset();
    B.held.clear();
    B.press.clear();
    g.respawn();
    g.player.pitch = 0;
  };
  B.runPolicy = (zone, name, runIndex, opts = {}) => {
    const pol = window.__policies?.[zone]?.[name];
    if (!pol) return { error: `no policy ${zone}/${name}` };
    B.reset(zone);
    const perf = g.director.perf;
    const perf0 = { paths: perf.paths, pathMs: perf.pathMs, wall: performance.now() };
    perf.maxPathMs = 0;
    const r = {
      zone, name, runIndex, t: 0, frames: 0, goal: GOALS[zone], success: false, caught: false, caughtBy: null,
      alerts: 0, alertIds: [], suspicious: 0, alarms: 0, throws: 0, checkpoints: [], exits: 0, maxThreat: 0, chaseTime: 0,
      timeLimit: opts.timeLimit ?? 420, trace: opts.trace ? [] : null, log: [], outcome: '',
    };
    B.run = r;
    const ctx = { run: runIndex, rnd: mulberry(runIndex * 9973 + zone * 131 + 7), offset: opts.offset ?? 0 };
    try {
      if (ctx.offset > 0) B.wait(ctx.offset);
      pol(B, ctx);
      // Policy returned without reaching the goal: keep still for a while (a checkpoint is only
      // banked once nobody is chasing; whoever is will catch up or give up).
      B.waitUntil(() => r.success, opts.endWait ?? 15);
      r.outcome = r.success ? 'goal' : 'gave-up';
    } catch (e) {
      if (e === CAUGHT) r.outcome = 'caught';
      else if (e === GOAL) r.outcome = 'goal';
      else if (e === TIMEOUT) r.outcome = 'timeout';
      else {
        r.outcome = 'error';
        r.error = String(e && e.stack ? e.stack : e);
      }
    }
    B.held.clear();
    g.input.reset();
    B.run = null;
    r.pos = [+g.player.position.x.toFixed(1), +g.player.position.z.toFixed(1)];
    r.time = +r.t.toFixed(1);
    r.maxThreat = +r.maxThreat.toFixed(2);
    r.chaseTime = +r.chaseTime.toFixed(1);
    r.paths = perf.paths - perf0.paths;
    r.pathMs = +(perf.pathMs - perf0.pathMs).toFixed(0);
    r.maxPathMs = +perf.maxPathMs.toFixed(1);
    r.wall = +((performance.now() - perf0.wall) / 1000).toFixed(1);
    delete r.t;
    return r;
  };
  function mulberry(a) {
    return () => {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  B.dirToYaw = dirToYaw;
  window.__bot = B;
  return true;
}
