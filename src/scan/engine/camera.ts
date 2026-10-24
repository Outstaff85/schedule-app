// The scanner's engine (docs/scan-plan.md → S9): the camera — the back camera at up to 1920×1080 and 30
// frames a second (owner, 2026-10-24: thirty and no faster choice; the lab asked the same), shown in the
// screen's video. Ported from the lab's former plain page (startCam, stop).

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
  /** Bumped by stop(): a start still waiting for the camera finds it changed and gives its stream back. */
  private gen = 0;
  /** The camera asked for and not answered yet: starts at the same time share it (one stream). */
  private starting: Promise<StreamLike> | null = null;

  constructor(private readonly getUserMedia: GetUserMedia = browserGetUserMedia) {}

  /** The camera started (once; asked again only after stop()) and shown in video, playing. False when stop()
   *  ran while it started: then nothing stays on (a stream that came after the stop has its tracks stopped). */
  async start(video: VideoLike): Promise<boolean> {
    const gen = this.gen;
    if (!this.stream) {
      let p = this.starting;
      if (!p) {
        const asked: Promise<StreamLike> = this.getUserMedia(CAMERA_CONSTRAINTS).then(s => {
          if (this.starting === asked) this.starting = null;
          if (gen !== this.gen) { s.getTracks().forEach(t => t.stop()); return s; }
          this.stream = s;
          return s;
        }, e => { if (this.starting === asked) this.starting = null; throw e; });
        p = this.starting = asked;
      }
      await p;
    }
    if (gen !== this.gen || !this.stream) return false;
    this.video = video;
    video.srcObject = this.stream as unknown as MediaProvider;
    try { await video.play(); }
    catch (e) {
      if (gen !== this.gen) return false;  // stopped while it began to play
      this.stop();  // it cannot play: the camera is not left on
      throw e;
    }
    return gen === this.gen;
  }

  /** The camera stopped: its tracks end, the video shows nothing; a start still waiting gives its stream back. */
  stop(): void {
    this.gen++;
    this.starting = null;
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
