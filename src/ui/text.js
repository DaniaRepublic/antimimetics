// Every string the HUD shows. All original writing for this fan project: never quote the novel.

export const TITLE = {
  name: 'WHEN IT CALLS',
  file: 'Recovered field recording — Antimemetics Division',
  // `##` marks a redaction bar.
  ref: 'File ##-0417 · recorder ## · integrity poor',
  subPre: 'a stealth fragment inspired by ',
  subBook: 'There Is No Antimemetics Division',
  phones: 'headphones recommended',
  begin: 'click to begin',
};

export const CONTROLS = [
  ['W A S D', 'move'],
  ['mouse', 'look'],
  ['C', 'crouch'],
  ['Shift', 'sprint'],
  ['E', 'interact / pick up'],
  ['click / F', 'throw bottle'],
  ['Esc', 'pause'],
];

export const INTRO = {
  head: 'Audio transcript · partial',
  lines: [
    'The city went quiet in a single night. No one can tell you which night.',
    'The people in the long capes used to live here. They are wearing what was left of them.',
    'They walk. They never run. They never tire.',
    'Above the rooftops, something enormous is walking through the red.',
    'When it calls, they stop to listen.',
    'You are the last one still inside. Get to the bridge.',
    'Do not be seen.',
  ],
  skip: 'click or space to skip',
  cont: 'click to continue',
};

export const DEATH_LINES = [
  'IT HAS YOUR FACE NOW',
  'YOU WERE SEEN',
  'THE CAPE FITS YOU',
  'SOMETHING ELSE WALKS HOME IN YOUR COAT',
  'NO ONE WILL REMEMBER YOU WERE HERE',
  'IT WAS WEARING SOMEONE YOU KNEW',
  'YOU STOPPED BEING SOMEONE',
  'IT DID NOT HURRY. IT DID NOT NEED TO.',
];

export const DEAD = {
  retry: 'click to try again',
};

export const PAUSE = {
  tag: 'Tape held',
  title: 'PAUSED',
  resume: 'resume',
  restart: 'restart from checkpoint',
  sensitivity: 'mouse sensitivity',
  volume: 'volume',
  fov: 'field of view',
};

export const ENDING = {
  lines: [
    'You are outside the city.',
    'The mist is thinner here.',
    'You are fairly sure you were running from something,',
    'but you cannot remember what it looked like.',
  ],
  end: 'End of recording',
  stats: {
    time: 'time inside',
    spotted: 'times seen',
    deaths: 'times taken',
  },
  again: 'play again',
};

export const HUD_TEXT = {
  checkpoint: 'position marked',
  lockFailed: 'Mouse lock unavailable here — drag to look; F throws',
  holdPrefix: 'hold',
};

// First-zone tutorial (sequential) and one-off contextual hints. [X] renders as a keycap.
export const TUTORIAL = {
  move: '[W][A][S][D] move  ·  mouse to look',
  crouch: '[C] crouch — slower, quieter, harder to see',
  throw: '[F] or click to throw a bottle — they walk toward the sound',
  light: 'the eye shows how visible you are — light gives you away',
  chase: 'they will not run. [Shift] sprint, break their line of sight, then hide',
};
