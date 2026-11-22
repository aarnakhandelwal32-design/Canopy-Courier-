// Visual juice: particles, floating text, banners and screen shake.
import { W, H, FONT, PALETTE } from './config';

export type ParticleKind = 'glow' | 'spark' | 'confetti' | 'ripple' | 'leaf';

export interface Particle {
  x: number; y: number; vx: number; vy: number;
  life: number; max: number; size: number; color: string;
  g: number; drag: number; kind: ParticleKind; rot: number; vr: number;
}

interface FloatText {
  x: number; y: number; vy: number; text: string; color: string;
  size: number; life: number; max: number; banner: boolean;
}

const MAX_PARTICLES = 1400;
const CONFETTI = ['#ff8a3d', '#ffcf4a', '#ff9ec8', '#ffffff', '#8ff07a', '#3fbfff', '#b07cff'];
const rand = (a: number, b: number): number => a + Math.random() * (b - a);

export class FX {
  private particles: Particle[] = [];
  private texts: FloatText[] = [];
  private shake = 0;

  clear(): void {
    this.particles.length = 0;
    this.texts.length = 0;
    this.shake = 0;
  }

  emit(p: Partial<Particle> & { x: number; y: number }): void {
    if (this.particles.length >= MAX_PARTICLES) this.particles.shift();
    const life = p.life ?? 0.6;
    this.particles.push({
      vx: 0, vy: 0, size: 3, color: '#fff', g: 0, drag: 2, kind: 'glow', rot: 0, vr: 0,
      ...p, life, max: life,
    });
  }

  burst(x: number, y: number, n: number, colors: string[], speed: number, opts: Partial<Particle> = {}): void {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const s = speed * rand(0.3, 1);
      this.emit({
        x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s,
        color: colors[i % colors.length], life: rand(0.35, 0.8), size: rand(2, 4), ...opts,
      });
    }
  }

  ring(x: number, y: number, n: number, color: string, speed: number): void {
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      this.emit({ x, y, vx: Math.cos(a) * speed, vy: Math.sin(a) * speed, color, life: 0.45, size: 2.5, drag: 4 });
    }
  }

  sparks(x: number, y: number, n: number, color: string): void {
    this.burst(x, y, n, [color, '#ffffff'], 520, { kind: 'spark', g: 600, drag: 3, life: 0.4 });
  }

  /** Expanding water ring (size = start radius, vr = growth px/s). */
  ripple(x: number, y: number, size: number, grow: number, life = 0.9, color = '#ffffff'): void {
    this.emit({ x, y, size, vr: grow, life, kind: 'ripple', color, drag: 0 });
  }

  leaves(x: number, y: number, n: number, colors = ['#4f9a38', '#6db847', '#8fd062', '#3f7d2f']): void {
    this.burst(x, y, n, colors, 320, { kind: 'leaf', drag: 2.5, life: 0.9, size: 5 });
    for (const p of this.particles.slice(-n)) p.vr = rand(-10, 10);
  }

  confetti(x: number, y: number, n: number): void {
    for (let i = 0; i < n; i++) {
      this.emit({
        x: x + rand(-20, 20), y: y + rand(-40, 40),
        vx: rand(-520, 520), vy: rand(-760, -160),
        g: 900, drag: 1.3, life: rand(1.3, 2.4), size: rand(4, 8),
        kind: 'confetti', color: CONFETTI[i % CONFETTI.length], rot: rand(0, 6.28), vr: rand(-14, 14),
      });
    }
    this.burst(x, y, 50, ['#ffffff', '#fff3a0', '#ffcf4a'], 700, { life: 0.7, drag: 3.5, size: 3 });
  }

  text(x: number, y: number, text: string, color: string, size = 28, life = 1.1): void {
    this.texts.push({ x, y, vy: -60, text, color, size, life, max: life, banner: false });
  }

  banner(text: string, color: string, size = 84, life = 1.4): void {
    this.texts = this.texts.filter((t) => !t.banner);
    this.texts.push({ x: W / 2, y: H * 0.4, vy: 0, text, color, size, life, max: life, banner: true });
  }

  addShake(v: number): void {
    this.shake = Math.min(28, this.shake + v);
  }

  shakeOffset(): { x: number; y: number } {
    return { x: (Math.random() - 0.5) * 2 * this.shake, y: (Math.random() - 0.5) * 2 * this.shake };
  }

  update(dt: number): void {
    const ps = this.particles;
    for (let i = ps.length - 1; i >= 0; i--) {
      const p = ps[i];
      p.life -= dt;
      if (p.life <= 0) {
        ps[i] = ps[ps.length - 1];
        ps.pop();
        continue;
      }
      const d = Math.exp(-p.drag * dt);
      p.vx *= d;
      p.vy = p.vy * d + p.g * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      if (p.kind !== 'ripple') p.rot += p.vr * dt;
    }
    for (const t of this.texts) {
      t.life -= dt;
      t.y += t.vy * dt;
    }
    this.texts = this.texts.filter((t) => t.life > 0);
    this.shake *= Math.exp(-8 * dt);
    if (this.shake < 0.1) this.shake = 0;
  }

  /** Particles + world-space floating text (drawn inside the shaken camera). */
  draw(ctx: CanvasRenderingContext2D): void {
    ctx.save();
    for (const p of this.particles) {
      if (p.kind === 'ripple') {
        const a = p.life / p.max;
        ctx.globalAlpha = a * 0.8;
        ctx.strokeStyle = p.color;
        ctx.lineWidth = 2 + a * 2;
        ctx.beginPath();
        ctx.ellipse(p.x, p.y, p.size + (1 - a) * p.vr * p.max, (p.size + (1 - a) * p.vr * p.max) * 0.7, 0, 0, Math.PI * 2);
        ctx.stroke();
      } else if (p.kind === 'leaf') {
        ctx.globalAlpha = Math.min(1, (p.life / p.max) * 2);
        ctx.fillStyle = p.color;
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        ctx.beginPath();
        ctx.ellipse(0, 0, p.size, p.size * 0.5, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }
    }
    ctx.globalCompositeOperation = 'lighter';
    for (const p of this.particles) {
      if (p.kind === 'confetti' || p.kind === 'ripple' || p.kind === 'leaf') continue;
      const a = p.life / p.max;
      ctx.globalAlpha = a;
      if (p.kind === 'spark') {
        ctx.strokeStyle = p.color;
        ctx.lineWidth = p.size * 0.6;
        ctx.beginPath();
        ctx.moveTo(p.x, p.y);
        ctx.lineTo(p.x - p.vx * 0.03, p.y - p.vy * 0.03);
        ctx.stroke();
      } else {
        ctx.fillStyle = p.color;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size * (0.4 + a * 0.6), 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.globalCompositeOperation = 'source-over';
    for (const p of this.particles) {
      if (p.kind !== 'confetti') continue;
      ctx.globalAlpha = Math.min(1, (p.life / p.max) * 2);
      ctx.fillStyle = p.color;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.fillRect(-p.size / 2, -p.size / 4, p.size, p.size / 2 * (0.4 + Math.abs(Math.sin(p.rot * 1.7))));
      ctx.restore();
    }
    ctx.restore();

    for (const t of this.texts) if (!t.banner) this.drawText(ctx, t, 1);
  }

  /** Full-screen announcement banners (drawn above the HUD, not shaken). */
  drawBanners(ctx: CanvasRenderingContext2D): void {
    for (const t of this.texts) {
      if (!t.banner) continue;
      const k = 1 - t.life / t.max;
      const s = k < 0.12 ? 0.6 + (k / 0.12) * 0.55 : k < 0.2 ? 1.15 - ((k - 0.12) / 0.08) * 0.15 : 1;
      this.drawText(ctx, t, s);
    }
  }

  private drawText(ctx: CanvasRenderingContext2D, t: FloatText, scale: number): void {
    const fade = Math.min(1, t.life / 0.35);
    ctx.save();
    ctx.globalAlpha = fade;
    ctx.translate(t.x, t.y);
    ctx.scale(scale, scale);
    ctx.font = `900 ${t.size}px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    ctx.lineWidth = Math.max(4, t.size / 7);
    ctx.strokeStyle = PALETTE.ink;
    ctx.shadowColor = 'rgba(0, 0, 0, 0.35)';
    ctx.shadowOffsetY = Math.max(2, t.size / 16);
    ctx.strokeText(t.text, 0, 0);
    ctx.shadowColor = 'transparent';
    ctx.fillStyle = t.color;
    ctx.fillText(t.text, 0, 0);
    ctx.restore();
  }
}
