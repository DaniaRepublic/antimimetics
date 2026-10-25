// Gameplay tunables. Keep balance numbers here rather than scattered through modules.
export const CONFIG = {
  player: {
    radius: 0.35,
    eyeStand: 1.65,
    eyeCrouch: 0.95,
    walkSpeed: 3.0,
    crouchSpeed: 1.45,
    sprintSpeed: 6.0,
    accel: 14,
    sprintDrain: 1 / 5.0, // stamina per second while sprinting (full bar = 5s)
    staminaRegen: 1 / 7.0,
    staminaRegenDelay: 1.0,
    exhaustedThreshold: 0.3, // must regen to this before sprinting again
    lookSensitivity: 0.0022,
    throwSpeed: 15,
    throwUp: 3.2,
    maxBottles: 3,
    interactRange: 2.2,
  },

  // Radius (m) in which a sound is audible to snatchers.
  noise: {
    crouchStep: 2.2,
    walkStep: 7.5,
    sprintStep: 17,
    landExhausted: 4, // heavy breathing when out of stamina, emitted periodically
    bottle: 20,
    alarm: 48,
    maskStrength: 0.75, // fraction by which leviathan noise mask can shrink player noise
  },

  enemy: {
    radius: 0.4,
    eyeHeight: 1.95,
    patrolSpeed: 1.25,
    investigateSpeed: 1.75,
    searchSpeed: 1.5,
    chaseSpeed: 3.9, // "fast walking": faster than the player's walk, slower than a sprint
    turnSpeed: 4.0, // rad/s body turn
    viewDistance: 28,
    fov: (115 * Math.PI) / 180, // full cone
    focusFov: (40 * Math.PI) / 180,
    proximitySense: 2.2, // within this range they notice a moving player in any direction
    catchRadius: 1.15,
    loseSightMemory: 1.6, // seconds they keep "knowing" where you are after losing LOS
    searchDuration: 14,
    alertShoutRadius: 26,
  },

  leviathan: {
    callIntervalCalm: [32, 48],
    callIntervalNear: [10, 13],
    callDuration: 4.6,
  },

  nav: {
    cell: 0.5,
    agentRadius: 0.45,
  },
};
