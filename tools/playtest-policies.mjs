// Playtest policies, installed into the page next to the bot (tools/playtest-bot.mjs).
// window.__policies[zone][name] = (B, ctx) => { ... }   ctx = { run, rnd, offset }
// Each policy starts at the zone's checkpoint (an ordinary respawn) and tries to reach the next
// one (Z4: the exit). 'intended' = the careful solution the zone is designed around; the others
// are what an impatient player does.
export function installPolicies() {
  const P = (window.__policies = { 0: {}, 1: {}, 2: {}, 3: {}, 4: {} });

  // ============================================================================================
  // Z0 -- the alley: pick up the bottle, walk out to Main Street.
  P[0].intended = (B) => {
    B.pickup(0.9, -2.7, { stance: 'walk' });
    B.moveTo(0, -22.5, { stance: 'walk' });
  };
  P[0].careless = (B) => {
    B.moveTo(0, -22.5, { stance: 'sprint' });
  };

  // ============================================================================================
  // Z1 -- Main Street. Patrol loops up the east lanes and back down the west; sentry in the
  // laundromat light (west, z -90) scanning east. Way on: the pharmacy door (x 12, z -119.4).
  P[1].intended = (B) => {
    const pat = B.s('z1_patrol');
    const crosser = B.s('z0_crosser');
    B.setStanceNow('crouch');
    B.sneak([[6.2, -38.2]]);
    // Let the patrol get well up the east lanes, its back to us.
    B.waitUntil(() => pat.state === 'patrol' && [4, 5].includes(pat.brain.routeIndex) && pat.position.z < -60, 240);
    B.sneak([[7.6, -46.5], [7.2, -57.5], [4.6, -66.5]]);
    // The cross street: go while the crosser is walking away to the west.
    B.waitUntil(() => crosser.brain.routeIndex === 0 || (crosser.brain.routeIndex === 5 && crosser.position.x < 3), 120);
    B.sneak([[7.4, -79.0], [11.2, -79.6], [11.2, -84.8], [10.9, -88.6], [9.4, -95]]);
    // In the dark pocket behind the bus. On once the patrol has turned back south.
    B.waitUntil(() => pat.state === 'patrol' && [8, 9, 10, 11, 12, 0, 1].includes(pat.brain.routeIndex), 240);
    B.sneak([[8.6, -106], [10.6, -112], [12.8, -119.4], [16.5, -121], [20.9, -133.5], [21, -139]]);
  };
  // Walk upright straight up the middle of the street, then into the pharmacy.
  P[1].careless = (B) => {
    B.path([[0, -60], [0, -100], [0, -115], [12.8, -119.4], [16.5, -121], [20.9, -133.5], [21, -139]], { stance: 'walk' });
  };
  P[1].sprint = (B) => {
    B.path([[0, -60], [0, -100], [0, -115], [12.8, -119.4], [16.5, -121], [20.9, -133.5], [21, -139]], { stance: 'sprint' });
  };

  // ============================================================================================
  // Z2 -- the plaza. Four guards around the arch (north). The alarm car sits at the gas station
  // (west, ~42 m from them). Set it off from a distance, then slip round the east side.
  const Z2_GUARDS = ['z2_sentry_w', 'z2_sentry_e', 'z2_wander', 'z2_patrol'];
  const plazaCar = (B) => B.g.level.alarms.find((a) => a.id === 'plaza_alarm');
  P[2].intended = (B) => {
    const g = B.g;
    B.setStanceNow('crouch');
    B.pickup(17.6, -146.6);
    B.sneak([[8, -152.5], [-6, -155.5], [-10.5, -158]]);
    const car = plazaCar(B);
    const c = car.collider;
    B.throwAt({ x: c.cx, y: 0.9, z: c.cz, collider: c });
    if (!B.waitUntil(() => car.active, 4)) {
      B.log('alarm did not start; second bottle');
      B.throwAt({ x: c.cx, y: 0.9, z: c.cz, collider: c });
    }
    // They all go to it: wait until every guard is on its way, then go round the east side.
    B.waitUntil(() => Z2_GUARDS.every((id) => B.s(id).state === 'alarm'), 8);
    B.sneak([[6, -160], [17, -166], [19.5, -182], [17.5, -196.5], [7.5, -203], [2.2, -207.5], [2.2, -215]], { stance: 'walk', wait: 15 });
  };
  // ============================================================================================
  // Z3 -- the boulevard. Devouts on both sidewalks; the leviathan calls every 10-13 s. Hop from
  // pocket to pocket only while it calls (walking), freeze crouched in between.
  // Pockets (from tools/playtest-map.mjs --exposure): [south entry, north staging point].
  const Z3_POCKETS = [
    [[-1.2, -236.4], [-1.0, -238.3]], // planters
    [[-0.6, -250.2], [-0.8, -255.5]], // burnt bus + pickup
    [[1.0, -267.5], [1.0, -269.6]], // statue + planter
    [[0.2, -281.2], [0.4, -287.0]], // car + kiosk
    [[1.8, -299.0], [1.8, -305.0]], // overturned truck + its crates
    [[-1.2, -316.2], [-1.0, -322.5]], // hatch + pickup
    [[-0.3, -331.0], [-0.3, -339.5]], // van + hatch, then out
  ];
  P[3].intended = (B) => {
    const g = B.g;
    B.setStanceNow('crouch');
    // Walk to (x, z) during a call. Starts ~0.4 s into a call (reaction time), only if the call
    // has time left for the walk; then crouches again.
    const hop = (x, z) => {
      const p = g.player.position;
      const need = Math.hypot(x - p.x, z - p.z) / 3.0;
      B.waitUntil(() => B.calling() && g.leviathan.callTime > 0.4 && B.callLeft() > need - 0.6, 90);
      const t0 = B.run.t;
      const ok = B.moveTo(x, z, { stance: 'walk', tol: 0.5 });
      B.setStanceNow('crouch');
      B.log(`hop -> ${x} ${z} took ${(B.run.t - t0).toFixed(2)} s, call left ${B.callLeft().toFixed(2)}`);
      return ok;
    };
    B.moveTo(0.5, -226, { stance: 'crouch' });
    for (const [[ex, ez], [sx, sz]] of Z3_POCKETS) {
      hop(ex, ez);
      B.moveTo(sx, sz, { stance: 'crouch', tol: 0.5 });
    }
  };
  P[3].careless = (B) => {
    B.path([[0, -230], [-6, -260], [-8, -300], [-6, -340]], { stance: 'walk' });
  };
  P[3].sprint = (B) => {
    B.path([[0, -230], [-6, -260], [-8, -300], [-6, -340]], { stance: 'sprint' });
  };
  // Crouch-walks straight through, ignoring the calls.
  P[3].crouch = (B) => {
    B.setStanceNow('crouch');
    B.moveTo(-2.2, -232.8, { stance: 'crouch' });
    B.path([[-1.4, -250], [1, -270], [0.9, -287], [1.2, -305], [-1.4, -322], [-4, -340]], { stance: 'crouch' });
  };

  P[2].careless = (B) => {
    B.path([[2, -207], [2, -215]], { stance: 'walk' });
  };
  P[2].sprint = (B) => {
    B.path([[2, -207], [2, -215]], { stance: 'sprint' });
  };

  // ============================================================================================
  // Z4 -- the highway approach. A patrol paces the floodlit ramp in front of the chained gate
  // (z -395); the parking structure to the west (x -44..-13) is the quiet way round, with a
  // sleeper slumped in its east aisle (x -18.4, z -388) facing the street.
  const Z4_RUN = [[0, -399], [-1.5, -412], [-2.5, -433]];
  // (a) The gate: pull the patrol away with a bottle, cut the chain while it looks, then run.
  P[4].gate = (B) => {
    const pat = B.s('z4_patrol');
    B.setStanceNow('crouch');
    B.pickup(-10.2, -349.8);
    // Cover: the car queue, then the west overpass pier (the patrol's loop is 9-24 m north of it).
    B.sneak([[-8.6, -356.5], [-6.6, -365.5]]);
    // Throw once the patrol is on the east half of its loop, near enough to hear the shatter.
    const T = { x: 10.2, y: 0.2, z: -363.5 };
    B.waitUntil(() => pat.state === 'patrol' && Math.hypot(pat.position.x - T.x, pat.position.z - T.z) < 17.5 && pat.position.x > 0, 90);
    B.throwAt(T, { maxMiss: 2 });
    B.waitUntil(() => pat.state === 'investigate' || pat.state === 'suspicious', 4);
    // Wait until it is walking away east, then go up the dark west lane to the gate.
    B.waitUntil(() => pat.state === 'investigate' && pat.position.x > 3, 12);
    B.path([[-9.2, -373], [-8.4, -386.5], [-2.2, -392.8]], { stance: 'walk' });
    B.cutChain({ stance: 'walk' });
    B.path(Z4_RUN, { stance: 'sprint' });
  };
  // (b) The quiet way: through the parking structure's middle aisle, well behind the sleeper.
  P[4].garage = (B) => {
    B.setStanceNow('crouch');
    B.moveTo(-15.2, -343, { stance: 'crouch' });
    B.path([[-27.6, -349], [-28.1, -372]], { stance: 'walk' });
    B.path([[-28.1, -404]], { stance: 'crouch' });
    B.path([[-28.1, -419], [-17, -421], [-12.4, -420.8], [-6, -425], [-2.5, -433]], { stance: 'walk' });
  };
  // Careless: walk straight up the road to the gate, cut the chain in the floodlight, walk on.
  P[4].careless = (B) => {
    B.path([[-6, -360], [-1.5, -390]], { stance: 'walk' });
    B.cutChain({ stance: 'walk' });
    B.path(Z4_RUN, { stance: 'walk' });
  };
  P[4].sprint = (B) => {
    B.path([[-6, -360], [-1.5, -390]], { stance: 'sprint' });
    B.cutChain({ stance: 'walk' });
    B.path(Z4_RUN, { stance: 'sprint' });
  };
  // Careless in the garage: walk upright straight up the east aisle, right past the sleeper.
  P[4]['garage-walk'] = (B) => {
    B.moveTo(-15.2, -343, { stance: 'walk' });
    B.path([[-17, -360], [-17.2, -415], [-12.4, -420.8], [-6, -425], [-2.5, -433]], { stance: 'walk' });
  };
}
