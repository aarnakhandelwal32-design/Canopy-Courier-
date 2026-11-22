// Every tunable gameplay number lives here. Units: pixels and seconds.

/** Viewport (logical canvas size). */
export const W = 1280;
export const H = 720;

/** The scrolling world map. */
export const WORLD = { w: 2560, h: 1760, seed: 20261122 } as const;

export const QUOTA = 12; // deliveries needed to win

export const TIME = {
  start: 60, // seconds on the clock at launch
  delivery: 6, // added per delivery
  perfect: 3, // extra for a bullseye drop
  hitPenalty: 3, // lost when a scavenger rams you
  warn: 10, // clock starts ticking below this
} as const;

export const DRONE = {
  r: 22,
  thrust: 1500, // px/s² while a thruster key is held
  drag: 2.2, // exponential velocity damping per second
  maxSpeed: 480,
  loadedMaxSpeed: 400, // a crate on the winch makes you heavier...
  loadedThrust: 0.85, // ...and slower to accelerate
  bounce: 0.45,
} as const;

export const CRATE = {
  size: 30,
  pickRadius: 66, // winch reach from the drone centre
  spring: 55, // rope spring stiffness (crate swings behind you)
  damping: 6,
  maxRope: 70,
  fallTime: 0.45, // seconds from release to touchdown
  airDrag: 1.2,
  active: 2, // crates waiting on the map at once
  respawnDelay: 1,
  minRoute: 700, // destination is at least this far from the pickup cache
} as const;

export const ZONE = { r: 82, perfect: 28 } as const;

export const SCAV = {
  r: 22,
  wander: 150,
  chase: 250,
  chaseMax: 330,
  detect: 360,
  stun: 1.6,
  max: 3,
  perDeliveries: 4, // one extra scavenger every N deliveries
} as const;

export const POINTS = {
  delivery: 100,
  perfect: 50,
  express: 25,
  expressTime: 7, // deliver within N seconds of pickup
  timeBonus: 10, // per second left when you hit the quota
} as const;

export const PALETTE = {
  cream: '#fff6dc',
  ink: '#1d2a18',
  gold: '#ffcf4a',
  danger: '#ff5a4a',
  water: '#4fb0de',
  good: '#8ff07a',
  panel: 'rgba(22, 34, 20, 0.8)',
  grass: '#8cc057',
} as const;

export const FONT = 'ui-rounded, "SF Pro Rounded", "Nunito", "Segoe UI", system-ui, sans-serif';
