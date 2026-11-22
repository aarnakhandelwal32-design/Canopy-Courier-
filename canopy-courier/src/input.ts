const GAME_KEYS = new Set([
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space',
  'KeyW', 'KeyA', 'KeyS', 'KeyD',
]);

/** Keyboard + mouse state. Space or left mouse button drives the tractor beam. */
export class Input {
  private keys = new Set<string>();
  private mouse = false;

  constructor(canvas: HTMLElement) {
    window.addEventListener('keydown', (e) => {
      if (GAME_KEYS.has(e.code)) e.preventDefault();
      this.keys.add(e.code);
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.reset());
    canvas.addEventListener('mousedown', (e) => {
      if (e.button === 0) this.mouse = true;
    });
    window.addEventListener('mouseup', (e) => {
      if (e.button === 0) this.mouse = false;
    });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  reset(): void {
    this.keys.clear();
    this.mouse = false;
  }

  private down(...codes: string[]): boolean {
    return codes.some((c) => this.keys.has(c));
  }

  get axisX(): number {
    return (this.down('KeyD', 'ArrowRight') ? 1 : 0) - (this.down('KeyA', 'ArrowLeft') ? 1 : 0);
  }

  get axisY(): number {
    return (this.down('KeyS', 'ArrowDown') ? 1 : 0) - (this.down('KeyW', 'ArrowUp') ? 1 : 0);
  }

  get beam(): boolean {
    return this.down('Space') || this.mouse;
  }
}
