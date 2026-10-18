import './style.css';
import { cameraIsLive, openCamera, type Facing } from './camera';
import { DelayEngine, MAX_DELAY_MS } from './delay-engine';

const DELAY_STORAGE_KEY = 'video-delay:seconds';

const byId = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const app = byId<HTMLElement>('app');
const output = byId<HTMLCanvasElement>('output');
const live = byId<HTMLVideoElement>('live');
const overlay = byId<HTMLDivElement>('overlay');
const overlayText = byId<HTMLDivElement>('overlay-text');
const intro = byId<HTMLElement>('intro');
const startButton = byId<HTMLButtonElement>('start');
const controls = byId<HTMLElement>('controls');
const delayInput = byId<HTMLInputElement>('delay');
const delayValue = byId<HTMLOutputElement>('delay-value');
const flipButton = byId<HTMLButtonElement>('flip');
const mirrorButton = byId<HTMLButtonElement>('mirror');
const liveButton = byId<HTMLButtonElement>('toggle-live');
const stats = byId<HTMLDivElement>('stats');
const errorEl = byId<HTMLParagraphElement>('error');

const engine = new DelayEngine(live, output);
engine.onError = (e) => showError(e.message);

let facing: Facing = 'environment';
let started = false;

function isSupported(): boolean {
  return (
    'VideoEncoder' in window &&
    'VideoDecoder' in window &&
    'VideoFrame' in window &&
    !!navigator.mediaDevices?.getUserMedia &&
    'requestVideoFrameCallback' in HTMLVideoElement.prototype
  );
}

function showError(message: string): void {
  errorEl.textContent = message;
  errorEl.hidden = false;
}

function clearError(): void {
  errorEl.hidden = true;
}

function describeCameraError(e: unknown): string {
  if (e instanceof DOMException && e.name === 'NotAllowedError') {
    return 'Camera permission was denied. Allow camera access for this site and try again.';
  }
  if (e instanceof DOMException && e.name === 'NotFoundError') return 'No camera was found.';
  return e instanceof Error ? e.message : String(e);
}

function formatSeconds(total: number): string {
  if (total < 60) return `${total}s`;
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function setDelay(seconds: number): void {
  const clamped = Math.min(MAX_DELAY_MS / 1000, Math.max(1, Math.round(seconds)));
  engine.delayMs = clamped * 1000;
  delayInput.value = String(clamped);
  delayValue.textContent = formatSeconds(clamped);
  localStorage.setItem(DELAY_STORAGE_KEY, String(clamped));
}

async function keepScreenAwake(): Promise<void> {
  try {
    await navigator.wakeLock?.request('screen');
  } catch {
    // Not critical; e.g. low-power mode can refuse it.
  }
}

let lastStats = '';
function renderStatus(): void {
  requestAnimationFrame(renderStatus);
  const status = engine.getStatus();

  overlay.hidden = status.waitingMs === null;
  if (status.waitingMs !== null) {
    overlayText.textContent = `Buffering… ${Math.ceil(status.waitingMs / 1000)}s`;
  }

  const text = status.width
    ? `${status.width}×${status.height} · ${Math.round(status.bufferedSeconds)}s buffered · ${(status.bufferedBytes / 1e6).toFixed(1)} MB`
    : 'Starting camera…';
  if (text !== lastStats) {
    stats.textContent = text;
    lastStats = text;
  }
}

startButton.addEventListener('click', async () => {
  startButton.disabled = true;
  clearError();
  try {
    await openCamera(live, facing);
  } catch (e) {
    showError(describeCameraError(e));
    startButton.disabled = false;
    return;
  }
  started = true;
  intro.hidden = true;
  controls.hidden = false;
  engine.start();
  requestAnimationFrame(renderStatus);
  void keepScreenAwake();
});

delayInput.addEventListener('input', () => setDelay(Number(delayInput.value)));

controls.querySelector('.presets')!.addEventListener('click', (event) => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button[data-delay]');
  if (button) setDelay(Number(button.dataset.delay));
});

flipButton.addEventListener('click', async () => {
  const previous = facing;
  facing = facing === 'environment' ? 'user' : 'environment';
  flipButton.disabled = true;
  try {
    await openCamera(live, facing);
    clearError();
  } catch (e) {
    showError(describeCameraError(e));
    facing = previous;
    await openCamera(live, facing).catch(() => {});
  } finally {
    flipButton.disabled = false;
  }
});

mirrorButton.addEventListener('click', () => {
  const on = app.classList.toggle('mirrored');
  mirrorButton.setAttribute('aria-pressed', String(on));
});

liveButton.addEventListener('click', () => {
  const hidden = live.classList.toggle('live-hidden');
  liveButton.setAttribute('aria-pressed', String(!hidden));
});

// Tap the video to hide/show controls.
output.addEventListener('click', () => {
  if (started) app.classList.toggle('controls-hidden');
});

// iOS stops the camera and releases the wake lock when the page is backgrounded.
document.addEventListener('visibilitychange', async () => {
  if (!started || document.visibilityState !== 'visible') return;
  if (!cameraIsLive(live)) {
    await openCamera(live, facing).catch((e) => showError(describeCameraError(e)));
  } else {
    live.play().catch(() => {});
  }
  void keepScreenAwake();
});

setDelay(Number(localStorage.getItem(DELAY_STORAGE_KEY)) || 5);

if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`).catch(console.error);
}

if (!window.isSecureContext) {
  startButton.disabled = true;
  showError('Camera access requires HTTPS.');
} else if (!isSupported()) {
  startButton.disabled = true;
  showError("This browser can't do delayed video. Try Safari on iOS 16.4+ or Chrome.");
}
