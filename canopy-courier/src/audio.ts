// Procedural audio: every sound is synthesised live with the Web Audio API.
// No audio files ship with the game.
//
//   master ─┬─ sfx      one-shot effects
//           ├─ music    lookahead-scheduled pentatonic loop
//           ├─ ambience looping wind + random birdsong
//           └─ hum      continuous rotor drone (pitch follows thrust)

type WebkitWindow = Window & { webkitAudioContext?: typeof AudioContext };
export type Scene = 'menu' | 'play' | 'silent';

const MUTE_KEY = 'canopy-courier.muted';
const MASTER_VOL = 0.8;
const HUM_BASE = [118, 177, 236];

const midi = (m: number): number => 440 * Math.pow(2, (m - 69) / 12);

// Music: C-major pentatonic melody over a I – vi – IV – V bass line.
const PENT = [60, 62, 64, 67, 69, 72, 74, 76, 79];
const BASS = [36, 33, 29, 31];
const MOTIFS = [
  [4, -1, 5, -1, 7, -1, 5, 4, 2, -1, 4, -1, -1, -1, -1, -1],
  [2, -1, 4, -1, 5, -1, 4, -1, 2, 1, 0, -1, -1, -1, 1, -1],
  [5, -1, 7, -1, 8, -1, 7, -1, 5, -1, 4, -1, 5, -1, -1, -1],
  [4, -1, 2, -1, 1, -1, 2, -1, 0, -1, -1, -1, -1, -1, -1, -1],
];
const STEP = 60 / 104 / 4; // sixteenth notes at 104 bpm

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private sfx: GainNode | null = null;
  private music: GainNode | null = null;
  private amb: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  private hum: GainNode | null = null;
  private humFilter: BiquadFilterNode | null = null;
  private humOscs: OscillatorNode[] = [];
  private nextStep = 0;
  private step = 0;
  private nextBird = 0;
  private scene: Scene = 'menu';
  private _muted = false;

  constructor() {
    try {
      this._muted = localStorage.getItem(MUTE_KEY) === '1';
    } catch {
      /* storage unavailable: default to sound on */
    }
  }

  get muted(): boolean {
    return this._muted;
  }

  /** Must run inside a user gesture (browser autoplay policy). Safe to call repeatedly. */
  unlock(): void {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume();
      return;
    }
    const AC = window.AudioContext ?? (window as WebkitWindow).webkitAudioContext;
    if (!AC) return;
    const ctx = new AC();
    this.ctx = ctx;

    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -18;
    comp.ratio.value = 4;
    comp.connect(ctx.destination);
    this.master = this.gain(this._muted ? 0 : MASTER_VOL, comp);
    this.sfx = this.gain(1, this.master);
    this.music = this.gain(0, this.master);
    this.amb = this.gain(0, this.master);

    const buf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    this.noise = buf;

    // Ambience: endless soft wind, its loudness slowly breathing.
    const wind = ctx.createBufferSource();
    wind.buffer = buf;
    wind.loop = true;
    const windLp = ctx.createBiquadFilter();
    windLp.type = 'lowpass';
    windLp.frequency.value = 420;
    const windGain = this.gain(0.12, this.amb);
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.12;
    lfo.connect(this.gain(0.06, windGain.gain));
    lfo.start();
    wind.connect(windLp).connect(windGain);
    wind.start();

    // Rotor hum: three detuned oscillators + band-passed noise for blade "air".
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 600;
    filter.Q.value = 2;
    const trem = this.gain(0.8, this.master);
    const chop = ctx.createOscillator();
    chop.frequency.value = 34;
    chop.connect(this.gain(0.2, trem.gain));
    chop.start();
    this.hum = this.gain(0, trem);
    filter.connect(this.hum);
    HUM_BASE.forEach((f, i) => {
      const o = ctx.createOscillator();
      o.type = i === 0 ? 'sawtooth' : 'triangle';
      o.frequency.value = f;
      o.connect(this.gain(i === 0 ? 0.6 : 0.3, filter));
      o.start();
      this.humOscs.push(o);
    });
    const air = ctx.createBufferSource();
    air.buffer = buf;
    air.loop = true;
    const airBp = ctx.createBiquadFilter();
    airBp.type = 'bandpass';
    airBp.frequency.value = 1400;
    airBp.Q.value = 0.8;
    air.connect(airBp).connect(this.gain(0.25, this.hum));
    air.start();
    this.humFilter = filter;

    this.nextStep = ctx.currentTime + 0.1;
    this.nextBird = ctx.currentTime + 1.5;
    this.setScene(this.scene);
  }

  private gain(value: number, dest: AudioNode | AudioParam): GainNode {
    const g = (this.ctx as AudioContext).createGain();
    g.gain.value = value;
    if (dest instanceof AudioParam) g.connect(dest);
    else g.connect(dest);
    return g;
  }

  toggleMute(): boolean {
    this._muted = !this._muted;
    try {
      localStorage.setItem(MUTE_KEY, this._muted ? '1' : '0');
    } catch {
      /* ignore */
    }
    if (this.ctx && this.master) this.master.gain.setTargetAtTime(this._muted ? 0 : MASTER_VOL, this.ctx.currentTime, 0.04);
    return this._muted;
  }

  /** Menu: music + ambience. Play: quieter music under the action. Silent: everything fades. */
  setScene(scene: Scene): void {
    this.scene = scene;
    const { ctx, music, amb } = this;
    if (!ctx || !music || !amb) return;
    const t = ctx.currentTime;
    music.gain.setTargetAtTime(scene === 'menu' ? 0.5 : scene === 'play' ? 0.3 : 0, t, 0.5);
    amb.gain.setTargetAtTime(scene === 'silent' ? 0.2 : 1, t, 0.5);
    if (scene !== 'play') this.setHum(0, 0, false);
  }

  /** level 0 = rotors off, 1 = flying. thrust 0..1 raises pitch. loaded = straining under a crate. */
  setHum(level: number, thrust: number, loaded: boolean): void {
    const { ctx, hum, humFilter } = this;
    if (!ctx || !hum || !humFilter) return;
    const t = ctx.currentTime;
    const pitch = (1 + thrust * 0.35) * (loaded ? 0.92 : 1);
    hum.gain.setTargetAtTime(level * (0.05 + thrust * 0.04), t, 0.08);
    humFilter.frequency.setTargetAtTime(600 + thrust * 900, t, 0.1);
    this.humOscs.forEach((o, i) => o.frequency.setTargetAtTime(HUM_BASE[i] * pitch, t, 0.12));
  }

  /** Call every frame: schedules music notes slightly ahead of time and random birdsong. */
  tick(): void {
    const { ctx } = this;
    if (!ctx || this.scene === 'silent') return;
    while (this.nextStep < ctx.currentTime + 0.15) {
      this.playStep(this.step, this.nextStep);
      this.nextStep += STEP;
      this.step = (this.step + 1) % 64;
    }
    if (ctx.currentTime > this.nextBird) {
      this.bird(ctx.currentTime);
      this.nextBird = ctx.currentTime + 2 + Math.random() * 5;
    }
  }

  private playStep(step: number, t: number): void {
    const bar = Math.floor(step / 16);
    const s = step % 16;
    const dest = this.music;
    if (!dest) return;
    if (s === 0 || s === 8) this.tone('sine', midi(BASS[bar]), midi(BASS[bar]), t, 0.55, 0.22, dest);
    if (s === 0) {
      // soft pad: root + fifth + tenth
      for (const iv of [12, 19, 28]) this.tone('triangle', midi(BASS[bar] + iv), midi(BASS[bar] + iv), t, STEP * 15, 0.03, dest, 0.25);
    }
    const n = MOTIFS[bar][s];
    if (n >= 0) {
      const f = midi(PENT[n]);
      this.tone('triangle', f, f, t, 0.4, 0.1, dest);
      this.tone('sine', f * 2, f * 2, t, 0.25, 0.025, dest);
    }
    if (s % 4 === 2) this.noiseBurst(t, 0.04, 0.025, 'highpass', 7000, 9000, 1, dest);
  }

  private bird(t: number): void {
    const dest = this.amb;
    if (!dest || !this.ctx) return;
    const pan = this.ctx.createStereoPanner();
    pan.pan.value = Math.random() * 2 - 1;
    pan.connect(dest);
    const base = 2200 + Math.random() * 1600;
    const n = 2 + Math.floor(Math.random() * 4);
    for (let i = 0; i < n; i++) {
      const st = t + i * (0.09 + Math.random() * 0.05);
      this.tone('sine', base * (0.9 + Math.random() * 0.2), base * (1.2 + Math.random() * 0.3), st, 0.07, 0.035, pan);
    }
  }

  // ------------------------------------------------------------------ primitives

  private tone(type: OscillatorType, f0: number, f1: number, start: number, dur: number, vol: number, dest?: AudioNode, attack = 0.01): void {
    const { ctx, sfx } = this;
    if (!ctx || !sfx) return;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(f0, start);
    if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(f1, start + dur);
    g.gain.setValueAtTime(0.0001, start);
    g.gain.exponentialRampToValueAtTime(vol, start + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, start + dur);
    o.connect(g).connect(dest ?? sfx);
    o.start(start);
    o.stop(start + dur + 0.05);
  }

  private noiseBurst(start: number, dur: number, vol: number, type: BiquadFilterType, f0: number, f1: number, q = 1, dest?: AudioNode): void {
    const { ctx, sfx, noise } = this;
    if (!ctx || !sfx || !noise) return;
    const src = ctx.createBufferSource();
    src.buffer = noise;
    const filter = ctx.createBiquadFilter();
    filter.type = type;
    filter.Q.value = q;
    filter.frequency.setValueAtTime(f0, start);
    filter.frequency.exponentialRampToValueAtTime(f1, start + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, start);
    g.gain.exponentialRampToValueAtTime(vol, start + Math.min(0.03, dur * 0.3));
    g.gain.exponentialRampToValueAtTime(0.0001, start + dur);
    src.connect(filter).connect(g).connect(dest ?? sfx);
    src.start(start, Math.random() * 1.5);
    src.stop(start + dur + 0.05);
  }

  private get now(): number {
    return this.ctx ? this.ctx.currentTime : 0;
  }

  // ------------------------------------------------------------------ sound effects

  /** Winch grabs a crate: latch clunk + rising servo whine. */
  pick(): void {
    const t = this.now;
    this.tone('square', 90, 60, t, 0.08, 0.15);
    this.noiseBurst(t, 0.05, 0.2, 'bandpass', 1800, 900, 2);
    this.tone('sawtooth', 300, 900, t + 0.04, 0.22, 0.05);
    this.tone('sine', 1320, 1320, t + 0.2, 0.15, 0.06);
  }

  /** Winch release: latch click + falling air whoosh. */
  release(): void {
    const t = this.now;
    this.noiseBurst(t, 0.03, 0.2, 'highpass', 3000, 5000);
    this.noiseBurst(t + 0.02, 0.4, 0.2, 'bandpass', 2400, 300, 1.4);
  }

  /** Wooden crate hits the ground. power 0..1 */
  thud(power: number): void {
    const t = this.now;
    this.tone('sine', 140, 50, t, 0.22, 0.25 + power * 0.2);
    this.noiseBurst(t, 0.12, 0.15 + power * 0.1, 'lowpass', 900, 200);
    this.tone('triangle', 420, 380, t, 0.08, 0.05);
  }

  /** Successful delivery: marimba arpeggio, plus a bell sparkle for a bullseye. */
  deliver(perfect: boolean): void {
    const t = this.now + 0.05;
    const notes = perfect ? [72, 76, 79, 84, 88] : [72, 76, 79, 84];
    notes.forEach((m, i) => {
      this.tone('triangle', midi(m), midi(m), t + i * 0.07, 0.5, 0.14);
      this.tone('sine', midi(m + 12), midi(m + 12), t + i * 0.07, 0.25, 0.04);
    });
    if (perfect) [96, 100, 103].forEach((m, i) => this.tone('sine', midi(m), midi(m), t + 0.35 + i * 0.05, 0.6, 0.05));
    this.noiseBurst(t, 0.9, 0.05, 'bandpass', 1000, 1600, 0.5); // little camp cheer
  }

  timeBonus(): void {
    const t = this.now + 0.2;
    this.tone('sine', 1568, 1568, t, 0.12, 0.08);
    this.tone('sine', 2093, 2093, t + 0.08, 0.2, 0.08);
  }

  /** Crate lost in the river: big splash + bubbles. */
  splash(): void {
    const t = this.now;
    this.noiseBurst(t, 0.5, 0.4, 'lowpass', 3000, 300, 0.7);
    this.noiseBurst(t, 0.2, 0.2, 'highpass', 2000, 6000);
    for (let i = 0; i < 6; i++) {
      const st = t + 0.15 + i * 0.07 + Math.random() * 0.04;
      const f = 300 + Math.random() * 400;
      this.tone('sine', f, f * 2.2, st, 0.06, 0.06);
    }
    this.tone('sine', 300, 150, t + 0.5, 0.5, 0.05);
  }

  /** Drone brushes a giant tree: leafy rustle. */
  rustle(power: number): void {
    const t = this.now;
    for (let i = 0; i < 3; i++) this.noiseBurst(t + i * 0.05, 0.18, 0.08 + power * 0.12, 'bandpass', 3000 + i * 800, 1500, 1.2);
    this.tone('sine', 110, 70, t, 0.12, 0.1 * power);
  }

  /** Drone hits a concrete ruin: dull stone knock. */
  stone(power: number): void {
    const t = this.now;
    this.tone('sine', 180, 70, t, 0.18, 0.2 + power * 0.2);
    [620, 1130].forEach((f, i) => this.tone('triangle', f, f * 0.95, t, 0.12, (0.05 + power * 0.05) / (i + 1)));
    this.noiseBurst(t, 0.08, 0.15, 'lowpass', 1500, 400);
  }

  /** Scavenger spots you carrying cargo: two-tone siren chirp. */
  scavAlert(): void {
    const t = this.now;
    this.tone('square', 880, 880, t, 0.09, 0.06);
    this.tone('square', 660, 660, t + 0.1, 0.09, 0.06);
    this.tone('square', 880, 880, t + 0.2, 0.09, 0.06);
  }

  /** Scavenger rams you: harsh buzz + metal clank. */
  scavHit(): void {
    const t = this.now;
    this.tone('sawtooth', 110, 60, t, 0.3, 0.15);
    [430, 1080, 1720].forEach((f, i) => this.tone('square', f, f * 0.96, t, 0.18, 0.06 / (i + 1)));
    this.noiseBurst(t, 0.1, 0.2, 'highpass', 1500, 4000);
  }

  /** Crate dropped on the wrong camp. */
  wrong(): void {
    const t = this.now;
    this.tone('square', 220, 200, t, 0.15, 0.06);
    this.tone('square', 165, 150, t + 0.16, 0.25, 0.06);
  }

  /** New crate appears at a cache. */
  spawn(): void {
    const t = this.now;
    this.tone('sine', 520, 1040, t, 0.15, 0.06);
    this.noiseBurst(t, 0.1, 0.05, 'highpass', 4000, 8000);
  }

  /** Low-time clock tick (urgent = last 3 seconds). */
  clock(urgent: boolean): void {
    const f = urgent ? 1760 : 1200;
    this.tone('square', f, f, this.now, 0.05, urgent ? 0.07 : 0.04);
  }

  countdown(go: boolean): void {
    const t = this.now;
    if (go) [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => this.tone('triangle', f, f, t + i * 0.05, 0.3, 0.1));
    else this.tone('triangle', 660, 660, t, 0.15, 0.1);
  }

  victory(): void {
    const t = this.now;
    [60, 64, 67, 72, 67, 72, 76, 79, 84].forEach((m, i) => {
      this.tone('triangle', midi(m), midi(m), t + i * 0.11, 0.45, 0.12);
      this.tone('sine', midi(m - 12), midi(m - 12), t + i * 0.11, 0.3, 0.06);
    });
    this.noiseBurst(t + 0.3, 1.4, 0.06, 'bandpass', 900, 1500, 0.5);
  }

  defeat(): void {
    const t = this.now;
    [67, 64, 60, 55].forEach((m, i) => this.tone('triangle', midi(m), midi(m) * 0.98, t + i * 0.22, 0.5, 0.1));
    this.tone('sine', midi(43), midi(36), t + 0.9, 0.9, 0.12);
  }

  ui(): void {
    this.tone('triangle', 880, 1320, this.now, 0.08, 0.06);
  }
}
