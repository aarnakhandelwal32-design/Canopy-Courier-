// Entry point: wires the canvas game to the DOM screens, keyboard shortcuts and the frame loop.
import { AudioEngine } from './audio';
import { Game, type MatchResult } from './game';
import { Input } from './input';

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing #${id}`);
  return el as T;
};

const canvas = $<HTMLCanvasElement>('game');
const startScreen = $('start');
const overScreen = $('over');
const muteBtn = $<HTMLButtonElement>('mute');

const audio = new AudioEngine();
const input = new Input(canvas);
const game = new Game(canvas, audio, input);
let overTimer = 0;

function syncMute(): void {
  muteBtn.textContent = audio.muted ? '♪ MUTED' : '♪ SOUND ON';
  muteBtn.setAttribute('aria-pressed', String(audio.muted));
}

function toggleMute(): void {
  audio.unlock();
  audio.toggleMute();
  syncMute();
}

function launch(): void {
  audio.unlock();
  audio.ui();
  window.clearTimeout(overTimer);
  startScreen.classList.add('hidden');
  overScreen.classList.add('hidden');
  (document.activeElement as HTMLElement | null)?.blur();
  canvas.focus();
  game.start();
}

function showMenu(): void {
  audio.ui();
  overScreen.classList.add('hidden');
  startScreen.classList.remove('hidden');
  game.state = 'start';
}

game.onMatchOver = (r: MatchResult): void => {
  $('over-kicker').textContent = r.victory ? `Shift complete · ${r.timeLeft}s to spare` : 'Out of time';
  $('over-title').innerHTML = r.victory ? 'All camps <span>supplied!</span>' : "Time's <span>up!</span>";
  $('stars').innerHTML = [1, 2, 3].map((i) => `<span class="${i <= r.stars ? 'on' : ''}">★</span>`).join('');
  $('rank').textContent = r.title;
  $('final-score').textContent = String(r.score);
  $('final-delivered').textContent = String(r.delivered);
  $('final-perfects').textContent = String(r.perfects);
  $('final-lost').textContent = String(r.lost);
  $('final-hits').textContent = String(r.hits);
  $('best').textContent = r.newBest ? `New personal best · ${r.best}` : `Personal best · ${r.best}`;
  $('best').classList.toggle('new-best', r.newBest);
  overTimer = window.setTimeout(() => {
    overScreen.classList.remove('hidden');
    audio.setScene('menu');
    $('rematch').focus();
  }, 1800);
};

$('launch').addEventListener('click', launch);
$('rematch').addEventListener('click', launch);
$('menu').addEventListener('click', showMenu);
muteBtn.addEventListener('click', () => {
  toggleMute();
  muteBtn.blur();
});

// The first interaction anywhere unlocks audio so the title music can play.
window.addEventListener('pointerdown', () => audio.unlock(), { once: true });

window.addEventListener('keydown', (e) => {
  if (e.repeat) return;
  audio.unlock();
  if (e.code === 'KeyM') {
    toggleMute();
  } else if ((e.code === 'KeyP' || e.code === 'Escape') && game.state === 'playing') {
    game.paused = !game.paused;
    input.reset();
  } else if (e.code === 'Enter' && game.state !== 'playing') {
    e.preventDefault();
    launch();
  }
});

document.addEventListener('visibilitychange', () => {
  if (document.hidden && game.state === 'playing') game.paused = true;
});

syncMute();

let last = performance.now();
function frame(now: number): void {
  const dt = Math.min(1 / 30, (now - last) / 1000);
  last = now;
  game.update(dt);
  game.render();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
