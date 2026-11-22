// Screen-space UI drawn on the canvas: score panel, delivery progress, clock,
// minimap and off-screen direction arrows.
import { W, H, WORLD, QUOTA, TIME, PALETTE, FONT } from './config';
import { MINI, roundRect, type Camp, type Point, type World } from './world';

export interface HudState {
  t: number;
  score: number;
  delivered: number;
  timeLeft: number;
  carrying: Camp | null;
  hint: string;
  hintColor: string;
}

export interface Blip extends Point { color: string; kind: 'crate' | 'scav' }

function panel(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r = 16): void {
  ctx.fillStyle = PALETTE.panel;
  roundRect(ctx, x, y, w, h, r);
  ctx.fill();
  ctx.strokeStyle = 'rgba(255, 246, 220, 0.18)';
  ctx.lineWidth = 2;
  ctx.stroke();
}

/** Tiny top-down drone glyph used in the HUD badge. */
function droneIcon(ctx: CanvasRenderingContext2D, x: number, y: number, s: number): void {
  ctx.save();
  ctx.translate(x, y);
  ctx.strokeStyle = PALETTE.gold;
  ctx.lineWidth = 2;
  for (const [dx, dy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
    ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(dx * s, dy * s); ctx.stroke();
    ctx.beginPath(); ctx.arc(dx * s, dy * s, s * 0.55, 0, Math.PI * 2); ctx.stroke();
  }
  ctx.fillStyle = '#f2a23a';
  roundRect(ctx, -s * 0.55, -s * 0.55, s * 1.1, s * 1.1, 3);
  ctx.fill();
  ctx.restore();
}

export function drawHud(ctx: CanvasRenderingContext2D, s: HudState): void {
  ctx.save();
  ctx.textBaseline = 'middle';

  // --- left: badge + score + delivery progress
  panel(ctx, 20, 18, 300, 78, 39);
  ctx.fillStyle = '#2d4a26';
  ctx.beginPath(); ctx.arc(59, 57, 31, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = PALETTE.gold;
  ctx.lineWidth = 3;
  ctx.stroke();
  droneIcon(ctx, 59, 57, 11);
  ctx.font = `700 12px ${FONT}`;
  ctx.fillStyle = 'rgba(255,246,220,0.65)';
  ctx.textAlign = 'left';
  ctx.fillText('SCORE', 102, 37);
  ctx.font = `900 26px ${FONT}`;
  ctx.fillStyle = PALETTE.cream;
  ctx.fillText(String(s.score), 102, 61);
  // progress bar
  const bx = 102;
  const bw = 200;
  const k = Math.min(1, s.delivered / QUOTA);
  ctx.fillStyle = 'rgba(0,0,0,0.35)';
  roundRect(ctx, bx, 78, bw, 9, 4.5); ctx.fill();
  ctx.fillStyle = PALETTE.good;
  if (k > 0) { roundRect(ctx, bx, 78, Math.max(9, bw * k), 9, 4.5); ctx.fill(); }
  ctx.font = `800 13px ${FONT}`;
  ctx.textAlign = 'right';
  ctx.fillStyle = PALETTE.cream;
  ctx.fillText(`CRATES ${s.delivered}/${QUOTA}`, bx + bw, 37);

  // --- centre: clock
  const tl = Math.max(0, s.timeLeft);
  const urgent = tl <= TIME.warn;
  const flash = urgent && Math.sin(s.t * 10) > 0;
  panel(ctx, W / 2 - 86, 18, 172, 56, 28);
  // hourglass
  ctx.save();
  ctx.translate(W / 2 - 52, 46);
  ctx.fillStyle = urgent ? PALETTE.danger : PALETTE.gold;
  ctx.beginPath();
  ctx.moveTo(-9, -13); ctx.lineTo(9, -13); ctx.lineTo(1.5, 0); ctx.lineTo(9, 13); ctx.lineTo(-9, 13); ctx.lineTo(-1.5, 0);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
  ctx.font = `900 30px ${FONT}`;
  ctx.textAlign = 'center';
  ctx.fillStyle = flash ? PALETTE.danger : PALETTE.cream;
  const sec = Math.ceil(tl);
  ctx.fillText(`${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`, W / 2 + 14, 47);

  // --- bottom: contextual hint
  ctx.font = `800 16px ${FONT}`;
  const hw = ctx.measureText(s.hint).width + 44;
  panel(ctx, W / 2 - hw / 2, H - 56, hw, 38, 19);
  ctx.fillStyle = s.hintColor;
  ctx.textAlign = 'center';
  ctx.fillText(s.hint, W / 2, H - 36);
  ctx.font = `700 12px ${FONT}`;
  ctx.textAlign = 'left';
  ctx.fillStyle = 'rgba(255,246,220,0.7)';
  ctx.fillText('P pause · M mute', 24, H - 30);
  ctx.restore();
}

export function drawMinimap(
  ctx: CanvasRenderingContext2D, world: World, cam: Point, drone: Point & { heading: number },
  blips: Blip[], dest: Camp | null, t: number,
): void {
  const x = W - MINI.w - 22;
  const y = 18;
  const sx = MINI.w / WORLD.w;
  const sy = MINI.h / WORLD.h;
  ctx.save();
  panel(ctx, x - 6, y - 6, MINI.w + 12, MINI.h + 34, 14);
  ctx.save();
  roundRect(ctx, x, y, MINI.w, MINI.h, 9);
  ctx.clip();
  ctx.drawImage(world.mini, x, y);
  // camera viewport
  ctx.strokeStyle = 'rgba(255,255,255,0.75)';
  ctx.lineWidth = 1.5;
  ctx.strokeRect(x + cam.x * sx, y + cam.y * sy, W * sx, H * sy);
  for (const c of world.camps) {
    const pulse = c === dest ? 4 + Math.sin(t * 8) * 2 : 0;
    ctx.fillStyle = c.color;
    ctx.beginPath(); ctx.arc(x + c.x * sx, y + c.y * sy, 5 + pulse, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = PALETTE.ink;
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }
  for (const b of blips) {
    ctx.fillStyle = b.color;
    if (b.kind === 'crate') {
      ctx.fillRect(x + b.x * sx - 3.5, y + b.y * sy - 3.5, 7, 7);
      ctx.strokeStyle = PALETTE.ink;
      ctx.strokeRect(x + b.x * sx - 3.5, y + b.y * sy - 3.5, 7, 7);
    } else {
      ctx.beginPath(); ctx.arc(x + b.x * sx, y + b.y * sy, 3.5, 0, Math.PI * 2); ctx.fill();
    }
  }
  // player arrow
  ctx.save();
  ctx.translate(x + drone.x * sx, y + drone.y * sy);
  ctx.rotate(drone.heading);
  ctx.fillStyle = '#ffffff';
  ctx.strokeStyle = PALETTE.ink;
  ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.moveTo(8, 0); ctx.lineTo(-5, -5); ctx.lineTo(-2, 0); ctx.lineTo(-5, 5); ctx.closePath();
  ctx.fill(); ctx.stroke();
  ctx.restore();
  ctx.restore();
  ctx.font = `800 12px ${FONT}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = PALETTE.cream;
  ctx.fillText('OVERGROWN VALLEY', x + MINI.w / 2, y + MINI.h + 14);
  ctx.restore();
}

/** Edge-of-screen arrow pointing at an off-screen world target. */
export function drawPointer(ctx: CanvasRenderingContext2D, cam: Point, target: Point, color: string, label: string, t: number): void {
  const sx = target.x - cam.x;
  const sy = target.y - cam.y;
  const margin = 60;
  if (sx > margin && sx < W - margin && sy > margin + 90 && sy < H - margin - 40) return;
  const cx = W / 2;
  const cy = H / 2;
  const ang = Math.atan2(sy - cy, sx - cx);
  // project onto an inset rectangle
  const hw = W / 2 - 70;
  const hh = H / 2 - 100;
  const k = Math.min(hw / Math.abs(Math.cos(ang) || 1e-6), hh / Math.abs(Math.sin(ang) || 1e-6));
  const px = cx + Math.cos(ang) * k;
  const py = cy + Math.sin(ang) * k + 10;
  const bob = Math.sin(t * 6) * 4;
  ctx.save();
  ctx.translate(px + Math.cos(ang) * bob, py + Math.sin(ang) * bob);
  ctx.save();
  ctx.rotate(ang);
  ctx.fillStyle = color;
  ctx.strokeStyle = PALETTE.ink;
  ctx.lineWidth = 3;
  ctx.beginPath(); ctx.moveTo(22, 0); ctx.lineTo(-10, -15); ctx.lineTo(-4, 0); ctx.lineTo(-10, 15); ctx.closePath();
  ctx.stroke(); ctx.fill();
  ctx.restore();
  ctx.font = `800 13px ${FONT}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const dist = Math.round(Math.hypot(sx - cx, sy - cy) / 10);
  const text = `${label} · ${dist}m`;
  const tw = ctx.measureText(text).width + 16;
  const ly = Math.sin(ang) > 0.3 ? -30 : 30;
  ctx.fillStyle = PALETTE.panel;
  roundRect(ctx, -tw / 2, ly - 11, tw, 22, 11);
  ctx.fill();
  ctx.fillStyle = color;
  ctx.fillText(text, 0, ly + 1);
  ctx.restore();
}
