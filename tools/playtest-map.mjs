// Top-down tactical map of the real level, one PNG per zone: nav grid, colliders (sight-blocking
// cover darker), stealth light radii, snatcher posts / view cones / patrol routes, pickups, alarm
// cars and checkpoint areas. Optional overlays: bot traces written by tools/playtest.mjs --trace.
//
//   node build.mjs && node tools/playtest-map.mjs [--zones 1,2] [--scale 6] [--out dist/playtest]
//                                                 [--trace dist/playtest/trace-z1.json]
import { launch } from './harness.mjs';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const opt = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
const out = opt('--out', 'dist/playtest');
const scale = Number(opt('--scale', 6));
const zones = opt('--zones', '0,1,2,3,4').split(',').map(Number);
const traceFile = opt('--trace', null);
const trace = traceFile ? JSON.parse(fs.readFileSync(traceFile, 'utf8')) : null;
const exposure = args.includes('--exposure'); // heatmap: worst-case detection/s for a crouched, still player
const customView = opt('--view', null)?.split(',').map(Number); // minX,maxX,minZ,maxZ (with one zone)
fs.mkdirSync(out, { recursive: true });

// Map rectangles per zone (world metres).
const VIEWS = {
  0: { minX: -26, maxX: 26, minZ: -40, maxZ: 10 },
  1: { minX: -24, maxX: 30, minZ: -150, maxZ: -20 },
  2: { minX: -42, maxX: 30, minZ: -222, maxZ: -134 },
  3: { minX: -20, maxX: 20, minZ: -342, maxZ: -208 },
  4: { minX: -46, maxX: 18, minZ: -448, maxZ: -334 },
};

const h = await launch({ query: 'autostart&god&quality=0&mute' });
for (const zi of zones) {
  const view = customView ? { minX: customView[0], maxX: customView[1], minZ: customView[2], maxZ: customView[3] } : VIEWS[zi];
  const url = await h.eval(([view, scale, trace, exposure]) => {
    const g = window.__game;
    g.render = () => {};
    const W = Math.round((view.maxX - view.minX) * scale), H = Math.round((view.maxZ - view.minZ) * scale);
    const cv = document.createElement('canvas');
    cv.width = W;
    cv.height = H;
    const c = cv.getContext('2d');
    const X = (x) => (x - view.minX) * scale;
    const Y = (z) => (z - view.minZ) * scale; // north (-Z) at the top
    c.fillStyle = '#000';
    c.fillRect(0, 0, W, H);
    const nav = g.nav;
    for (let z = view.minZ; z < view.maxZ; z += nav.cell) {
      for (let x = view.minX; x < view.maxX; x += nav.cell) {
        if (!nav.isWalkable(x + nav.cell / 2, z + nav.cell / 2)) continue;
        c.fillStyle = '#2b2b30';
        c.fillRect(X(x), Y(z), nav.cell * scale + 0.5, nav.cell * scale + 0.5);
      }
    }
    // Exposure heatmap: for every walkable cell, the worst detection rate (per second) a crouched,
    // motionless player would give any posted watcher (sentry / devout / sleeper) over its whole
    // scan sweep -- same formula as the AI (distance curve x focus x stance x light x visibility).
    if (exposure) {
      const CURVE = [[0, 3.0], [3, 2.0], [6, 1.3], [10, 0.7], [15, 0.42], [20, 0.28], [28, 0.15], [40, 0.1]];
      const curve = (d) => {
        for (let i = 1; i < CURVE.length; i++) if (d <= CURVE[i][0]) return CURVE[i - 1][1] + (CURVE[i][1] - CURVE[i - 1][1]) * ((d - CURVE[i - 1][0]) / (CURVE[i][0] - CURVE[i - 1][0]));
        return 0.1;
      };
      const V = g.player.position.constructor;
      const eye = new V(), head = new V(), chest = new V();
      const fov = (115 * Math.PI) / 180, focusFov = (40 * Math.PI) / 180;
      const watchers = g.director.snatchers.filter((s) => !s.def.route && s.def.kind !== 'wander');
      const step = 0.5;
      const safeRows = [];
      for (let z = view.minZ; z < view.maxZ; z += step) {
        let rowSafe = null;
        for (let x = view.minX; x < view.maxX; x += step) {
          const cx = x + step / 2, cz = z + step / 2;
          if (!nav.isWalkable(cx, cz)) continue;
          let worst = 0;
          for (const s of watchers) {
            const d0 = s.def;
            const sleeping = !!d0.sleeping;
            const arc = d0.scanArc ?? (d0.kind === 'devout' ? 2.6 : d0.kind === 'sentry' ? 1.6 : 0);
            eye.set(d0.pos.x, 1.95 - (sleeping ? 0.55 : 0), d0.pos.z);
            const dx = cx - eye.x, dz = cz - eye.z;
            const d = Math.hypot(dx, dz);
            const range = sleeping ? 9 : 28;
            if (d > range) continue;
            const bearing = Math.atan2(-dx, -dz);
            const off = Math.abs(Math.atan2(Math.sin(bearing - (d0.yaw ?? 0)), Math.cos(bearing - (d0.yaw ?? 0))));
            const cone = (fov / 2) * (sleeping ? 0.7 : 1) + (sleeping ? 0 : arc / 2);
            if (off > cone) continue;
            head.set(cx, 0.95, cz);
            chest.set(cx, 0.59, cz);
            const v1 = !g.world.segmentBlocked(eye, head), v2 = !g.world.segmentBlocked(eye, chest);
            const vis = v1 && v2 ? 1 : v1 || v2 ? 0.6 : 0;
            if (!vis) continue;
            const focus = off <= arc / 2 + focusFov / 2 ? 1 : 0.45;
            const light = 0.45 + 0.9 * g.atmosphere.lightLevelAt({ x: cx, z: cz });
            const r = curve(d) * focus * 0.4 * light * vis * (sleeping ? 0.25 : 1) * (d0.kind === 'devout' ? 1.5 : 1);
            if (r > worst) worst = r;
          }
          if (worst < 0.035 && Math.abs(cx) <= 9 && (rowSafe === null || Math.abs(cx) < Math.abs(rowSafe))) rowSafe = cx;
          if (worst <= 0.005) continue;
          // < 0.08/s: never reaches 'suspicious' before a call; red = they will notice you.
          const a = Math.min(1, worst / 0.25);
          c.fillStyle = worst < 0.035 ? 'rgba(80,160,255,0.25)' : worst < 0.08 ? `rgba(220,200,60,${0.15 + a})` : `rgba(255,${Math.round(120 - 120 * a)},40,${0.35 + 0.5 * a})`;
          c.fillRect(X(x), Y(z), step * scale + 0.5, step * scale + 0.5);
        }
        safeRows.push([z + step / 2, rowSafe]);
      }
      // Safe z-intervals (some cell with |x| <= 9 under 0.035/s): what the boulevard's pockets give.
      const iv = [];
      for (const [z, sx] of safeRows) {
        const last = iv[iv.length - 1];
        if (sx === null) continue;
        if (last && z - last.z1 <= 0.51) {
          last.z1 = z;
          last.x1 = sx;
        } else iv.push({ z0: z, z1: z, x0: sx, x1: sx });
      }
      window.__safeIntervals = iv.map((v) => [v.z0, v.z1, v.x0, v.x1]);
    }
    // lights (stealth radius)
    for (const r of g.atmosphere.lights.records) {
      const s = r.src;
      const R = s.stealthRadius ?? 6;
      if ((s.stealthWeight ?? 0.8) < 0.05 || R < 0.5) continue;
      const grd = c.createRadialGradient(X(s.pos.x), Y(s.pos.z), 0, X(s.pos.x), Y(s.pos.z), R * scale);
      grd.addColorStop(0, `rgba(255,220,90,${0.45 * (s.stealthWeight ?? 0.8)})`);
      grd.addColorStop(1, 'rgba(255,220,90,0)');
      c.fillStyle = grd;
      c.beginPath();
      c.arc(X(s.pos.x), Y(s.pos.z), R * scale, 0, Math.PI * 2);
      c.fill();
    }
    // colliders
    for (const col of g.world.colliders) {
      if (!col.enabled) continue;
      if (col.maxX < view.minX || col.minX > view.maxX || col.maxZ < view.minZ || col.minZ > view.maxZ) continue;
      const tall = col.maxY - col.minY;
      if (col.minY > 2.5) continue; // overhead decks
      c.save();
      c.translate(X(col.cx), Y(col.cz));
      c.rotate(-col.rot);
      c.fillStyle = !col.blocksMove ? 'rgba(80,80,160,0.5)' : !col.blocksSight ? 'rgba(90,140,90,0.6)' : tall >= 1.9 ? '#6a6a6a' : tall >= 1.1 ? '#a08a60' : '#605040';
      if (col.data?.alarmCar) c.fillStyle = '#d040d0';
      c.fillRect(-col.hx * scale, -col.hz * scale, col.hx * 2 * scale, col.hz * 2 * scale);
      c.restore();
    }
    // checkpoints
    c.strokeStyle = '#4aa0ff';
    c.lineWidth = 2;
    for (const cp of g.level.checkpoints) {
      const a = cp.area;
      c.strokeRect(X(a.minX), Y(a.minZ), (a.maxX - a.minX) * scale, (a.maxZ - a.minZ) * scale);
      c.fillStyle = '#4aa0ff';
      c.fillText(cp.id, X(cp.pos.x) + 3, Y(cp.pos.z) - 3);
    }
    // pickups
    for (const pk of g.level.pickups) {
      c.fillStyle = '#40ff80';
      c.beginPath();
      c.arc(X(pk.pos.x), Y(pk.pos.z), 3, 0, Math.PI * 2);
      c.fill();
    }
    // snatchers: cones, routes, posts
    const E = { fov: (115 * Math.PI) / 180, view: 28 };
    for (const s of g.director.snatchers) {
      const d = s.def;
      if (d.route) {
        c.strokeStyle = 'rgba(255,120,120,0.8)';
        c.lineWidth = 1.5;
        c.beginPath();
        d.route.forEach((p, i) => (i ? c.lineTo(X(p.x), Y(p.z)) : c.moveTo(X(p.x), Y(p.z))));
        if (d.loop !== false) c.closePath();
        c.stroke();
      }
      const yaw = d.yaw ?? 0;
      const arc = d.scanArc ?? (d.kind === 'devout' ? 2.6 : d.kind === 'sentry' ? 1.6 : 0);
      if (!d.route && d.kind !== 'wander') {
        // forward dir = (-sin yaw, -cos yaw); canvas angle = atan2(dz, dx)
        const ang = (y) => Math.atan2(-Math.cos(y), -Math.sin(y));
        const half = E.fov / 2 + (arc * 0.5) * 1.0;
        const R = d.sleeping ? 9 : E.view;
        c.fillStyle = d.sleeping ? 'rgba(160,120,255,0.15)' : 'rgba(255,60,60,0.10)';
        c.beginPath();
        c.moveTo(X(d.pos.x), Y(d.pos.z));
        c.arc(X(d.pos.x), Y(d.pos.z), R * scale, ang(yaw) - half, ang(yaw) + half);
        c.closePath();
        c.fill();
        c.fillStyle = 'rgba(255,60,60,0.12)';
        c.beginPath();
        c.moveTo(X(d.pos.x), Y(d.pos.z));
        c.arc(X(d.pos.x), Y(d.pos.z), R * scale, ang(yaw) - E.fov / 2, ang(yaw) + E.fov / 2);
        c.closePath();
        c.fill();
      }
      c.fillStyle = d.sleeping ? '#a080ff' : '#ff3030';
      c.beginPath();
      c.arc(X(d.pos.x), Y(d.pos.z), 4, 0, Math.PI * 2);
      c.fill();
      c.fillStyle = '#ffb0b0';
      c.font = '11px monospace';
      c.fillText(s.id, X(d.pos.x) + 5, Y(d.pos.z) + 4);
    }
    // traces
    if (trace) {
      for (const tr of trace) {
        c.strokeStyle = tr.color || (tr.caught ? '#ff4040' : '#40e0ff');
        c.lineWidth = 1.5;
        c.beginPath();
        tr.points.forEach(([x, z], i) => (i ? c.lineTo(X(x), Y(z)) : c.moveTo(X(x), Y(z))));
        c.stroke();
      }
    }
    // grid lines every 10 m
    c.strokeStyle = 'rgba(255,255,255,0.08)';
    c.fillStyle = 'rgba(255,255,255,0.45)';
    c.font = '10px monospace';
    for (let x = Math.ceil(view.minX / 10) * 10; x <= view.maxX; x += 10) {
      c.beginPath(); c.moveTo(X(x), 0); c.lineTo(X(x), H); c.stroke();
      c.fillText(String(x), X(x) + 2, 10);
    }
    for (let z = Math.ceil(view.minZ / 10) * 10; z <= view.maxZ; z += 10) {
      c.beginPath(); c.moveTo(0, Y(z)); c.lineTo(W, Y(z)); c.stroke();
      c.fillText(String(z), 2, Y(z) - 2);
    }
    return cv.toDataURL('image/png');
  }, [view, scale, trace, exposure]);
  if (exposure) {
    const iv = await h.eval(() => window.__safeIntervals || []);
    let prev = null;
    for (const [a, b, xa, xb] of iv) {
      console.log(`  safe z ${a.toFixed(1)} (x ${xa.toFixed(1)}) .. ${b.toFixed(1)} (x ${xb.toFixed(1)})${prev !== null ? `   (gap ${(a - prev).toFixed(1)} m)` : ''}`);
      prev = b;
    }
  }
  const file = path.join(out, `map-z${zi}.png`);
  fs.writeFileSync(file, Buffer.from(url.split(',')[1], 'base64'));
  console.log('wrote', file);
}
if (h.errors.length) console.log('ERRORS:\n' + h.errors.join('\n'));
await h.close();
