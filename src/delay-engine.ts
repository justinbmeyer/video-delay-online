export const MAX_DELAY_MS = 120_000;
const RETAIN_MARGIN_MS = 5_000;
const KEYFRAME_INTERVAL_MS = 2_000;
const MAX_ENCODE_QUEUE = 2;
const FALLBACK_INTERVAL_MS = 1000 / 30;
const STALL_MS = 150;
// Ordered by preference; H.264 is hardware-encoded on iPhones.
const CODECS = ['avc1.42E01F', 'avc1.4D401F', 'avc1.42E028', 'avc1.640028', 'vp8', 'vp09.00.10.08'];

type CaptureContext = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
type OrientedVideoFrame = VideoFrame & { rotation?: number; flip?: boolean };
// Browsers exposing VideoFrame.rotation report camera orientation, so frames with none can be encoded directly.
const ORIENTATION_AWARE = typeof VideoFrame === 'function' && 'rotation' in VideoFrame.prototype;

interface BufferedChunk {
  chunk: EncodedVideoChunk;
  // Set on key frames only.
  config: VideoDecoderConfig | null;
}

export interface DelayStatus {
  width: number;
  height: number;
  bufferedSeconds: number;
  bufferedBytes: number;
  /** Time until delayed playback begins, or null when playing. */
  waitingMs: number | null;
}

/**
 * Encodes camera frames into a rolling buffer of compressed chunks and
 * decodes them back onto a canvas `delayMs` later.
 */
export class DelayEngine {
  onError: (error: Error) => void = () => {};
  /** Draws frames flipped horizontally. Done in the canvas (not CSS) so captureStream() output is mirrored too. */
  mirrored = false;

  private _delayMs = 5_000;
  private running = false;
  private fallbackTimer = 0;
  private lastVideoFrameAt = 0;
  private lastTickAt = 0;
  private readonly ctx: CanvasRenderingContext2D;
  private captureCtx: CaptureContext | null = null;

  private buffer: BufferedChunk[] = [];
  private bufferedBytes = 0;
  /** Index of the next chunk to hand to the decoder. */
  private next = 0;
  private lastFedTs: number | null = null;

  private encoder: VideoEncoder | null = null;
  private encoderConfig: VideoEncoderConfig | null = null;
  private configuring = false;
  private latestDecoderConfig: VideoDecoderConfig | null = null;
  private forceKeyFrame = true;
  private lastKeyFrameAt = 0;

  private decoder: VideoDecoder | null = null;
  private activeDecoderConfig: VideoDecoderConfig | null = null;
  private needsSeek = false;

  constructor(
    private readonly video: HTMLVideoElement,
    private readonly canvas: HTMLCanvasElement,
  ) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D is not available');
    this.ctx = ctx;
  }

  get delayMs(): number {
    return this._delayMs;
  }

  set delayMs(ms: number) {
    this._delayMs = Math.min(MAX_DELAY_MS, Math.max(0, ms));
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.video.requestVideoFrameCallback(this.onVideoFrame);
    requestAnimationFrame(this.tick);
    this.fallbackTimer = window.setInterval(this.fallbackTick, FALLBACK_INTERVAL_MS);
  }

  stop(): void {
    this.running = false;
    clearInterval(this.fallbackTimer);
    if (this.encoder?.state !== 'closed') this.encoder?.close();
    if (this.decoder?.state !== 'closed') this.decoder?.close();
    this.encoder = this.decoder = null;
  }

  getStatus(): DelayStatus {
    const first = this.buffer[0]?.chunk.timestamp ?? 0;
    const last = this.buffer.at(-1)?.chunk.timestamp ?? 0;
    let waitingMs: number | null = null;
    if (this.lastFedTs === null) {
      const upcoming = this.buffer[this.next]?.chunk.timestamp;
      waitingMs =
        upcoming === undefined ? this._delayMs : Math.max(0, upcoming / 1000 + this._delayMs - performance.now());
    }
    return {
      width: this.encoderConfig?.width ?? 0,
      height: this.encoderConfig?.height ?? 0,
      bufferedSeconds: (last - first) / 1e6,
      bufferedBytes: this.bufferedBytes,
      waitingMs,
    };
  }

  // ---- Capture + encode ----

  private onVideoFrame = (): void => {
    if (!this.running) return;
    this.video.requestVideoFrameCallback(this.onVideoFrame);
    this.lastVideoFrameAt = performance.now();
    this.capture();
  };

  /**
   * requestVideoFrameCallback and requestAnimationFrame can stop firing while iOS
   * shows a <video> in its native fullscreen player, so keep capturing and
   * playing back on a timer whenever they stall.
   */
  private fallbackTick = (): void => {
    if (!this.running) return;
    const now = performance.now();
    if (now - this.lastVideoFrameAt > STALL_MS) this.capture();
    if (now - this.lastTickAt > STALL_MS) this.step();
  };

  private capture(): void {
    const { videoWidth: width, videoHeight: height } = this.video;
    if (!width || !height) return;

    const encoder = this.encoder;
    if (
      !encoder ||
      encoder.state !== 'configured' ||
      this.encoderConfig?.width !== width ||
      this.encoderConfig.height !== height
    ) {
      if (!this.configuring) void this.configureEncoder(width, height);
      return;
    }
    if (encoder.encodeQueueSize > MAX_ENCODE_QUEUE) return;

    const now = performance.now();
    const frame = this.grabUprightFrame(width, height, Math.round(now * 1000));
    if (!frame) return;
    const keyFrame = this.forceKeyFrame || now - this.lastKeyFrameAt >= KEYFRAME_INTERVAL_MS;
    if (keyFrame) {
      this.forceKeyFrame = false;
      this.lastKeyFrameAt = now;
    }
    try {
      encoder.encode(frame, { keyFrame });
    } catch (e) {
      this.reportError(e);
    } finally {
      frame.close();
    }
  }

  /**
   * Camera frames can carry rotation as metadata (e.g. iOS in landscape) that
   * VideoEncoder ignores, which shows up as a rotated/upside-down delayed image.
   * drawImage() applies that rotation, so route frames through a canvas unless
   * the browser reports the frame is already upright.
   */
  private grabUprightFrame(width: number, height: number, timestamp: number): VideoFrame | null {
    if (ORIENTATION_AWARE) {
      const frame = new VideoFrame(this.video, { timestamp }) as OrientedVideoFrame;
      if (!frame.rotation && !frame.flip) return frame;
      frame.close();
    }

    if (!this.captureCtx) {
      const canvas = typeof OffscreenCanvas === 'function' ? new OffscreenCanvas(width, height) : document.createElement('canvas');
      this.captureCtx = canvas.getContext('2d', { alpha: false }) as CaptureContext | null;
      if (!this.captureCtx) {
        this.reportError(new Error('Canvas 2D is not available'));
        return null;
      }
    }
    const { canvas } = this.captureCtx;
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    this.captureCtx.drawImage(this.video, 0, 0, width, height);
    return new VideoFrame(canvas, { timestamp });
  }

  private async configureEncoder(width: number, height: number): Promise<void> {
    this.configuring = true;
    try {
      const config = await pickEncoderConfig(width, height);
      if (!this.encoder || this.encoder.state === 'closed') {
        this.encoder = new VideoEncoder({ output: this.onEncoded, error: (e) => this.reportError(e) });
      }
      this.encoder.configure(config);
      this.encoderConfig = config;
      this.latestDecoderConfig = { codec: config.codec, codedWidth: width, codedHeight: height };
      this.forceKeyFrame = true;
    } catch (e) {
      this.reportError(e);
      this.stop();
    } finally {
      this.configuring = false;
    }
  }

  private onEncoded = (chunk: EncodedVideoChunk, meta?: EncodedVideoChunkMetadata): void => {
    const config = meta?.decoderConfig;
    if (config && !(this.latestDecoderConfig && sameDecoderConfig(config, this.latestDecoderConfig))) {
      this.latestDecoderConfig = config;
    }
    this.buffer.push({ chunk, config: chunk.type === 'key' ? this.latestDecoderConfig : null });
    this.bufferedBytes += chunk.byteLength;
  };

  // ---- Delayed decode + draw ----

  private tick = (): void => {
    if (!this.running) return;
    requestAnimationFrame(this.tick);
    this.lastTickAt = performance.now();
    this.step();
  };

  private step(): void {
    const now = performance.now();
    const targetUs = (now - this._delayMs) * 1000;

    // Delay grew (target moved into the past) or decoder failed: restart from an earlier key frame.
    if (this.needsSeek || (this.lastFedTs !== null && targetUs < this.lastFedTs)) this.seek(targetUs);

    let end = this.next;
    while (end < this.buffer.length && this.buffer[end].chunk.timestamp <= targetUs) end++;

    // If behind (delay shrank or slow device), skip ahead to the newest due key frame.
    for (let i = end - 1; i > this.next; i--) {
      if (this.buffer[i].chunk.type === 'key') {
        this.next = i;
        break;
      }
    }
    for (; this.next < end; this.next++) this.feed(this.buffer[this.next]);

    this.evict(now);
  }

  private seek(targetUs: number): void {
    this.needsSeek = false;
    if (this.decoder?.state === 'configured') this.decoder.reset();
    this.activeDecoderConfig = null;
    this.lastFedTs = null;

    let lastKeyBefore = -1;
    let firstKey = -1;
    for (let i = 0; i < this.buffer.length; i++) {
      const { chunk } = this.buffer[i];
      if (chunk.type !== 'key') continue;
      if (firstKey === -1) firstKey = i;
      if (chunk.timestamp > targetUs) break;
      lastKeyBefore = i;
    }
    this.next = lastKeyBefore !== -1 ? lastKeyBefore : firstKey !== -1 ? firstKey : this.buffer.length;
  }

  private feed({ chunk, config }: BufferedChunk): void {
    try {
      if (chunk.type === 'key' && config) {
        const decoder = this.getDecoder();
        if (config !== this.activeDecoderConfig) {
          decoder.configure(config);
          this.activeDecoderConfig = config;
        }
      }
      // Delta frames are useless until the decoder has seen a key frame.
      if (!this.activeDecoderConfig || !this.decoder) return;
      this.decoder.decode(chunk);
      this.lastFedTs = chunk.timestamp;
    } catch (e) {
      this.reportError(e);
      this.needsSeek = true;
    }
  }

  private getDecoder(): VideoDecoder {
    if (!this.decoder || this.decoder.state === 'closed') {
      this.decoder = new VideoDecoder({
        output: this.draw,
        error: (e) => {
          this.reportError(e);
          this.needsSeek = true;
        },
      });
      this.activeDecoderConfig = null;
    }
    return this.decoder;
  }

  private draw = (frame: VideoFrame): void => {
    const { displayWidth: w, displayHeight: h } = frame;
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    if (this.mirrored) this.ctx.setTransform(-1, 0, 0, 1, w, 0);
    this.ctx.drawImage(frame, 0, 0, w, h);
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    frame.close();
  };

  private evict(now: number): void {
    const cutoffUs = (now - MAX_DELAY_MS - RETAIN_MARGIN_MS) * 1000;
    let n = 0;
    while (n < this.next && this.buffer[n].chunk.timestamp < cutoffUs) {
      this.bufferedBytes -= this.buffer[n].chunk.byteLength;
      n++;
    }
    if (n) {
      this.buffer.splice(0, n);
      this.next -= n;
    }
  }

  private reportError(e: unknown): void {
    console.error(e);
    this.onError(e instanceof Error ? e : new Error(String(e)));
  }
}

async function pickEncoderConfig(width: number, height: number): Promise<VideoEncoderConfig> {
  const bitrate = Math.round(Math.min(4_000_000, Math.max(1_000_000, width * height * 30 * 0.08)));
  for (const codec of CODECS) {
    const config: VideoEncoderConfig = { codec, width, height, bitrate, framerate: 30, latencyMode: 'realtime' };
    try {
      if ((await VideoEncoder.isConfigSupported(config)).supported) return config;
    } catch {
      // Some browsers throw instead of returning supported: false.
    }
  }
  throw new Error(`This browser can't encode ${width}×${height} video.`);
}

function sameDecoderConfig(a: VideoDecoderConfig, b: VideoDecoderConfig): boolean {
  return (
    a.codec === b.codec &&
    a.codedWidth === b.codedWidth &&
    a.codedHeight === b.codedHeight &&
    sameBytes(a.description, b.description)
  );
}

function sameBytes(a?: AllowSharedBufferSource, b?: AllowSharedBufferSource): boolean {
  if (!a || !b) return a === b;
  const x = toBytes(a);
  const y = toBytes(b);
  return x.length === y.length && x.every((v, i) => v === y[i]);
}

function toBytes(source: AllowSharedBufferSource): Uint8Array {
  return ArrayBuffer.isView(source)
    ? new Uint8Array(source.buffer, source.byteOffset, source.byteLength)
    : new Uint8Array(source);
}
