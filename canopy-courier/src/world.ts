// The Overgrown Valley: a seeded, procedurally painted top-down map.
// Layout data (camps, caches, river, obstacles) drives gameplay; the painting is baked
// once into an offscreen canvas so each frame only blits the visible part.
import { WORLD, ZONE, FONT } from './config';

export interface Point { x: number; y: number }
export interface Camp extends Point { name: string; color: string }
/** Giant tree: collision circle for the drone. */
export interface Tree extends Point { r: number }
/** Ruined building: collision rectangle (roof + front wall). */
export interface Ruin extends Point { w: number; h: number }
export interface Bridge extends Point { angle: number; len: number; wid: number }
interface RiverSample extends Point { hw: number; tx: number; ty: number }

export interface World {
  camps: Camp[];
  caches: Point[];
  trees: Tree[];
  ruins: Ruin[];
  bridges: Bridge[];
  river: RiverSample[];
  glints: (Point & { len: number; phase: number; ang: number })[];
  flowers: Point[];
  spawn: Point;
  layer: HTMLCanvasElement;
  mini: HTMLCanvasElement;
}

export const MINI = { w: 232, h: 160 } as const;
const RUIN_WALL = 34;

/** Deterministic PRNG (mulberry32) so the map is identical every run. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const dist = (a: Point, b: Point): number => Math.hypot(a.x - b.x, a.y - b.y);

// --------------------------------------------------------------------------- layout

const CAMPS: Camp[] = [
  { name: 'Mushroom Hollow', x: 400, y: 300, color: '#ff8a3d' },
  { name: 'Lotus Dock', x: 1900, y: 860, color: '#3fbfff' },
  { name: 'Pine Watch', x: 380, y: 1420, color: '#b07cff' },
  { name: 'Moss Tower', x: 2240, y: 1500, color: '#ff5fa2' },
];

const CACHES: Point[] = [
  { x: 1180, y: 330 }, { x: 760, y: 1020 }, { x: 1560, y: 1480 }, { x: 2260, y: 300 }, { x: 230, y: 900 },
];

const RIVER_POINTS: Point[] = [
  { x: -80, y: 560 }, { x: 300, y: 620 }, { x: 640, y: 500 }, { x: 980, y: 560 }, { x: 1220, y: 780 },
  { x: 1380, y: 1040 }, { x: 1700, y: 1130 }, { x: 2050, y: 1000 }, { x: 2350, y: 1080 }, { x: 2660, y: 1180 },
];

const FOREST_CENTERS: Point[] = [
  { x: 760, y: 220 }, { x: 1620, y: 260 }, { x: 260, y: 1140 }, { x: 1180, y: 1560 },
  { x: 2380, y: 680 }, { x: 1960, y: 1380 }, { x: 980, y: 820 },
];

const RUIN_AREAS = [
  { x0: 1380, y0: 380, x1: 2120, y1: 700 },
  { x0: 560, y0: 1180, x1: 1060, y1: 1620 },
];

function sampleRiver(rnd: () => number): RiverSample[] {
  const out: RiverSample[] = [];
  const p = RIVER_POINTS;
  for (let i = 0; i < p.length - 1; i++) {
    const p0 = p[Math.max(0, i - 1)];
    const p1 = p[i];
    const p2 = p[i + 1];
    const p3 = p[Math.min(p.length - 1, i + 2)];
    const steps = Math.ceil(dist(p1, p2) / 8);
    for (let s = 0; s < steps; s++) {
      const t = s / steps;
      const t2 = t * t;
      const t3 = t2 * t;
      // Catmull-Rom spline
      const x = 0.5 * (2 * p1.x + (-p0.x + p2.x) * t + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3);
      const y = 0.5 * (2 * p1.y + (-p0.y + p2.y) * t + (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 + (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3);
      out.push({ x, y, hw: 0, tx: 0, ty: 0 });
    }
  }
  const phase = rnd() * 6;
  out.forEach((s, i) => {
    const a = out[Math.max(0, i - 1)];
    const b = out[Math.min(out.length - 1, i + 1)];
    const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    s.tx = (b.x - a.x) / len;
    s.ty = (b.y - a.y) / len;
    s.hw = 50 + Math.sin(i * 0.035 + phase) * 12 + Math.sin(i * 0.11) * 5;
  });
  return out;
}

/** Signed distance from the river's water edge (negative = in the water). */
export function riverEdgeDistance(world: World, x: number, y: number): number {
  let best = Infinity;
  for (const s of world.river) {
    const d = Math.hypot(x - s.x, y - s.y) - s.hw;
    if (d < best) best = d;
  }
  return best;
}

function onBridge(world: World, x: number, y: number): boolean {
  return world.bridges.some((b) => {
    const dx = x - b.x;
    const dy = y - b.y;
    const c = Math.cos(-b.angle);
    const s = Math.sin(-b.angle);
    const lx = dx * c - dy * s;
    const ly = dx * s + dy * c;
    return Math.abs(lx) <= b.len / 2 && Math.abs(ly) <= b.wid / 2;
  });
}

/** True if a dropped crate would land in the river (bridges are safe). */
export function isWater(world: World, x: number, y: number): boolean {
  return riverEdgeDistance(world, x, y) < 0 && !onBridge(world, x, y);
}

// --------------------------------------------------------------------------- build

export function buildWorld(): World {
  const rnd = mulberry32(WORLD.seed);
  const rr = (a: number, b: number): number => a + rnd() * (b - a);
  const river = sampleRiver(rnd);

  const world: World = {
    camps: CAMPS,
    caches: CACHES,
    trees: [],
    ruins: [],
    bridges: [],
    river,
    glints: [],
    flowers: [],
    spawn: { x: 1000, y: 1250 },
    layer: document.createElement('canvas'),
    mini: document.createElement('canvas'),
  };

  // bridges across the river
  for (const f of [0.18, 0.47, 0.8]) {
    const s = river[Math.floor(river.length * f)];
    world.bridges.push({ x: s.x, y: s.y, angle: Math.atan2(s.tx, -s.ty), len: s.hw * 2 + 44, wid: 40 });
  }

  // river glints (animated at runtime)
  for (let i = 0; i < river.length; i += 3) {
    const s = river[i];
    const off = rr(-0.7, 0.7) * s.hw;
    world.glints.push({ x: s.x - s.ty * off, y: s.y + s.tx * off, len: rr(8, 22), phase: rr(0, 6.28), ang: Math.atan2(s.ty, s.tx) });
  }

  /** Is this spot clear of the river, camps, caches, spawn and existing obstacles? */
  const clear = (x: number, y: number, rad: number, opts = { river: 30, camp: 170, cache: 110 }): boolean => {
    if (x < rad || y < rad || x > WORLD.w - rad || y > WORLD.h - rad) return false;
    if (riverEdgeDistance(world, x, y) < rad + opts.river) return false;
    if (CAMPS.some((c) => dist(c, { x, y }) < ZONE.r + opts.camp * 0.5 + rad)) return false;
    if (CACHES.some((c) => dist(c, { x, y }) < opts.cache * 0.5 + rad)) return false;
    if (dist(world.spawn, { x, y }) < 140 + rad) return false;
    if (world.trees.some((t) => dist(t, { x, y }) < t.r + rad + 30)) return false;
    if (world.ruins.some((r) => x + rad > r.x - 30 && x - rad < r.x + r.w + 30 && y + rad > r.y - 30 && y - rad < r.y + r.h + 30)) return false;
    return true;
  };

  // ruined buildings
  for (const area of RUIN_AREAS) {
    let placed = 0;
    for (let tries = 0; tries < 200 && placed < 5; tries++) {
      const w = rr(90, 170);
      const h = rr(80, 130) + RUIN_WALL;
      const x = rr(area.x0, area.x1 - w);
      const y = rr(area.y0, area.y1 - h);
      if (clear(x + w / 2, y + h / 2, Math.max(w, h) * 0.6)) {
        world.ruins.push({ x, y, w, h });
        placed++;
      }
    }
  }

  // giant trees (obstacles) clustered in forests
  for (let tries = 0; world.trees.length < 22 && tries < 2000; tries++) {
    const c = FOREST_CENTERS[tries % FOREST_CENTERS.length];
    const x = c.x + rr(-230, 230);
    const y = c.y + rr(-180, 180);
    const r = rr(46, 68);
    if (clear(x, y, r)) world.trees.push({ x, y, r });
  }

  paintWorld(world, rnd, rr, clear);

  world.mini.width = MINI.w;
  world.mini.height = MINI.h;
  const mg = world.mini.getContext('2d');
  if (mg) {
    mg.imageSmoothingQuality = 'high';
    mg.drawImage(world.layer, 0, 0, WORLD.w, WORLD.h, 0, 0, MINI.w, MINI.h);
  }
  return world;
}

// --------------------------------------------------------------------------- painting

type Clear = (x: number, y: number, rad: number, opts?: { river: number; camp: number; cache: number }) => boolean;

function blob(g: CanvasRenderingContext2D, x: number, y: number, r: number, color: string): void {
  g.fillStyle = color;
  g.beginPath();
  g.arc(x, y, r, 0, Math.PI * 2);
  g.fill();
}

const TREE_TONES = [
  ['#2f6b2a', '#3f8a33', '#5fae43', '#8fd062'],
  ['#356f2c', '#4a9136', '#6dbb4a', '#a6dc6e'],
  ['#7a7a1e', '#a6a12b', '#d0c23e', '#f0e27a'], // golden canopy
];

function paintTree(g: CanvasRenderingContext2D, x: number, y: number, r: number, rr: (a: number, b: number) => number, tone: number): void {
  const [c0, c1, c2, c3] = TREE_TONES[tone];
  g.fillStyle = 'rgba(20, 45, 12, 0.32)';
  g.beginPath();
  g.ellipse(x + r * 0.35, y + r * 0.45, r * 1.05, r * 0.8, 0.3, 0, Math.PI * 2);
  g.fill();
  blob(g, x, y, r, c0);
  for (let i = 0; i < 7; i++) {
    const a = (i / 7) * Math.PI * 2 + rr(-0.3, 0.3);
    blob(g, x + Math.cos(a) * r * 0.45, y + Math.sin(a) * r * 0.45, r * rr(0.45, 0.6), c1);
  }
  for (let i = 0; i < 5; i++) blob(g, x - r * 0.22 + rr(-0.3, 0.3) * r, y - r * 0.25 + rr(-0.3, 0.3) * r, r * rr(0.25, 0.4), c2);
  for (let i = 0; i < 3; i++) blob(g, x - r * 0.38 + rr(-0.15, 0.15) * r, y - r * 0.38 + rr(-0.15, 0.15) * r, r * rr(0.1, 0.2), c3);
}

function paintPine(g: CanvasRenderingContext2D, x: number, y: number, r: number): void {
  g.fillStyle = 'rgba(20, 45, 12, 0.3)';
  g.beginPath();
  g.ellipse(x + r * 0.4, y + r * 0.5, r, r * 0.75, 0.3, 0, Math.PI * 2);
  g.fill();
  const shades = ['#1f4d30', '#2b6a3c', '#3c8a4a', '#5aa95c'];
  shades.forEach((col, k) => {
    const R = r * (1 - k * 0.22);
    const cx = x - k * r * 0.06;
    const cy = y - k * r * 0.06;
    g.fillStyle = col;
    g.beginPath();
    for (let i = 0; i < 18; i++) {
      const a = (i / 18) * Math.PI * 2;
      const rad = i % 2 ? R * 0.72 : R;
      g.lineTo(cx + Math.cos(a) * rad, cy + Math.sin(a) * rad);
    }
    g.closePath();
    g.fill();
  });
}

function paintRock(g: CanvasRenderingContext2D, x: number, y: number, r: number): void {
  g.fillStyle = 'rgba(20,40,10,0.25)';
  g.beginPath(); g.ellipse(x + r * 0.3, y + r * 0.35, r, r * 0.7, 0, 0, Math.PI * 2); g.fill();
  g.fillStyle = '#8d958c';
  g.beginPath(); g.ellipse(x, y, r, r * 0.8, 0, 0, Math.PI * 2); g.fill();
  g.fillStyle = '#b9c0b5';
  g.beginPath(); g.ellipse(x - r * 0.25, y - r * 0.25, r * 0.55, r * 0.4, 0, 0, Math.PI * 2); g.fill();
  g.strokeStyle = 'rgba(40,50,40,0.5)';
  g.lineWidth = 1.5;
  g.beginPath(); g.ellipse(x, y, r, r * 0.8, 0, 0, Math.PI * 2); g.stroke();
}

function paintMushrooms(g: CanvasRenderingContext2D, x: number, y: number, rr: (a: number, b: number) => number): void {
  const caps = [['#d9a35b', '#f3d39a'], ['#a8643a', '#d99a68'], ['#e8554a', '#ffffff']];
  const n = Math.floor(rr(3, 7));
  for (let i = 0; i < n; i++) {
    const r = rr(5, 14);
    const cx = x + rr(-26, 26);
    const cy = y + rr(-20, 20);
    const [cap, spot] = caps[Math.floor(rr(0, caps.length))];
    g.fillStyle = 'rgba(20,40,10,0.3)';
    g.beginPath(); g.ellipse(cx + r * 0.3, cy + r * 0.4, r, r * 0.7, 0, 0, Math.PI * 2); g.fill();
    blob(g, cx, cy, r, cap);
    g.fillStyle = spot;
    for (let s = 0; s < 3; s++) blob(g, cx + rr(-0.5, 0.5) * r, cy + rr(-0.5, 0.5) * r, r * 0.16, spot);
  }
}

function paintRuin(g: CanvasRenderingContext2D, r: Ruin, rr: (a: number, b: number) => number): void {
  const roofH = r.h - RUIN_WALL;
  g.fillStyle = 'rgba(20, 40, 10, 0.3)';
  g.fillRect(r.x + 16, r.y + 20, r.w, r.h);
  // front wall with windows (3/4 view)
  g.fillStyle = '#8f8a7a';
  g.fillRect(r.x, r.y + roofH, r.w, RUIN_WALL);
  g.fillStyle = '#3d3c35';
  for (let wx = r.x + 8; wx < r.x + r.w - 10; wx += 18) if (rr(0, 1) > 0.2) g.fillRect(wx, r.y + roofH + 9, 9, 15);
  // roof
  g.fillStyle = '#d6cfb9';
  g.fillRect(r.x, r.y, r.w, roofH);
  g.strokeStyle = '#a69e86';
  g.lineWidth = 4;
  g.strokeRect(r.x + 2, r.y + 2, r.w - 4, roofH - 4);
  // rooftop clutter + cracks
  g.fillStyle = '#b5ad96';
  for (let i = 0; i < 3; i++) g.fillRect(r.x + rr(10, r.w - 34), r.y + rr(10, roofH - 26), rr(14, 26), rr(10, 18));
  g.strokeStyle = 'rgba(70,60,45,0.55)';
  g.lineWidth = 1.5;
  for (let i = 0; i < 3; i++) {
    let cx = r.x + rr(10, r.w - 10);
    let cy = r.y + rr(6, roofH - 6);
    g.beginPath(); g.moveTo(cx, cy);
    for (let k = 0; k < 4; k++) { cx += rr(-14, 14); cy += rr(-10, 10); g.lineTo(cx, cy); }
    g.stroke();
  }
  // vines and moss creeping over everything
  const greens = ['#4f9a38', '#6db847', '#3f7d2f', '#8fd062'];
  for (let i = 0; i < 26; i++) {
    const onEdge = rr(0, 1) < 0.6;
    const vx = onEdge ? (rr(0, 1) < 0.5 ? r.x + rr(-6, 14) : r.x + r.w - rr(-6, 14)) : r.x + rr(0, r.w);
    const vy = r.y + rr(0, roofH);
    blob(g, vx, vy, rr(5, 16), greens[i % greens.length]);
  }
  g.strokeStyle = '#4f9a38';
  g.lineWidth = 3;
  for (let i = 0; i < 6; i++) {
    const vx = r.x + rr(4, r.w - 4);
    g.beginPath();
    g.moveTo(vx, r.y + roofH);
    g.quadraticCurveTo(vx + rr(-8, 8), r.y + roofH + RUIN_WALL * 0.5, vx + rr(-4, 4), r.y + roofH + rr(14, RUIN_WALL));
    g.stroke();
  }
}

function paintCar(g: CanvasRenderingContext2D, x: number, y: number, ang: number, rr: (a: number, b: number) => number): void {
  const body = ['#f2efe6', '#7fd1c0', '#e9b872'][Math.floor(rr(0, 3))];
  g.save();
  g.translate(x, y);
  g.rotate(ang);
  g.fillStyle = 'rgba(20,40,10,0.3)';
  g.fillRect(-26, -12, 60, 34);
  g.fillStyle = body;
  g.fillRect(-30, -16, 60, 32);
  g.fillStyle = '#3e4a4a';
  g.fillRect(-12, -13, 22, 26);
  g.fillStyle = 'rgba(255,255,255,0.35)';
  g.fillRect(-10, -11, 6, 22);
  for (let i = 0; i < 7; i++) blob(g, rr(-28, 28), rr(-14, 14), rr(4, 9), i % 2 ? '#6db847' : '#4f9a38');
  g.restore();
}

function paintCamp(g: CanvasRenderingContext2D, c: Camp, rr: (a: number, b: number) => number): void {
  // trampled clearing
  g.fillStyle = 'rgba(222, 200, 145, 0.85)';
  g.beginPath(); g.arc(c.x, c.y, ZONE.r + 34, 0, Math.PI * 2); g.fill();
  // tents around the pad
  for (let i = 0; i < 3; i++) {
    const a = -Math.PI * 0.85 + i * 0.75 + rr(-0.1, 0.1);
    const tx = c.x + Math.cos(a) * (ZONE.r + 58);
    const ty = c.y + Math.sin(a) * (ZONE.r + 52);
    g.fillStyle = 'rgba(20,40,10,0.3)';
    g.beginPath(); g.moveTo(tx - 18 + 8, ty + 10); g.lineTo(tx + 8, ty - 14 + 10); g.lineTo(tx + 18 + 8, ty + 10); g.lineTo(tx + 8, ty + 22 + 10); g.fill();
    g.fillStyle = c.color;
    g.beginPath(); g.moveTo(tx - 18, ty); g.lineTo(tx, ty - 14); g.lineTo(tx, ty + 22); g.fill();
    g.fillStyle = shade(c.color, -0.25);
    g.beginPath(); g.moveTo(tx + 18, ty); g.lineTo(tx, ty - 14); g.lineTo(tx, ty + 22); g.fill();
  }
  // stone ring
  for (let i = 0; i < 26; i++) {
    const a = (i / 26) * Math.PI * 2;
    paintRock(g, c.x + Math.cos(a) * (ZONE.r + 12), c.y + Math.sin(a) * (ZONE.r + 12), rr(5, 8));
  }
  // wooden landing pad
  g.save();
  g.beginPath(); g.arc(c.x, c.y, ZONE.r, 0, Math.PI * 2); g.clip();
  g.fillStyle = '#c0915a';
  g.fillRect(c.x - ZONE.r, c.y - ZONE.r, ZONE.r * 2, ZONE.r * 2);
  g.strokeStyle = '#9a6c3c';
  g.lineWidth = 2;
  for (let py = c.y - ZONE.r; py < c.y + ZONE.r; py += 14) {
    g.beginPath(); g.moveTo(c.x - ZONE.r, py); g.lineTo(c.x + ZONE.r, py); g.stroke();
  }
  g.restore();
  g.strokeStyle = '#7a5530';
  g.lineWidth = 4;
  g.beginPath(); g.arc(c.x, c.y, ZONE.r, 0, Math.PI * 2); g.stroke();
  // painted target
  g.strokeStyle = 'rgba(255, 246, 220, 0.8)';
  g.lineWidth = 5;
  g.beginPath(); g.arc(c.x, c.y, ZONE.r * 0.62, 0, Math.PI * 2); g.stroke();
  g.fillStyle = c.color;
  g.beginPath(); g.arc(c.x, c.y, ZONE.perfect, 0, Math.PI * 2); g.fill();
  g.strokeStyle = '#fff6dc';
  g.lineWidth = 4;
  g.stroke();
  // name plate
  g.font = `800 17px ${FONT}`;
  const tw = g.measureText(c.name).width + 26;
  const py = c.y + ZONE.r + 30;
  g.fillStyle = 'rgba(29, 42, 24, 0.85)';
  roundRect(g, c.x - tw / 2, py - 14, tw, 28, 14);
  g.fill();
  g.fillStyle = c.color;
  blob(g, c.x - tw / 2 + 12, py, 5, c.color);
  g.fillStyle = '#fff6dc';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(c.name, c.x + 5, py + 1);
}

function paintCache(g: CanvasRenderingContext2D, p: Point): void {
  g.fillStyle = 'rgba(20,40,10,0.3)';
  g.beginPath(); g.arc(p.x + 6, p.y + 8, 36, 0, Math.PI * 2); g.fill();
  g.fillStyle = '#9ea59a';
  g.beginPath(); g.arc(p.x, p.y, 36, 0, Math.PI * 2); g.fill();
  g.fillStyle = '#c4cabd';
  g.beginPath(); g.arc(p.x - 4, p.y - 4, 30, 0, Math.PI * 2); g.fill();
  g.strokeStyle = 'rgba(255, 207, 74, 0.8)';
  g.lineWidth = 3;
  g.setLineDash([6, 5]);
  g.strokeRect(p.x - 18, p.y - 18, 36, 36);
  g.setLineDash([]);
  for (let i = 0; i < 6; i++) {
    const a = i * 1.1;
    blob(g, p.x + Math.cos(a) * 32, p.y + Math.sin(a) * 32, 6, i % 2 ? '#6db847' : '#4f9a38');
  }
}

export function roundRect(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

/** Lighten (amt > 0) or darken (amt < 0) a #rrggbb colour. */
export function shade(hex: string, amt: number): string {
  const n = parseInt(hex.slice(1), 16);
  const f = (c: number): number => Math.round(Math.max(0, Math.min(255, amt < 0 ? c * (1 + amt) : c + (255 - c) * amt)));
  return `rgb(${f(n >> 16)}, ${f((n >> 8) & 255)}, ${f(n & 255)})`;
}

function paintWorld(world: World, rnd: () => number, rr: (a: number, b: number) => number, clear: Clear): void {
  const c = world.layer;
  c.width = WORLD.w;
  c.height = WORLD.h;
  const g = c.getContext('2d');
  if (!g) return;

  // 1. meadow base with painterly colour blotches
  g.fillStyle = '#8cc057';
  g.fillRect(0, 0, WORLD.w, WORLD.h);
  const meadow = ['#7db34a', '#9fcd66', '#6fa544', '#b3d87a', '#86ba52'];
  for (let i = 0; i < 1200; i++) {
    g.globalAlpha = rr(0.12, 0.3);
    g.fillStyle = meadow[i % meadow.length];
    g.beginPath();
    g.ellipse(rr(0, WORLD.w), rr(0, WORLD.h), rr(30, 150), rr(20, 90), rr(0, 3.14), 0, Math.PI * 2);
    g.fill();
  }
  g.globalAlpha = 1;
  // grass tufts
  g.strokeStyle = 'rgba(70, 120, 40, 0.45)';
  g.lineWidth = 1.5;
  for (let i = 0; i < 2600; i++) {
    const x = rr(0, WORLD.w);
    const y = rr(0, WORLD.h);
    g.beginPath();
    g.moveTo(x, y); g.lineTo(x - 3, y - 6);
    g.moveTo(x, y); g.lineTo(x + 1, y - 7);
    g.moveTo(x, y); g.lineTo(x + 4, y - 5);
    g.stroke();
  }

  // 2. dirt paths from the hub to every camp and cache
  const hub = world.spawn;
  const targets: Point[] = [...world.camps, ...world.caches];
  for (const [width, color] of [[40, '#c9b27a'], [30, '#dcc690'], [16, '#e8d6a6']] as const) {
    g.strokeStyle = color;
    g.lineWidth = width;
    g.lineCap = 'round';
    for (const t of targets) {
      const mx = (hub.x + t.x) / 2 + (t.y - hub.y) * 0.15;
      const my = (hub.y + t.y) / 2 - (t.x - hub.x) * 0.15;
      g.beginPath(); g.moveTo(hub.x, hub.y); g.quadraticCurveTo(mx, my, t.x, t.y); g.stroke();
    }
  }
  blob(g, hub.x, hub.y, 60, '#dcc690');

  // 3. river: sandy banks, deep water, shallow centre, foam
  const layers: [number, string][] = [[18, '#c9b37c'], [8, '#7ab06a'], [0, '#3d9fd0'], [-14, '#58b7e2'], [-30, '#86cfee']];
  for (const [extra, color] of layers) {
    g.fillStyle = color;
    for (const s of world.river) blob(g, s.x, s.y, Math.max(4, s.hw + extra), color);
  }
  g.strokeStyle = 'rgba(255,255,255,0.35)';
  g.lineWidth = 2;
  for (let i = 0; i < world.river.length; i += 2) {
    const s = world.river[i];
    if (rnd() < 0.5) continue;
    const off = rr(-0.8, 0.8) * s.hw;
    const x = s.x - s.ty * off;
    const y = s.y + s.tx * off;
    g.beginPath(); g.moveTo(x, y); g.lineTo(x + s.tx * rr(10, 26), y + s.ty * rr(10, 26)); g.stroke();
  }
  // lily pads + lotus near the banks
  for (let i = 0; i < world.river.length; i += 5) {
    if (rnd() < 0.45) continue;
    const s = world.river[i];
    const side = rnd() < 0.5 ? -1 : 1;
    const off = side * s.hw * rr(0.55, 0.85);
    const x = s.x - s.ty * off;
    const y = s.y + s.tx * off;
    g.fillStyle = '#4c9a3c';
    g.beginPath(); g.arc(x, y, rr(6, 10), 0.3, Math.PI * 2); g.lineTo(x, y); g.fill();
    if (rnd() < 0.4) {
      for (let p = 0; p < 5; p++) {
        const a = (p / 5) * Math.PI * 2;
        g.fillStyle = p % 2 ? '#ff9ec8' : '#ffc4dd';
        g.beginPath(); g.ellipse(x + Math.cos(a) * 4, y + Math.sin(a) * 4, 4, 2.5, a, 0, Math.PI * 2); g.fill();
      }
      blob(g, x, y, 2.5, '#ffe37a');
    }
  }
  // river-bank rocks
  for (let i = 0; i < world.river.length; i += 7) {
    const s = world.river[i];
    const side = rnd() < 0.5 ? -1 : 1;
    const off = side * (s.hw + rr(4, 14));
    paintRock(g, s.x - s.ty * off, s.y + s.tx * off, rr(5, 11));
  }

  // 4. bridges
  for (const b of world.bridges) {
    g.save();
    g.translate(b.x, b.y);
    g.rotate(b.angle);
    g.fillStyle = 'rgba(20,40,10,0.3)';
    g.fillRect(-b.len / 2 + 6, -b.wid / 2 + 8, b.len, b.wid);
    g.fillStyle = '#a77a48';
    g.fillRect(-b.len / 2, -b.wid / 2, b.len, b.wid);
    g.strokeStyle = '#7d5630';
    g.lineWidth = 2;
    for (let x = -b.len / 2; x < b.len / 2; x += 9) {
      g.beginPath(); g.moveTo(x, -b.wid / 2); g.lineTo(x, b.wid / 2); g.stroke();
    }
    g.fillStyle = '#6b4826';
    g.fillRect(-b.len / 2, -b.wid / 2 - 4, b.len, 5);
    g.fillRect(-b.len / 2, b.wid / 2 - 1, b.len, 5);
    g.restore();
  }

  // 5. ground detail: flowers, ferns, rocks, mushrooms, abandoned cars
  const flowerCols = ['#ff9ec8', '#ffffff', '#ffe37a', '#c9a3ff', '#ff7a6b'];
  for (let i = 0; i < 180; i++) {
    const x = rr(0, WORLD.w);
    const y = rr(0, WORLD.h);
    if (!clear(x, y, 10, { river: 4, camp: 60, cache: 40 })) continue;
    world.flowers.push({ x, y });
    const col = flowerCols[i % flowerCols.length];
    for (let k = 0; k < 9; k++) blob(g, x + rr(-16, 16), y + rr(-12, 12), rr(1.8, 3.2), col);
  }
  g.strokeStyle = '#4c8f3a';
  g.lineWidth = 2;
  for (let i = 0; i < 140; i++) {
    const x = rr(0, WORLD.w);
    const y = rr(0, WORLD.h);
    if (!clear(x, y, 12, { river: 4, camp: 60, cache: 40 })) continue;
    for (let k = 0; k < 7; k++) {
      const a = (k / 7) * Math.PI * 2;
      g.beginPath(); g.moveTo(x, y); g.quadraticCurveTo(x + Math.cos(a + 0.4) * 8, y + Math.sin(a + 0.4) * 8, x + Math.cos(a) * 15, y + Math.sin(a) * 15); g.stroke();
    }
  }
  for (let i = 0; i < 110; i++) {
    const x = rr(0, WORLD.w);
    const y = rr(0, WORLD.h);
    if (clear(x, y, 12, { river: 6, camp: 60, cache: 40 })) paintRock(g, x, y, rr(6, 16));
  }
  for (let i = 0; i < 45; i++) {
    const x = rr(0, WORLD.w);
    const y = rr(0, WORLD.h);
    if (clear(x, y, 28, { river: 10, camp: 80, cache: 60 })) paintMushrooms(g, x, y, rr);
  }
  for (let i = 0; i < 8; i++) {
    const x = rr(0, WORLD.w);
    const y = rr(0, WORLD.h);
    if (clear(x, y, 40, { river: 20, camp: 120, cache: 80 })) paintCar(g, x, y, rr(-0.6, 0.6), rr);
  }

  // 6. camps and supply caches
  for (const camp of world.camps) paintCamp(g, camp, rr);
  for (const cache of world.caches) paintCache(g, cache);

  // 7. ruins
  for (const r of world.ruins) paintRuin(g, r, rr);

  // 8. decorative small trees, pines and bushes (forest clusters + scatter)
  for (let i = 0; i < 420; i++) {
    const forest = rnd() < 0.7;
    const fc = FOREST_CENTERS[i % FOREST_CENTERS.length];
    const x = forest ? fc.x + rr(-340, 340) : rr(0, WORLD.w);
    const y = forest ? fc.y + rr(-260, 260) : rr(0, WORLD.h);
    const r = rr(14, 30);
    if (!clear(x, y, r * 0.8, { river: 6, camp: 90, cache: 70 })) continue;
    const kind = rnd();
    if (kind < 0.35) paintPine(g, x, y, r);
    else if (kind < 0.8) paintTree(g, x, y, r, rr, rnd() < 0.15 ? 2 : rnd() < 0.5 ? 0 : 1);
    else for (let k = 0; k < 3; k++) blob(g, x + rr(-10, 10), y + rr(-8, 8), r * 0.45, k % 2 ? '#5fae43' : '#4a9136');
  }

  // 9. giant trees last so their canopies sit on top
  for (const t of world.trees) paintTree(g, t.x, t.y, t.r, rr, rnd() < 0.2 ? 2 : 1);

  // soft vignette at the world edge
  const edge = 120;
  const sides: [number, number, number, number, number, number, number, number][] = [
    [0, 0, 0, edge, 0, 0, WORLD.w, edge],
    [0, WORLD.h, 0, WORLD.h - edge, 0, WORLD.h - edge, WORLD.w, edge],
    [0, 0, edge, 0, 0, 0, edge, WORLD.h],
    [WORLD.w, 0, WORLD.w - edge, 0, WORLD.w - edge, 0, edge, WORLD.h],
  ];
  for (const [x0, y0, x1, y1, rx, ry, rw, rh] of sides) {
    const grad = g.createLinearGradient(x0, y0, x1, y1);
    grad.addColorStop(0, 'rgba(25, 50, 20, 0.55)');
    grad.addColorStop(1, 'rgba(25, 50, 20, 0)');
    g.fillStyle = grad;
    g.fillRect(rx, ry, rw, rh);
  }
}
