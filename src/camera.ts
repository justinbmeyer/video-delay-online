export type Facing = 'user' | 'environment';

export async function openCamera(video: HTMLVideoElement, facing: Facing): Promise<void> {
  // iOS can refuse a second camera while the first is still open, so release it first.
  (video.srcObject as MediaStream | null)?.getTracks().forEach((t) => t.stop());
  video.srcObject = null;

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      facingMode: { ideal: facing },
      width: { ideal: 1280 },
      height: { ideal: 720 },
      frameRate: { ideal: 30, max: 30 },
    },
  });
  video.srcObject = stream;
  await video.play();
}

export function cameraIsLive(video: HTMLVideoElement): boolean {
  const track = (video.srcObject as MediaStream | null)?.getVideoTracks()[0];
  return !!track && track.readyState === 'live';
}
