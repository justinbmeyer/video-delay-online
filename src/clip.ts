import { ArrayBufferTarget, Muxer } from 'mp4-muxer';
import type { Clip } from './delay-engine';

const FRAME_US = Math.round(1e6 / 30);

type MuxerCodec = 'avc' | 'hevc' | 'vp9' | 'av1';

function muxerCodec(codec: string): MuxerCodec | null {
  if (codec.startsWith('avc1') || codec.startsWith('avc3')) return 'avc';
  if (codec.startsWith('hvc1') || codec.startsWith('hev1')) return 'hevc';
  if (codec.startsWith('vp09')) return 'vp9';
  if (codec.startsWith('av01')) return 'av1';
  return null;
}

/** Packs already-encoded chunks into an MP4 without re-encoding. Synchronous so it can run inside a tap handler. */
export function clipToFile(clip: Clip, name: string): File {
  const codec = muxerCodec(clip.config.codec);
  if (!codec) throw new Error("Clips aren't supported with this browser's video codec.");

  const muxer = new Muxer({
    target: new ArrayBufferTarget(),
    video: { codec, width: clip.width, height: clip.height },
    fastStart: 'in-memory',
  });
  const { chunks } = clip;
  const t0 = chunks[0].timestamp;
  chunks.forEach((chunk, i) => {
    const data = new Uint8Array(chunk.byteLength);
    chunk.copyTo(data);
    const next = chunks[i + 1]?.timestamp;
    const duration = next === undefined ? FRAME_US : next - chunk.timestamp;
    const meta = i === 0 ? { decoderConfig: clip.config } : undefined;
    muxer.addVideoChunkRaw(data, chunk.type, chunk.timestamp - t0, duration, meta);
  });
  muxer.finalize();
  return new File([muxer.target.buffer], name, { type: 'video/mp4' });
}

/**
 * On phones, opens the share sheet (which offers "Save Video" to Photos on iOS); elsewhere, downloads the file.
 * Must be called synchronously from a tap: iOS rejects share() once the user gesture has lapsed.
 */
export async function saveFile(file: File): Promise<void> {
  const isTouch = matchMedia('(pointer: coarse)').matches;
  if (isTouch && navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file] });
      return;
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') return;
    }
  }
  download(file);
}

function download(file: File): void {
  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = url;
  a.download = file.name;
  document.body.append(a);
  a.click();
  a.remove();
  // iOS reads the blob after showing its download prompt, so don't revoke right away.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export function clipFileName(date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  const time = `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
  return `video-delay-${day}-${time}.mp4`;
}
