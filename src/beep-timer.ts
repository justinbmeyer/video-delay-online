export type BeepKind = 'warning' | 'interval';

/** Fires an `interval` beep every `periodMs`, plus an optional `warning` beep `warningMs` before each one. */
export class BeepTimer {
  periodMs = 5000;
  warningMs = 0;
  onBeep?: (kind: BeepKind) => void;

  #startedAt: number | null = null;
  #cycle = 0;
  #warned = false;

  get running(): boolean {
    return this.#startedAt !== null;
  }

  start(now = performance.now()): void {
    this.#startedAt = now;
    this.#cycle = 0;
    this.#warned = false;
  }

  stop(): void {
    this.#startedAt = null;
  }

  /** Whether the timer is inside the warning window before the next interval beep. */
  inWarning(remainingMs: number): boolean {
    return this.warningMs > 0 && this.warningMs < this.periodMs && remainingMs <= this.warningMs;
  }

  /** Fires any due beeps and returns ms until the next interval beep, or null when stopped. */
  tick(now = performance.now()): number | null {
    if (this.#startedAt === null) return null;
    const elapsed = now - this.#startedAt;
    const cycle = Math.floor(elapsed / this.periodMs);
    if (cycle !== this.#cycle) {
      // Only beep for the boundary we just crossed, not ones missed while the page was asleep.
      if (cycle === this.#cycle + 1) this.onBeep?.('interval');
      this.#cycle = cycle;
      this.#warned = false;
    }
    const remaining = this.periodMs - (elapsed % this.periodMs);
    if (!this.#warned && this.inWarning(remaining)) {
      this.#warned = true;
      this.onBeep?.('warning');
    }
    return remaining;
  }
}

let audio: AudioContext | null = null;

/** Must be called from a user gesture so browsers (notably iOS Safari) allow audio. */
export function unlockAudio(): void {
  audio ??= new AudioContext();
  if (audio.state !== 'running') audio.resume().catch(() => {});
}

export function playBeep(kind: BeepKind): void {
  if (!audio) return;
  if (audio.state !== 'running') audio.resume().catch(() => {});
  // Warning: one short low beep. Interval: two longer high beeps.
  const tones = kind === 'warning' ? [{ at: 0, freq: 660, len: 0.18 }] : [
    { at: 0, freq: 990, len: 0.3 },
    { at: 0.4, freq: 990, len: 0.3 },
  ];
  const start = audio.currentTime + 0.01;
  for (const { at, freq, len } of tones) {
    const osc = audio.createOscillator();
    const gain = audio.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    const t = start + at;
    // Short ramps avoid audible clicks at the start and end of each tone.
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(0.6, t + 0.01);
    gain.gain.setValueAtTime(0.6, t + len - 0.03);
    gain.gain.linearRampToValueAtTime(0, t + len);
    osc.connect(gain).connect(audio.destination);
    osc.start(t);
    osc.stop(t + len);
  }
}
