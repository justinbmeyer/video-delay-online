import './style.css';
import { cameraIsLive, openCamera, type Facing } from './camera';
import { DelayEngine, MAX_DELAY_MS } from './delay-engine';
import { BeepTimer, playBeep, unlockAudio } from './beep-timer';
import { clipFileName, clipToFile, saveFile } from './clip';

const DELAY_STORAGE_KEY = 'video-delay:seconds';
const WARNING_STORAGE_KEY = 'video-delay:beep-warning';
const WARNING_SECONDS = 10;

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
const delayPreset = byId<HTMLSelectElement>('delay-preset');
const flipButton = byId<HTMLButtonElement>('flip');
const mirrorButton = byId<HTMLButtonElement>('mirror');
const liveButton = byId<HTMLButtonElement>('toggle-live');
const fullscreenButton = byId<HTMLButtonElement>('fullscreen');
const fullscreenVideo = byId<HTMLVideoElement>('fullscreen-video');
const clipButton = byId<HTMLButtonElement>('clip');
const stats = byId<HTMLDivElement>('stats');
const errorEl = byId<HTMLParagraphElement>('error');
const timerEl = byId<HTMLDivElement>('timer');
const beepTimerButton = byId<HTMLButtonElement>('beep-timer');
const beepWarningButton = byId<HTMLButtonElement>('beep-warning');

const engine = new DelayEngine(live, output);
engine.onError = (e) => showError(e.message);

const beepTimer = new BeepTimer();
beepTimer.onBeep = playBeep;

let facing: Facing = 'environment';
let started = false;

type WebkitDocument = Document & {
  webkitFullscreenEnabled?: boolean;
  webkitFullscreenElement?: Element | null;
  webkitExitFullscreen?: () => void;
};
type WebkitElement = HTMLElement & { webkitRequestFullscreen?: () => void };
type WebkitVideo = HTMLVideoElement & { webkitEnterFullscreen?: () => void };

const webkitDocument = document as WebkitDocument;
// iPad, Android, and desktop browsers can fullscreen the whole app, controls included.
const canFullscreenApp = !!(document.fullscreenEnabled || webkitDocument.webkitFullscreenEnabled);
// iPhone Safari can only fullscreen <video>, so stream the delayed canvas into one.
const canFullscreenVideo =
  !canFullscreenApp &&
  typeof (fullscreenVideo as WebkitVideo).webkitEnterFullscreen === 'function' &&
  'captureStream' in HTMLCanvasElement.prototype;
fullscreenButton.hidden = !canFullscreenApp && !canFullscreenVideo;

function isAppFullscreen(): boolean {
  return !!(document.fullscreenElement ?? webkitDocument.webkitFullscreenElement);
}

function startFullscreenVideo(): void {
  if (!canFullscreenVideo) return;
  fullscreenVideo.srcObject ??= output.captureStream(30);
  fullscreenVideo.play().catch(() => {});
}

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
  const hasPreset = [...delayPreset.options].some((o) => o.value === String(clamped));
  delayPreset.value = hasPreset ? String(clamped) : '';
  localStorage.setItem(DELAY_STORAGE_KEY, String(clamped));
  beepTimer.periodMs = clamped * 1000;
  // Changing the delay restarts the cycle so beeps line up with the new delay.
  if (beepTimer.running) beepTimer.start();
}

function setBeepWarning(on: boolean): void {
  beepTimer.warningMs = on ? WARNING_SECONDS * 1000 : 0;
  beepWarningButton.setAttribute('aria-pressed', String(on));
  localStorage.setItem(WARNING_STORAGE_KEY, on ? '1' : '0');
}

let lastTimerText = '';
function updateBeepTimer(): void {
  const remaining = beepTimer.tick();
  timerEl.hidden = remaining === null;
  if (remaining === null) return;
  timerEl.classList.toggle('warning', beepTimer.inWarning(remaining));
  const text = formatSeconds(Math.ceil(remaining / 1000));
  if (text !== lastTimerText) {
    timerEl.textContent = text;
    lastTimerText = text;
  }
}

// setInterval (not requestAnimationFrame) so beeps keep firing while iOS shows the native fullscreen player.
setInterval(updateBeepTimer, 100);

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
  clipButton.disabled = status.waitingMs !== null;
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
  startFullscreenVideo();
  requestAnimationFrame(renderStatus);
  void keepScreenAwake();
});

delayInput.addEventListener('input', () => setDelay(Number(delayInput.value)));
delayPreset.addEventListener('change', () => setDelay(Number(delayPreset.value)));

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
  engine.mirrored = on;
  mirrorButton.setAttribute('aria-pressed', String(on));
});

liveButton.addEventListener('click', () => {
  const hidden = live.classList.toggle('live-hidden');
  liveButton.setAttribute('aria-pressed', String(!hidden));
});

fullscreenButton.addEventListener('click', async () => {
  try {
    if (canFullscreenApp) {
      if (isAppFullscreen()) {
        await (document.exitFullscreen ? document.exitFullscreen() : webkitDocument.webkitExitFullscreen?.());
      } else {
        const el = app as WebkitElement;
        await (el.requestFullscreen ? el.requestFullscreen() : el.webkitRequestFullscreen?.());
      }
    } else {
      (fullscreenVideo as WebkitVideo).webkitEnterFullscreen!();
    }
  } catch {
    showError(
      canFullscreenVideo
        ? 'Fullscreen is available once the delayed video starts playing.'
        : 'Fullscreen is not available right now.',
    );
    setTimeout(clearError, 3000);
  }
});

// Kept synchronous up to saveFile() so iOS still treats the share sheet as a response to the tap.
clipButton.addEventListener('click', () => {
  const clip = engine.getClip();
  if (!clip) return;
  let file: File;
  try {
    file = clipToFile(clip, clipFileName());
  } catch (e) {
    showError(e instanceof Error ? e.message : String(e));
    setTimeout(clearError, 3000);
    return;
  }
  void saveFile(file);
});

beepTimerButton.addEventListener('click', () => {
  if (beepTimer.running) {
    beepTimer.stop();
  } else {
    unlockAudio();
    beepTimer.start();
  }
  beepTimerButton.setAttribute('aria-pressed', String(beepTimer.running));
  updateBeepTimer();
});

beepWarningButton.addEventListener('click', () => {
  setBeepWarning(beepWarningButton.getAttribute('aria-pressed') !== 'true');
});

const syncFullscreenButton = () => fullscreenButton.setAttribute('aria-pressed', String(isAppFullscreen()));
document.addEventListener('fullscreenchange', syncFullscreenButton);
document.addEventListener('webkitfullscreenchange', syncFullscreenButton);
// Leaving iOS's native player can pause the video; resume so it's ready next time.
fullscreenVideo.addEventListener('webkitendfullscreen', () => fullscreenVideo.play().catch(() => {}));

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
  if (fullscreenVideo.srcObject) fullscreenVideo.play().catch(() => {});
  void keepScreenAwake();
});

setDelay(Number(localStorage.getItem(DELAY_STORAGE_KEY)) || 5);
setBeepWarning(localStorage.getItem(WARNING_STORAGE_KEY) === '1');

if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  navigator.serviceWorker
    .register(`${import.meta.env.BASE_URL}sw.js`, { updateViaCache: 'none' })
    .catch(console.error);
}

if (!window.isSecureContext) {
  startButton.disabled = true;
  showError('Camera access requires HTTPS.');
} else if (!isSupported()) {
  startButton.disabled = true;
  showError("This browser can't do delayed video. Try Safari on iOS 16.4+ or Chrome.");
}
