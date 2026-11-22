// Canopy Courier: game state machine, simulation and world rendering.
//
//   start ──Launch──▶ playing ──quota met / clock hits 0──▶ over ──Rematch──▶ playing
//
// Core loop: FLY to a crate → HOLD the winch to PICK it up → CARRY it (it swings on the rope,
// scavengers try to knock it loose) → RELEASE to DROP it onto the matching camp's landing pad.
import { AudioEngine } from './audio';
import { FX } from './fx';
import { Input } from './input';
import { drawHud, drawMinimap, drawPointer, type Blip } from './hud';
import { buildWorld, isWater, roundRect, shade, type Camp, type Point, type World } from './world';
import { W, H, WORLD, QUOTA, TIME, DRONE, CRATE, ZONE, SCAV, POINTS, PALETTE, FONT } from './config';

export type GameState = 'start' | 'playing' | 'over';
type CrateState = 'ground' | 'carried' | 'falling' | 'delivered' | 'lost';

interface Crate {
  x: number; y: number; vx: number; vy: number;
  h: number; h0: number; // height above ground (0..1); h0 = height at release
  state: CrateState;
  dest: number; // index into world.camps
  rot: number; vr: number;
  fall: number; // 0..1 progress of the drop
  pickedAt: number;
  anim: number; // spawn / deliver / sink animation clock
}

interface Scavenger {
  x: number; y: number; vx: number; vy: number; tx: number; ty: number;
  heading: number; stun: number; alert: boolean; rotor: number;
}

export interface MatchResult {
  victory: boolean; score: number; delivered: number; perfects: number; lost: number; hits: number;
  timeLeft: number; best: number; newBest: boolean; stars: number; title: string;
}

const TAU = Math.PI * 2;
const BEST_KEY = 'canopy-courier.best';
const TITLES = ['GROUNDED', 'ROOKIE COURIER', 'TRUSTED COURIER', 'LEGENDARY COURIER'];
const clamp = (v: number, a: number, b: number): number => Math.max(a, Math.min(b, v));
const rand = (a: number, b: number): number => a + Math.random() * (b - a);
const dist = (a: Point, b: Point): number => Math.hypot(a.x - b.x, a.y - b.y);
const angleDiff = (a: number, b: number): number => ((((b - a + Math.PI) % TAU) + TAU) % TAU) - Math.PI;
/** Horizontal distance a dropped crate travels per unit of release velocity (matches the drag integration). */
const DROP_REACH = (1 - Math.exp(-CRATE.airDrag * CRATE.fallTime)) / CRATE.airDrag;
const CARRY_HEIGHT = 0.75;

export class Game {
  state: GameState = 'start';
  paused = false;
  onMatchOver: (r: MatchResult) => void = () => undefined;

  private readonly ctx: CanvasRenderingContext2D;
  private readonly world: World;
  private readonly fx = new FX();

  private drone = { x: 0, y: 0, vx: 0, vy: 0, heading: 0, thrust: 0, rotor: 0 };
  private crates: Crate[] = [];
  private carried: Crate | null = null;
  private scavs: Scavenger[] = [];
  private respawn: number[] = [];
  private cam = { x: 0, y: 0 };
  private clouds: { x: number; y: number; r: number; vx: number }[] = [];
  private butterflies: { x: number; y: number; vx: number; vy: number; home: Point; phase: number; color: string }[] = [];
  private campFlash: number[] = [];

  private t = 0; // animation clock (always running)
  private time = 0; // match clock (elapsed seconds of play)
  private timeLeft: number = TIME.start;
  private score = 0;
  private delivered = 0;
  private perfects = 0;
  private lost = 0;
  private hits = 0;
  private countdown = 0;
  private lastTick = 99;
  private emitAcc = 0;
  private rope = 0;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly audio: AudioEngine,
    private readonly input: Input,
  ) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D not supported');
    this.ctx = ctx;
    this.world = buildWorld();
    this.campFlash = this.world.camps.map(() => 0);
    this.resize();
    window.addEventListener('resize', () => this.resize());

    for (let i = 0; i < 5; i++) {
      this.clouds.push({ x: rand(0, WORLD.w), y: rand(0, WORLD.h), r: rand(220, 380), vx: rand(10, 22) });
    }
    const flowerCols = ['#ffffff', '#ffe37a', '#ff9ec8', '#c9a3ff', '#7fd1ff'];
    for (let i = 0; i < 16; i++) {
      const home = this.world.flowers[Math.floor(rand(0, this.world.flowers.length))];
      this.butterflies.push({ x: home.x, y: home.y, vx: 0, vy: 0, home, phase: rand(0, TAU), color: flowerCols[i % flowerCols.length] });
    }
    // scenery for the title screen
    this.resetDrone();
    this.spawnCrate(false);
    this.spawnCrate(false);
    this.spawnScav();
    this.spawnScav();
  }

  private resize(): void {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.canvas.width = Math.round(W * dpr);
    this.canvas.height = Math.round(H * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  // ======================================================================= lifecycle

  start(): void {
    this.state = 'playing';
    this.paused = false;
    this.fx.clear();
    this.input.reset();
    this.resetDrone();
    this.crates = [];
    this.carried = null;
    this.scavs = [];
    this.respawn = [];
    this.time = 0;
    this.timeLeft = TIME.start;
    this.score = this.delivered = this.perfects = this.lost = this.hits = 0;
    this.countdown = 3;
    this.lastTick = 99;
    for (let i = 0; i < CRATE.active; i++) this.spawnCrate(false);
    this.spawnScav();
    this.snapCamera();
    this.audio.setScene('play');
    this.audio.countdown(false);
  }

  private resetDrone(): void {
    Object.assign(this.drone, { x: this.world.spawn.x, y: this.world.spawn.y, vx: 0, vy: 0, heading: -Math.PI / 2, thrust: 0 });
  }

  private endMatch(victory: boolean): void {
    if (this.carried) this.drop();
    this.state = 'over';
    this.audio.setHum(0, 0, false);
    this.audio.setScene('silent');
    if (victory) {
      const bonus = Math.round(this.timeLeft) * POINTS.timeBonus;
      this.score += bonus;
      this.fx.banner('ALL CAMPS SUPPLIED!', PALETTE.good, 64, 1.7);
      this.fx.confetti(this.drone.x, this.drone.y, 160);
      this.audio.victory();
    } else {
      this.timeLeft = 0;
      this.fx.banner("TIME'S UP!", PALETTE.danger, 90, 1.7);
      this.audio.defeat();
    }
    let best = 0;
    try {
      best = Number(localStorage.getItem(BEST_KEY)) || 0;
    } catch {
      /* ignore */
    }
    const newBest = this.score > best;
    if (newBest) {
      best = this.score;
      try {
        localStorage.setItem(BEST_KEY, String(best));
      } catch {
        /* ignore */
      }
    }
    const stars = victory ? 3 : this.delivered >= 8 ? 2 : this.delivered >= 4 ? 1 : 0;
    this.onMatchOver({
      victory, score: this.score, delivered: this.delivered, perfects: this.perfects, lost: this.lost,
      hits: this.hits, timeLeft: Math.max(0, Math.round(this.timeLeft)), best, newBest, stars, title: TITLES[stars],
    });
  }

  // ======================================================================= spawning

  private spawnCrate(announce: boolean): boolean {
    const { caches, camps } = this.world;
    const free = caches.filter(
      (p) => !this.crates.some((c) => c.state === 'ground' && dist(c, p) < 60) && dist(p, this.drone) > 140,
    );
    if (!free.length) return false;
    const cache = free[Math.floor(rand(0, free.length))];
    const options = camps.map((_, i) => i).filter((i) => dist(cache, camps[i]) > CRATE.minRoute);
    const dest = options[Math.floor(rand(0, options.length))];
    this.crates.push({
      x: cache.x, y: cache.y, vx: 0, vy: 0, h: 0, h0: 0, state: 'ground', dest,
      rot: rand(-0.3, 0.3), vr: 0, fall: 0, pickedAt: 0, anim: 0,
    });
    if (announce) {
      this.fx.ring(cache.x, cache.y, 18, PALETTE.gold, 240);
      this.audio.spawn();
    }
    return true;
  }

  private spawnScav(): void {
    let x = 0;
    let y = 0;
    for (let i = 0; i < 20; i++) {
      x = rand(0, 1) < 0.5 ? rand(40, 200) : rand(WORLD.w - 200, WORLD.w - 40);
      y = rand(80, WORLD.h - 80);
      if (dist({ x, y }, this.drone) > 700) break;
    }
    this.scavs.push({ x, y, vx: 0, vy: 0, tx: rand(200, WORLD.w - 200), ty: rand(200, WORLD.h - 200), heading: 0, stun: 0, alert: false, rotor: 0 });
  }

  private activeCrates(): number {
    return this.crates.filter((c) => c.state === 'ground' || c.state === 'carried' || c.state === 'falling').length;
  }

  // ======================================================================= update

  update(dt: number): void {
    this.t += dt;
    if (this.state === 'playing' && this.paused) {
      this.audio.setHum(0, 0, false);
      return;
    }
    this.audio.tick();
    this.fx.update(dt);
    this.updateAmbient(dt);
    this.campFlash = this.campFlash.map((f) => Math.max(0, f - dt * 1.5));
    if (this.state === 'playing') this.updatePlaying(dt);
    else this.updateAttract(dt);
  }

  /** Title / results background: the drone tours the valley on autopilot. */
  private updateAttract(dt: number): void {
    const d = this.drone;
    const p = (k: number): Point => ({
      x: WORLD.w / 2 + Math.sin(k * 0.07) * 900,
      y: WORLD.h / 2 + Math.sin(k * 0.11 + 1) * 520,
    });
    const now = p(this.t);
    const next = p(this.t + 0.1);
    d.x = now.x;
    d.y = now.y;
    d.vx = (next.x - now.x) * 10;
    d.vy = (next.y - now.y) * 10;
    d.heading = Math.atan2(d.vy, d.vx);
    d.rotor += dt * 40;
    d.thrust = 0.4;
    this.updateCrates(dt);
    this.updateScavs(dt, false);
    this.updateCamera(dt, 2);
  }

  private updatePlaying(dt: number): void {
    const d = this.drone;
    if (this.countdown > 0) {
      const prev = Math.ceil(this.countdown);
      this.countdown -= dt;
      if (this.countdown <= 0) {
        this.fx.banner('GO!', PALETTE.gold, 120, 0.9);
        this.audio.countdown(true);
      } else if (Math.ceil(this.countdown) !== prev) {
        this.audio.countdown(false);
      }
      d.rotor += dt * 40;
      this.updateCrates(dt);
      this.updateCamera(dt, 5);
      this.audio.setHum(0.6, 0, false);
      return;
    }

    // ---- clocks
    this.time += dt;
    this.timeLeft -= dt;
    const sec = Math.ceil(this.timeLeft);
    if (this.timeLeft <= TIME.warn && sec !== this.lastTick && sec > 0) {
      this.lastTick = sec;
      this.audio.clock(sec <= 3);
      if (sec === TIME.warn) this.fx.text(W / 2 + this.cam.x, 120 + this.cam.y, 'HURRY!', PALETTE.danger, 30, 1.2);
    }
    if (this.timeLeft <= 0) {
      this.endMatch(false);
      return;
    }

    this.updateDrone(dt);

    // ---- winch: hold to PICK, release to DROP
    const held = this.input.beam;
    if (held && !this.carried) {
      let best: Crate | null = null;
      let bestD: number = CRATE.pickRadius;
      for (const c of this.crates) {
        if (c.state !== 'ground') continue;
        const dd = dist(c, d);
        if (dd < bestD) { best = c; bestD = dd; }
      }
      if (best) this.pick(best);
    } else if (!held && this.carried) {
      this.drop();
    }

    this.updateCrates(dt);
    const wanted = Math.min(SCAV.max, 1 + Math.floor(this.delivered / SCAV.perDeliveries));
    if (this.scavs.length < wanted) this.spawnScav();
    this.updateScavs(dt, true);

    this.respawn = this.respawn.map((r) => r - dt);
    while (this.respawn.length && this.respawn[0] <= 0) {
      this.respawn.shift();
      if (this.activeCrates() < CRATE.active && !this.spawnCrate(true)) this.respawn.push(0.5);
    }
    this.updateCamera(dt, 5);
  }

  private updateDrone(dt: number): void {
    const d = this.drone;
    const loaded = this.carried !== null;
    let ax = this.input.axisX;
    let ay = this.input.axisY;
    const mag = Math.hypot(ax, ay);
    if (mag > 1) { ax /= mag; ay /= mag; }
    const thrust = Math.min(1, mag);
    const power = DRONE.thrust * (loaded ? DRONE.loadedThrust : 1);
    d.vx += ax * power * dt;
    d.vy += ay * power * dt;
    const drag = Math.exp(-DRONE.drag * dt);
    d.vx *= drag;
    d.vy *= drag;
    const max = loaded ? DRONE.loadedMaxSpeed : DRONE.maxSpeed;
    const sp = Math.hypot(d.vx, d.vy);
    if (sp > max) { d.vx *= max / sp; d.vy *= max / sp; }
    d.x += d.vx * dt;
    d.y += d.vy * dt;

    // world edges
    const r = DRONE.r;
    if (d.x < r) { d.x = r; d.vx = Math.abs(d.vx) * DRONE.bounce; }
    if (d.x > WORLD.w - r) { d.x = WORLD.w - r; d.vx = -Math.abs(d.vx) * DRONE.bounce; }
    if (d.y < r) { d.y = r; d.vy = Math.abs(d.vy) * DRONE.bounce; }
    if (d.y > WORLD.h - r) { d.y = WORLD.h - r; d.vy = -Math.abs(d.vy) * DRONE.bounce; }
    this.collideObstacles();

    if (sp > 30) d.heading += angleDiff(d.heading, Math.atan2(d.vy, d.vx)) * Math.min(1, dt * 8);
    d.thrust += (thrust - d.thrust) * Math.min(1, dt * 8);
    d.rotor += dt * (40 + thrust * 30);
    this.audio.setHum(1, d.thrust, loaded);

    // rotor wash blows leaves around on the ground beneath the drone
    this.emitAcc += dt * (thrust > 0 ? 26 : 6);
    while (this.emitAcc >= 1) {
      this.emitAcc -= 1;
      const a = rand(0, TAU);
      const s = rand(60, 160);
      this.fx.emit({
        x: d.x + 16 + Math.cos(a) * 12, y: d.y + 26 + Math.sin(a) * 10, vx: Math.cos(a) * s, vy: Math.sin(a) * s,
        kind: 'leaf', color: Math.random() < 0.6 ? '#b8df7a' : '#e3d39a', life: 0.5, size: 2.5, drag: 3, vr: rand(-8, 8),
      });
    }
  }

  /** Giant trees and ruined buildings are tall enough to hit. */
  private collideObstacles(): void {
    const d = this.drone;
    const hit = (nx: number, ny: number, cx: number, cy: number, kind: 'tree' | 'ruin'): void => {
      const vn = d.vx * nx + d.vy * ny;
      if (vn >= 0) return;
      d.vx -= (1 + DRONE.bounce) * vn * nx;
      d.vy -= (1 + DRONE.bounce) * vn * ny;
      const impact = -vn;
      if (impact < 110) return;
      const k = Math.min(1, impact / 450);
      if (kind === 'tree') {
        this.audio.rustle(k);
        this.fx.leaves(cx, cy, 8 + Math.round(k * 10));
      } else {
        this.audio.stone(k);
        this.fx.sparks(cx, cy, 6 + Math.round(k * 8), '#d6cfb9');
      }
      this.fx.addShake(2 + k * 5);
    };
    for (const t of this.world.trees) {
      const dx = d.x - t.x;
      const dy = d.y - t.y;
      const dd = Math.hypot(dx, dy);
      const min = t.r * 0.85 + DRONE.r;
      if (dd < min && dd > 0) {
        const nx = dx / dd;
        const ny = dy / dd;
        d.x = t.x + nx * min;
        d.y = t.y + ny * min;
        hit(nx, ny, t.x + nx * t.r * 0.85, t.y + ny * t.r * 0.85, 'tree');
      }
    }
    for (const r of this.world.ruins) {
      const cx = clamp(d.x, r.x, r.x + r.w);
      const cy = clamp(d.y, r.y, r.y + r.h);
      const dx = d.x - cx;
      const dy = d.y - cy;
      const dd = Math.hypot(dx, dy);
      if (dd < DRONE.r) {
        let nx = 0;
        let ny = -1;
        if (dd > 0) { nx = dx / dd; ny = dy / dd; }
        d.x = cx + nx * DRONE.r;
        d.y = cy + ny * DRONE.r;
        hit(nx, ny, cx, cy, 'ruin');
      }
    }
  }

  // ----------------------------------------------------------------------- crates

  private pick(c: Crate): void {
    c.state = 'carried';
    c.pickedAt = this.time;
    this.carried = c;
    this.rope = 0;
    this.audio.pick();
    this.fx.ring(c.x, c.y, 16, PALETTE.gold, 200);
    this.fx.text(c.x, c.y - 40, 'HOOKED!', PALETTE.gold, 22, 0.8);
  }

  private drop(): void {
    const c = this.carried;
    if (!c) return;
    this.carried = null;
    c.state = 'falling';
    c.fall = 0;
    c.h0 = c.h;
    c.vr = rand(-3, 3);
    this.audio.release();
  }

  private updateCrates(dt: number): void {
    const d = this.drone;
    for (const c of this.crates) {
      c.anim += dt;
      if (c.state === 'carried') {
        // damped spring on the rope: the crate swings behind the drone
        c.vx += ((d.x - c.x) * CRATE.spring - (c.vx - d.vx) * CRATE.damping) * dt;
        c.vy += ((d.y - c.y) * CRATE.spring - (c.vy - d.vy) * CRATE.damping) * dt;
        c.x += c.vx * dt;
        c.y += c.vy * dt;
        const dx = c.x - d.x;
        const dy = c.y - d.y;
        const len = Math.hypot(dx, dy);
        if (len > CRATE.maxRope) {
          c.x = d.x + (dx / len) * CRATE.maxRope;
          c.y = d.y + (dy / len) * CRATE.maxRope;
        }
        this.rope = Math.min(1, this.rope + dt * 5);
        c.h = CARRY_HEIGHT * this.rope;
        c.rot += angleDiff(c.rot, d.heading) * Math.min(1, dt * 2);
      } else if (c.state === 'falling') {
        c.fall += dt / CRATE.fallTime;
        const e = Math.exp(-CRATE.airDrag * dt);
        c.vx *= e;
        c.vy *= e;
        c.x = clamp(c.x + c.vx * dt, 20, WORLD.w - 20);
        c.y = clamp(c.y + c.vy * dt, 20, WORLD.h - 20);
        c.rot += c.vr * dt;
        c.h = c.h0 * (1 - c.fall * c.fall);
        if (c.fall >= 1) this.land(c);
      }
    }
    this.crates = this.crates.filter(
      (c) => !((c.state === 'delivered' && c.anim > 0.7) || (c.state === 'lost' && c.anim > 1.2)),
    );
  }

  private land(c: Crate): void {
    c.h = 0;
    c.vx = 0;
    c.vy = 0;
    if (this.state !== 'playing') {
      c.state = 'ground';
      return;
    }
    if (isWater(this.world, c.x, c.y)) {
      this.loseCrate(c);
      return;
    }
    this.pushOutOfObstacles(c);
    const camp = this.world.camps[c.dest];
    const dd = dist(c, camp);
    if (dd <= ZONE.r) {
      this.deliver(c, dd <= ZONE.perfect);
      return;
    }
    c.state = 'ground';
    this.audio.thud(0.7);
    this.fx.burst(c.x, c.y + 8, 10, ['#e3d39a', '#c9b27a'], 140, { kind: 'leaf', life: 0.5, drag: 4 });
    const wrong = this.world.camps.find((k) => dist(c, k) <= ZONE.r);
    if (wrong) {
      this.audio.wrong();
      this.fx.text(c.x, c.y - 44, 'WRONG CAMP!', PALETTE.danger, 26, 1.2);
      this.fx.text(c.x, c.y - 14, `goes to ${camp.name}`, camp.color, 18, 1.4);
    } else {
      this.fx.text(c.x, c.y - 36, 'MISSED', PALETTE.cream, 20, 0.8);
    }
  }

  private pushOutOfObstacles(c: Crate): void {
    const half = CRATE.size / 2;
    for (const t of this.world.trees) {
      const dd = dist(c, t);
      const min = t.r * 0.85 + half;
      if (dd < min && dd > 0) {
        c.x = t.x + ((c.x - t.x) / dd) * min;
        c.y = t.y + ((c.y - t.y) / dd) * min;
      }
    }
    for (const r of this.world.ruins) {
      if (c.x > r.x - half && c.x < r.x + r.w + half && c.y > r.y - half && c.y < r.y + r.h + half) {
        const exits = [c.x - (r.x - half), r.x + r.w + half - c.x, c.y - (r.y - half), r.y + r.h + half - c.y];
        const m = exits.indexOf(Math.min(...exits));
        if (m === 0) c.x = r.x - half;
        else if (m === 1) c.x = r.x + r.w + half;
        else if (m === 2) c.y = r.y - half;
        else c.y = r.y + r.h + half;
      }
    }
  }

  private deliver(c: Crate, perfect: boolean): void {
    const camp = this.world.camps[c.dest];
    c.state = 'delivered';
    c.anim = 0;
    this.delivered++;
    let pts: number = POINTS.delivery;
    let bonusTime: number = TIME.delivery;
    this.fx.text(camp.x, camp.y - 50, `DELIVERED +${POINTS.delivery}`, PALETTE.cream, 30, 1.3);
    if (perfect) {
      pts += POINTS.perfect;
      bonusTime += TIME.perfect;
      this.perfects++;
      this.fx.banner(`PERFECT DROP! +${POINTS.perfect}`, PALETTE.gold, 68, 1.2);
    }
    if (this.time - c.pickedAt <= POINTS.expressTime) {
      pts += POINTS.express;
      this.fx.text(camp.x, camp.y + 4, `EXPRESS +${POINTS.express}`, '#7fd8ff', 22, 1.3);
    }
    this.score += pts;
    this.timeLeft += bonusTime;
    this.fx.text(camp.x + 90, camp.y - 96, `+${bonusTime}s`, PALETTE.good, 28, 1.4);
    this.fx.confetti(camp.x, camp.y, 110);
    this.fx.ring(camp.x, camp.y, 36, camp.color, 420);
    this.fx.addShake(8);
    this.campFlash[c.dest] = 1;
    this.audio.deliver(perfect);
    this.audio.timeBonus();
    this.respawn.push(CRATE.respawnDelay);
    if (this.delivered >= QUOTA) this.endMatch(true);
  }

  private loseCrate(c: Crate): void {
    c.state = 'lost';
    c.anim = 0;
    this.lost++;
    this.audio.splash();
    for (let i = 0; i < 3; i++) this.fx.ripple(c.x, c.y, 10 + i * 8, 60 + i * 30, 1 + i * 0.2);
    this.fx.burst(c.x, c.y, 26, ['#ffffff', '#bfe9ff', '#7fd1ff'], 300, { g: 700, life: 0.7, size: 3.5, drag: 1 });
    this.fx.text(c.x, c.y - 40, 'SPLASH! Cargo lost', '#7fd8ff', 26, 1.4);
    this.fx.addShake(4);
    this.respawn.push(CRATE.respawnDelay);
  }

  // ----------------------------------------------------------------------- scavengers

  private updateScavs(dt: number, live: boolean): void {
    const d = this.drone;
    for (const s of this.scavs) {
      s.stun = Math.max(0, s.stun - dt);
      s.rotor += dt * (s.alert ? 70 : 45);
      const dd = dist(s, d);
      const chasing = live && s.stun <= 0 && this.carried !== null && dd < SCAV.detect;
      if (chasing && !s.alert) {
        this.audio.scavAlert();
        this.fx.text(s.x, s.y - 44, '!', PALETTE.danger, 40, 0.8);
      }
      s.alert = chasing;
      let tx: number;
      let ty: number;
      let speed: number;
      if (s.stun > 0) {
        tx = s.x - (d.x - s.x);
        ty = s.y - (d.y - s.y);
        speed = SCAV.wander;
      } else if (chasing) {
        tx = d.x + d.vx * 0.3;
        ty = d.y + d.vy * 0.3;
        speed = Math.min(SCAV.chaseMax, SCAV.chase + this.delivered * 8);
      } else {
        if (Math.hypot(s.tx - s.x, s.ty - s.y) < 40) {
          s.tx = rand(150, WORLD.w - 150);
          s.ty = rand(150, WORLD.h - 150);
        }
        tx = s.tx;
        ty = s.ty;
        speed = SCAV.wander;
      }
      const ang = Math.atan2(ty - s.y, tx - s.x);
      const k = Math.min(1, dt * 3);
      s.vx += (Math.cos(ang) * speed - s.vx) * k;
      s.vy += (Math.sin(ang) * speed - s.vy) * k;
      s.x = clamp(s.x + s.vx * dt, 30, WORLD.w - 30);
      s.y = clamp(s.y + s.vy * dt, 30, WORLD.h - 30);
      s.heading += angleDiff(s.heading, Math.atan2(s.vy, s.vx)) * Math.min(1, dt * 6);

      if (live && s.stun <= 0 && dd < SCAV.r + DRONE.r) this.scavHit(s);
    }
    // keep scavengers from stacking on top of each other
    for (let i = 0; i < this.scavs.length; i++) {
      for (let j = i + 1; j < this.scavs.length; j++) {
        const a = this.scavs[i];
        const b = this.scavs[j];
        const dd = dist(a, b);
        if (dd < SCAV.r * 2 && dd > 0) {
          const push = (SCAV.r * 2 - dd) / 2;
          const nx = (a.x - b.x) / dd;
          const ny = (a.y - b.y) / dd;
          a.x += nx * push; a.y += ny * push;
          b.x -= nx * push; b.y -= ny * push;
        }
      }
    }
  }

  private scavHit(s: Scavenger): void {
    const d = this.drone;
    const dd = dist(s, d) || 1;
    const nx = (d.x - s.x) / dd;
    const ny = (d.y - s.y) / dd;
    d.vx += nx * 420;
    d.vy += ny * 420;
    s.vx = -nx * 300;
    s.vy = -ny * 300;
    s.stun = SCAV.stun;
    s.alert = false;
    this.hits++;
    this.timeLeft -= TIME.hitPenalty;
    this.audio.scavHit();
    this.fx.sparks((d.x + s.x) / 2, (d.y + s.y) / 2, 16, '#ffb070');
    this.fx.addShake(12);
    this.fx.text(d.x, d.y - 46, `-${TIME.hitPenalty}s`, PALETTE.danger, 28, 1);
    if (this.carried) {
      const c = this.carried;
      this.drop();
      c.vx = d.vx * 0.4 + rand(-120, 120);
      c.vy = d.vy * 0.4 + rand(-120, 120);
      this.fx.text(c.x, c.y - 20, 'KNOCKED LOOSE!', PALETTE.danger, 24, 1.2);
    }
  }

  // ----------------------------------------------------------------------- ambient + camera

  private updateAmbient(dt: number): void {
    for (const c of this.clouds) {
      c.x += c.vx * dt;
      if (c.x - c.r > WORLD.w) { c.x = -c.r; c.y = rand(0, WORLD.h); }
    }
    for (const b of this.butterflies) {
      b.vx += (rand(-1, 1) * 400 + (b.home.x - b.x) * 0.8) * dt;
      b.vy += (rand(-1, 1) * 400 + (b.home.y - b.y) * 0.8) * dt;
      b.vx *= Math.exp(-1.5 * dt);
      b.vy *= Math.exp(-1.5 * dt);
      // startled by the rotor wash
      const dd = dist(b, this.drone);
      if (dd < 90 && dd > 0) {
        b.vx += ((b.x - this.drone.x) / dd) * 600 * dt;
        b.vy += ((b.y - this.drone.y) / dd) * 600 * dt;
      }
      b.x += b.vx * dt;
      b.y += b.vy * dt;
    }
  }

  private updateCamera(dt: number, follow: number): void {
    const d = this.drone;
    const tx = clamp(d.x + d.vx * 0.35 - W / 2, 0, WORLD.w - W);
    const ty = clamp(d.y + d.vy * 0.35 - H / 2, 0, WORLD.h - H);
    const k = Math.min(1, dt * follow);
    this.cam.x += (tx - this.cam.x) * k;
    this.cam.y += (ty - this.cam.y) * k;
  }

  private snapCamera(): void {
    this.cam.x = clamp(this.drone.x - W / 2, 0, WORLD.w - W);
    this.cam.y = clamp(this.drone.y - H / 2, 0, WORLD.h - H);
  }

  private inView(p: Point, pad: number): boolean {
    return p.x > this.cam.x - pad && p.x < this.cam.x + W + pad && p.y > this.cam.y - pad && p.y < this.cam.y + H + pad;
  }

  // ======================================================================= render

  render(): void {
    const ctx = this.ctx;
    const cam = this.cam;
    ctx.fillStyle = PALETTE.grass;
    ctx.fillRect(0, 0, W, H);

    ctx.save();
    const s = this.fx.shakeOffset();
    ctx.translate(-cam.x + s.x, -cam.y + s.y);
    ctx.drawImage(this.world.layer, cam.x, cam.y, W, H, cam.x, cam.y, W, H);
    this.drawRiverGlints(ctx);
    this.drawCamps(ctx);
    for (const c of this.crates) if (c.state === 'ground' || c.state === 'delivered' || c.state === 'lost') this.drawGroundCrate(ctx, c);
    this.drawButterflies(ctx);
    if (this.carried && this.state === 'playing') this.drawReticle(ctx, this.carried);
    this.drawClouds(ctx);
    this.drawShadows(ctx);
    for (const c of this.crates) if (c.state === 'falling') this.drawCrateBox(ctx, c.x, c.y, c.rot, 1 + c.h * 0.15, c.dest, 1);
    if (this.carried) this.drawCarried(ctx, this.carried);
    for (const sc of this.scavs) this.drawScav(ctx, sc);
    this.drawDrone(ctx);
    this.fx.draw(ctx);
    ctx.restore();

    if (this.state === 'playing') {
      this.drawPointers(ctx);
      drawHud(ctx, {
        t: this.t, score: this.score, delivered: this.delivered, timeLeft: this.timeLeft,
        carrying: this.carried ? this.world.camps[this.carried.dest] : null, ...this.hint(),
      });
      const blips: Blip[] = [
        ...this.crates.filter((c) => c.state === 'ground').map((c) => ({ x: c.x, y: c.y, color: this.world.camps[c.dest].color, kind: 'crate' as const })),
        ...this.scavs.map((sc) => ({ x: sc.x, y: sc.y, color: PALETTE.danger, kind: 'scav' as const })),
      ];
      drawMinimap(ctx, this.world, cam, this.drone, blips, this.carried ? this.world.camps[this.carried.dest] : null, this.t);
      if (this.countdown > 0) this.drawCountdown(ctx);
    }
    this.fx.drawBanners(ctx);
    if (this.state === 'playing' && this.paused) this.drawPause(ctx);
  }

  private hint(): { hint: string; hintColor: string } {
    if (this.countdown > 0) return { hint: 'Get ready…', hintColor: PALETTE.cream };
    if (this.carried) {
      const camp = this.world.camps[this.carried.dest];
      return { hint: `Carry it to ${camp.name}  ·  RELEASE SPACE over the pad to drop`, hintColor: camp.color };
    }
    if (this.crates.some((c) => c.state === 'falling')) return { hint: 'Dropping…', hintColor: PALETTE.cream };
    const near = this.crates.some((c) => c.state === 'ground' && dist(c, this.drone) < CRATE.pickRadius * 1.8);
    if (near) return { hint: 'HOLD SPACE (or click) to winch the crate up', hintColor: PALETTE.gold };
    return { hint: 'Fly to a supply crate  ·  WASD / arrow keys', hintColor: PALETTE.cream };
  }

  private drawRiverGlints(ctx: CanvasRenderingContext2D): void {
    ctx.save();
    ctx.strokeStyle = '#ffffff';
    ctx.lineCap = 'round';
    ctx.lineWidth = 2;
    for (const g of this.world.glints) {
      if (!this.inView(g, 40)) continue;
      const a = 0.5 + 0.5 * Math.sin(this.t * 2.2 + g.phase);
      if (a < 0.35) continue;
      const drift = ((this.t * 18 + g.phase * 10) % 24) - 12;
      const x = g.x + Math.cos(g.ang) * drift;
      const y = g.y + Math.sin(g.ang) * drift;
      const l = g.len * a * 0.5;
      ctx.globalAlpha = (a - 0.35) * 0.9;
      ctx.beginPath();
      ctx.moveTo(x - Math.cos(g.ang) * l, y - Math.sin(g.ang) * l);
      ctx.lineTo(x + Math.cos(g.ang) * l, y + Math.sin(g.ang) * l);
      ctx.stroke();
    }
    ctx.restore();
  }

  private drawCamps(ctx: CanvasRenderingContext2D): void {
    const dest = this.carried ? this.carried.dest : -1;
    this.world.camps.forEach((c, i) => {
      if (!this.inView(c, ZONE.r + 120)) return;
      // waving flag
      const px = c.x + ZONE.r * 0.72;
      const py = c.y - ZONE.r * 0.72;
      ctx.save();
      ctx.strokeStyle = 'rgba(20,40,10,0.3)';
      ctx.lineWidth = 4;
      ctx.beginPath(); ctx.moveTo(px + 4, py + 4); ctx.lineTo(px + 30, py + 20); ctx.stroke();
      ctx.strokeStyle = '#5a3d22';
      ctx.beginPath(); ctx.moveTo(px, py); ctx.lineTo(px, py - 50); ctx.stroke();
      const w1 = Math.sin(this.t * 6 + i) * 5;
      const w2 = Math.sin(this.t * 6 + i + 1.5) * 6;
      ctx.fillStyle = c.color;
      ctx.strokeStyle = shade(c.color, -0.4);
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(px, py - 50);
      ctx.quadraticCurveTo(px + 18, py - 52 + w1, px + 36, py - 44 + w2);
      ctx.quadraticCurveTo(px + 18, py - 34 + w1, px, py - 32);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.restore();

      if (i === dest || this.campFlash[i] > 0) {
        const pulse = Math.sin(this.t * 6) * 6;
        ctx.save();
        ctx.strokeStyle = c.color;
        ctx.lineWidth = 6;
        ctx.globalAlpha = i === dest ? 0.9 : this.campFlash[i];
        ctx.setLineDash([18, 12]);
        ctx.lineDashOffset = -this.t * 40;
        ctx.beginPath(); ctx.arc(c.x, c.y, ZONE.r + 10 + pulse, 0, TAU); ctx.stroke();
        ctx.setLineDash([]);
        if (i === dest) {
          // bouncing "drop here" chevron
          const by = c.y - ZONE.r - 40 + Math.abs(Math.sin(this.t * 4)) * -14;
          ctx.globalAlpha = 1;
          ctx.fillStyle = c.color;
          ctx.strokeStyle = PALETTE.ink;
          ctx.lineWidth = 3;
          ctx.beginPath(); ctx.moveTo(c.x - 18, by - 10); ctx.lineTo(c.x + 18, by - 10); ctx.lineTo(c.x, by + 12); ctx.closePath();
          ctx.stroke(); ctx.fill();
          ctx.font = `900 16px ${FONT}`;
          ctx.textAlign = 'center';
          ctx.lineWidth = 4;
          ctx.strokeText('DROP HERE', c.x, by - 24);
          ctx.fillStyle = PALETTE.cream;
          ctx.fillText('DROP HERE', c.x, by - 24);
        }
        ctx.restore();
      }
    });
  }

  private drawCrateBox(ctx: CanvasRenderingContext2D, x: number, y: number, rot: number, scale: number, dest: number, alpha: number): void {
    const s = CRATE.size / 2;
    const color = this.world.camps[dest].color;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(x, y);
    ctx.rotate(rot);
    ctx.scale(scale, scale);
    ctx.fillStyle = '#bf8644';
    ctx.fillRect(-s, -s, s * 2, s * 2);
    ctx.strokeStyle = '#94622e';
    ctx.lineWidth = 2;
    for (const k of [-s / 3, s / 3]) { ctx.beginPath(); ctx.moveTo(-s, k); ctx.lineTo(s, k); ctx.stroke(); }
    ctx.lineWidth = 4;
    ctx.beginPath(); ctx.moveTo(-s + 2, -s + 2); ctx.lineTo(s - 2, s - 2); ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,0.18)';
    ctx.fillRect(-s, -s, s * 2, 4);
    ctx.fillStyle = color;
    ctx.fillRect(-s + 3, -5, s * 2 - 6, 10);
    ctx.strokeStyle = PALETTE.ink;
    ctx.lineWidth = 1.5;
    ctx.strokeRect(-s + 3, -5, s * 2 - 6, 10);
    ctx.strokeStyle = '#6e4521';
    ctx.lineWidth = 3;
    ctx.strokeRect(-s, -s, s * 2, s * 2);
    ctx.restore();
  }

  private drawGroundCrate(ctx: CanvasRenderingContext2D, c: Crate): void {
    if (!this.inView(c, 80)) return;
    const camp = this.world.camps[c.dest];
    if (c.state === 'delivered') {
      const k = c.anim / 0.7;
      this.drawCrateBox(ctx, c.x, c.y - k * 30, c.rot + k * 3, 1 - k, c.dest, 1 - k);
      return;
    }
    if (c.state === 'lost') {
      const k = Math.min(1, c.anim / 1.2);
      this.drawCrateBox(ctx, c.x + Math.sin(c.anim * 6) * 3, c.y + k * 6, c.rot, 1 - k * 0.5, c.dest, 1 - k);
      return;
    }
    const pop = Math.min(1, c.anim / 0.3);
    const pulse = 0.5 + 0.5 * Math.sin(this.t * 4 + c.x);
    // beacon ring
    ctx.save();
    ctx.strokeStyle = camp.color;
    ctx.globalAlpha = 0.35 + pulse * 0.4;
    ctx.lineWidth = 3;
    ctx.beginPath(); ctx.arc(c.x, c.y, 26 + pulse * 8, 0, TAU); ctx.stroke();
    ctx.restore();
    ctx.fillStyle = 'rgba(20,40,10,0.3)';
    ctx.fillRect(c.x - 12, c.y - 10, CRATE.size, CRATE.size);
    this.drawCrateBox(ctx, c.x, c.y, c.rot, pop * (1 + (1 - pop) * 0.5), c.dest, 1);
    // destination pin
    const py = c.y - 40 - pulse * 4;
    ctx.save();
    ctx.strokeStyle = PALETTE.ink;
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(c.x, py + 10); ctx.lineTo(c.x, c.y - 18); ctx.stroke();
    ctx.fillStyle = camp.color;
    ctx.lineWidth = 3;
    ctx.beginPath(); ctx.arc(c.x, py, 12, 0, TAU); ctx.fill(); ctx.stroke();
    ctx.fillStyle = PALETTE.ink;
    ctx.font = `900 13px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(camp.name[0], c.x, py + 1);
    ctx.restore();
  }

  /** Predicted landing spot for the carried crate. */
  private drawReticle(ctx: CanvasRenderingContext2D, c: Crate): void {
    const lx = c.x + c.vx * DROP_REACH;
    const ly = c.y + c.vy * DROP_REACH;
    const camp = this.world.camps[c.dest];
    const dd = Math.hypot(lx - camp.x, ly - camp.y);
    const water = isWater(this.world, lx, ly);
    const color = water ? PALETTE.danger : dd <= ZONE.perfect ? PALETTE.gold : dd <= ZONE.r ? PALETTE.good : PALETTE.cream;
    ctx.save();
    ctx.strokeStyle = color;
    ctx.globalAlpha = 0.5;
    ctx.setLineDash([4, 6]);
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(c.x, c.y); ctx.lineTo(lx, ly); ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
    ctx.lineWidth = 3;
    const r = 16 + Math.sin(this.t * 8) * 2;
    ctx.beginPath(); ctx.arc(lx, ly, r, 0, TAU); ctx.stroke();
    for (let i = 0; i < 4; i++) {
      const a = (i * Math.PI) / 2 + this.t;
      ctx.beginPath();
      ctx.moveTo(lx + Math.cos(a) * (r - 6), ly + Math.sin(a) * (r - 6));
      ctx.lineTo(lx + Math.cos(a) * (r + 6), ly + Math.sin(a) * (r + 6));
      ctx.stroke();
    }
    if (water || dd <= ZONE.r) {
      const label = water ? 'WATER!' : dd <= ZONE.perfect ? 'BULLSEYE' : 'ON TARGET';
      ctx.font = `900 14px ${FONT}`;
      ctx.textAlign = 'center';
      ctx.lineWidth = 4;
      ctx.strokeStyle = PALETTE.ink;
      ctx.strokeText(label, lx, ly + r + 16);
      ctx.fillStyle = color;
      ctx.fillText(label, lx, ly + r + 16);
    }
    ctx.restore();
  }

  private drawClouds(ctx: CanvasRenderingContext2D): void {
    for (const c of this.clouds) {
      if (!this.inView(c, c.r)) continue;
      const g = ctx.createRadialGradient(c.x, c.y, c.r * 0.2, c.x, c.y, c.r);
      g.addColorStop(0, 'rgba(15, 40, 25, 0.16)');
      g.addColorStop(1, 'rgba(15, 40, 25, 0)');
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.ellipse(c.x, c.y, c.r, c.r * 0.7, 0, 0, TAU); ctx.fill();
    }
  }

  /** Ground shadows sell altitude: the higher something flies, the further its shadow falls. */
  private drawShadows(ctx: CanvasRenderingContext2D): void {
    ctx.save();
    ctx.fillStyle = 'rgba(20, 40, 10, 0.28)';
    const shadow = (x: number, y: number, h: number, rx: number, ry: number): void => {
      ctx.beginPath(); ctx.ellipse(x + h * 20, y + h * 30, rx, ry, 0.4, 0, TAU); ctx.fill();
    };
    shadow(this.drone.x, this.drone.y, 1, 30, 20);
    for (const s of this.scavs) shadow(s.x, s.y, 0.9, 26, 18);
    for (const c of this.crates) if (c.state === 'carried' || c.state === 'falling') shadow(c.x, c.y, c.h, 17, 13);
    ctx.restore();
  }

  private drawCarried(ctx: CanvasRenderingContext2D, c: Crate): void {
    const d = this.drone;
    ctx.save();
    ctx.strokeStyle = '#3f2f1e';
    ctx.lineWidth = 2.5;
    const mx = (d.x + c.x) / 2 + 6;
    const my = (d.y + c.y) / 2 + 8;
    ctx.beginPath(); ctx.moveTo(d.x, d.y); ctx.quadraticCurveTo(mx, my, c.x, c.y); ctx.stroke();
    ctx.restore();
    this.drawCrateBox(ctx, c.x, c.y, c.rot, 1 + c.h * 0.15, c.dest, 1);
  }

  private drawRotor(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, spin: number, guard: string): void {
    ctx.fillStyle = 'rgba(255,255,255,0.22)';
    ctx.beginPath(); ctx.arc(x, y, r - 1, 0, TAU); ctx.fill();
    ctx.strokeStyle = '#2a2a2a';
    ctx.lineWidth = 2.5;
    const bx = Math.cos(spin) * (r - 2);
    const by = Math.sin(spin) * (r - 2);
    ctx.beginPath(); ctx.moveTo(x - bx, y - by); ctx.lineTo(x + bx, y + by); ctx.stroke();
    ctx.strokeStyle = guard;
    ctx.lineWidth = 3;
    ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.stroke();
    ctx.fillStyle = '#2a2a2a';
    ctx.beginPath(); ctx.arc(x, y, 2.5, 0, TAU); ctx.fill();
  }

  /** The player's K-04 courier drone (top-down, rotor-guarded quadcopter). */
  private drawDrone(ctx: CanvasRenderingContext2D): void {
    const d = this.drone;
    ctx.save();
    ctx.translate(d.x, d.y);
    ctx.rotate(d.heading);
    ctx.scale(1.1, 1.1);
    const arm = 24;
    ctx.strokeStyle = '#5b4a36';
    ctx.lineWidth = 5;
    for (const a of [Math.PI / 4, (3 * Math.PI) / 4, (5 * Math.PI) / 4, (7 * Math.PI) / 4]) {
      ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(Math.cos(a) * arm, Math.sin(a) * arm); ctx.stroke();
    }
    [Math.PI / 4, (3 * Math.PI) / 4, (5 * Math.PI) / 4, (7 * Math.PI) / 4].forEach((a, i) => {
      this.drawRotor(ctx, Math.cos(a) * arm, Math.sin(a) * arm, 12, d.rotor * (i % 2 ? 1 : -1) + i, '#e0b24a');
    });
    ctx.fillStyle = '#f2a23a';
    ctx.strokeStyle = '#8a5a1c';
    ctx.lineWidth = 2;
    roundRect(ctx, -15, -12, 30, 24, 6);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#2b2f33';
    roundRect(ctx, -10, -7, 14, 14, 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.25)';
    ctx.lineWidth = 1;
    for (let k = -6; k <= 4; k += 3.5) { ctx.beginPath(); ctx.moveTo(-9, k); ctx.lineTo(3, k); ctx.stroke(); }
    ctx.fillStyle = '#20262a';
    ctx.beginPath(); ctx.arc(14, 0, 4.5, 0, TAU); ctx.fill();
    ctx.fillStyle = '#7fd8ff';
    ctx.beginPath(); ctx.arc(15, -1, 1.6, 0, TAU); ctx.fill();
    // nav lights
    ctx.fillStyle = Math.sin(this.t * 6) > 0 ? '#8ff07a' : '#3a6a30';
    ctx.beginPath(); ctx.arc(-13, -10, 2, 0, TAU); ctx.fill();
    ctx.fillStyle = Math.sin(this.t * 6) > 0 ? '#ff5a4a' : '#6a2a20';
    ctx.beginPath(); ctx.arc(-13, 10, 2, 0, TAU); ctx.fill();
    ctx.restore();
  }

  /** Rusty scavenger drone. */
  private drawScav(ctx: CanvasRenderingContext2D, s: Scavenger): void {
    if (!this.inView(s, 60)) return;
    ctx.save();
    ctx.translate(s.x, s.y);
    ctx.rotate(s.heading);
    for (const a of [Math.PI / 4, (3 * Math.PI) / 4, (5 * Math.PI) / 4, (7 * Math.PI) / 4]) {
      ctx.strokeStyle = '#3a2a24';
      ctx.lineWidth = 4;
      ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(Math.cos(a) * 20, Math.sin(a) * 20); ctx.stroke();
      this.drawRotor(ctx, Math.cos(a) * 20, Math.sin(a) * 20, 9, s.rotor + a, '#7a3a2a');
    }
    ctx.fillStyle = s.stun > 0 && Math.sin(this.t * 30) > 0 ? '#ffffff' : '#8a3324';
    ctx.strokeStyle = '#3a1a14';
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * TAU;
      ctx.lineTo(Math.cos(a) * 15, Math.sin(a) * 15);
    }
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#c0603a';
    ctx.fillRect(-8, -5, 8, 4);
    ctx.fillRect(-6, 3, 6, 3);
    // grabber claws at the front
    ctx.strokeStyle = '#3a1a14';
    ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(12, -6); ctx.lineTo(22, -9); ctx.moveTo(12, 6); ctx.lineTo(22, 9); ctx.stroke();
    ctx.fillStyle = s.alert ? '#ff2a1a' : '#ffb03a';
    ctx.shadowColor = ctx.fillStyle;
    ctx.shadowBlur = s.alert ? 14 : 6;
    ctx.beginPath(); ctx.arc(8, 0, 4, 0, TAU); ctx.fill();
    ctx.restore();
    if (s.stun > 0) {
      ctx.save();
      ctx.fillStyle = PALETTE.gold;
      for (let i = 0; i < 3; i++) {
        const a = this.t * 5 + (i * TAU) / 3;
        ctx.beginPath(); ctx.arc(s.x + Math.cos(a) * 18, s.y - 26 + Math.sin(a) * 6, 3, 0, TAU); ctx.fill();
      }
      ctx.restore();
    }
  }

  private drawButterflies(ctx: CanvasRenderingContext2D): void {
    for (const b of this.butterflies) {
      if (!this.inView(b, 20)) continue;
      const flap = Math.abs(Math.sin(this.t * 16 + b.phase));
      const ang = Math.atan2(b.vy, b.vx);
      ctx.save();
      ctx.translate(b.x, b.y);
      ctx.rotate(ang);
      ctx.fillStyle = b.color;
      ctx.strokeStyle = 'rgba(29,42,24,0.6)';
      ctx.lineWidth = 1;
      for (const side of [-1, 1]) {
        ctx.beginPath();
        ctx.ellipse(-1, side * 4 * flap, 4, 3.5 * flap + 0.5, 0, 0, TAU);
        ctx.fill();
        ctx.stroke();
      }
      ctx.fillStyle = PALETTE.ink;
      ctx.fillRect(-4, -0.8, 7, 1.6);
      ctx.restore();
    }
  }

  private drawPointers(ctx: CanvasRenderingContext2D): void {
    if (this.countdown > 0) return;
    if (this.carried) {
      const camp: Camp = this.world.camps[this.carried.dest];
      drawPointer(ctx, this.cam, camp, camp.color, camp.name, this.t);
      return;
    }
    for (const c of this.crates) {
      if (c.state === 'ground') drawPointer(ctx, this.cam, c, PALETTE.gold, 'Crate', this.t);
    }
  }

  private drawCountdown(ctx: CanvasRenderingContext2D): void {
    const n = Math.ceil(this.countdown);
    const k = this.countdown - Math.floor(this.countdown);
    ctx.save();
    ctx.translate(W / 2, H * 0.42);
    ctx.scale(1 + k * 0.4, 1 + k * 0.4);
    ctx.globalAlpha = 0.4 + k * 0.6;
    ctx.font = `900 150px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 14;
    ctx.strokeStyle = PALETTE.ink;
    ctx.strokeText(String(n), 0, 0);
    ctx.fillStyle = PALETTE.cream;
    ctx.fillText(String(n), 0, 0);
    ctx.restore();
  }

  private drawPause(ctx: CanvasRenderingContext2D): void {
    ctx.save();
    ctx.fillStyle = 'rgba(15, 30, 12, 0.6)';
    ctx.fillRect(0, 0, W, H);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `900 76px ${FONT}`;
    ctx.lineWidth = 10;
    ctx.strokeStyle = PALETTE.ink;
    ctx.strokeText('PAUSED', W / 2, H / 2);
    ctx.fillStyle = PALETTE.cream;
    ctx.fillText('PAUSED', W / 2, H / 2);
    ctx.font = `700 18px ${FONT}`;
    ctx.fillText('Press P to resume', W / 2, H / 2 + 56);
    ctx.restore();
  }
}
