// The scanner's engine (docs/scan-plan.md → S9): the camera — the back camera at up to 1920×1080 and 30
// frames a second (owner, 2026-10-24: thirty and no faster choice; the lab asked the same), shown in the
// screen's video. Ported from the lab's index.html (startCam, stop).

/** What the camera is asked for: the back camera, 1920×1080 and 30 frames a second when it can. */
export const CAMERA_CONSTRAINTS: MediaStreamConstraints = {
  video: { facingMode: 'environment', width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } },
  audio: false,
};

/** The screen's video as the engine sees it (an HTMLVideoElement; the tests give a fake). */
export interface VideoLike {
  srcObject: MediaProvider | null;
  play(): Promise<void>;
  readonly videoWidth: number;
  readonly videoHeight: number;
  readonly readyState: number;
  requestVideoFrameCallback?(fn: () => void): number;
}

/** A camera stream as the engine sees it (a MediaStream). */
export interface StreamLike { getTracks(): { stop(): void }[] }

export type GetUserMedia = (c: MediaStreamConstraints) => Promise<StreamLike>;

const browserGetUserMedia: GetUserMedia = c => navigator.mediaDevices.getUserMedia(c);

export class Camera {
  stream: StreamLike | null = null;
  video: VideoLike | null = null;

  constructor(private readonly getUserMedia: GetUserMedia = browserGetUserMedia) {}

  /** The camera started (once; asked again only after stop()) and shown in video, playing. */
  async start(video: VideoLike): Promise<void> {
    if (!this.stream) this.stream = await this.getUserMedia(CAMERA_CONSTRAINTS);
    this.video = video;
    video.srcObject = this.stream as unknown as MediaProvider;
    await video.play();
  }

  /** The camera stopped: its tracks end, the video shows nothing. */
  stop(): void {
    if (this.stream) { this.stream.getTracks().forEach(t => t.stop()); this.stream = null; }
    if (this.video) this.video.srcObject = null;
  }

  get on(): boolean { return !!this.stream; }

  /** The camera's picture size, "1920×1080" (the lab's figure), or '' before it plays. */
  resolution(): string {
    const v = this.video;
    return v && v.videoWidth ? v.videoWidth + '×' + v.videoHeight : '';
  }
}
