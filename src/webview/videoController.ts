import { b64ToBytes } from "./base64";
import type { VideoFrameDto, VideoFramesDto } from "../shared/dto";

/**
 * WebCodecs video state machine, isolated from Preact so the UI stays thin.
 * Decodes exactly what's needed: a seek reconfigures from the preceding
 * keyframe and draws one frame; playback feeds forward frame-by-frame (each
 * decode+flush yields one output) paced by the messages' own timestamps.
 *
 * WebCodecs types are accessed loosely via globals so the build doesn't depend
 * on lib.dom carrying the (still-evolving) WebCodecs definitions.
 */

export type FetchWindow = (
  anchor: { logTime: string; sequence: number },
  needKeyframe: boolean,
  count: number,
) => Promise<VideoFramesDto>;

export interface VideoControllerCallbacks {
  /** Draw a decoded frame (a CanvasImageSource) to the canvas. */
  onDraw: (frame: unknown) => void;
  onPosition: (index: number, total: number, frame: VideoFrameDto) => void;
  onEnd: () => void;
  onError: (message: string) => void;
}

const PLAY_WINDOW = 60;
const SEEK_WINDOW = 90;

/* eslint-disable @typescript-eslint/no-explicit-any */

export function hasWebCodecs(): boolean {
  return typeof (globalThis as any).VideoDecoder !== "undefined";
}

function microsOf(logTime: string): number {
  return Number(BigInt(logTime) / 1000n);
}

export class VideoController {
  #VD: any = (globalThis as any).VideoDecoder;
  #decoder: any = null;
  #codecString = "";
  #frames: VideoFrameDto[] = [];
  #reachedEnd = true;
  #nextAnchor: { logTime: string; sequence: number } | undefined;

  #contiguousStart = -1; // keyframe index the decoder is currently primed from
  #fedIndex = -1;
  #outputIndex = -1; // index of the next output frame to arrive
  #pendingDraw = -1;

  #cursor = 0;
  #playing = false;
  #playTimer: ReturnType<typeof setTimeout> | undefined;
  #disposed = false;

  constructor(
    private readonly fetch: FetchWindow,
    private readonly cb: VideoControllerCallbacks,
  ) {}

  async isSupported(codecString: string): Promise<boolean> {
    if (!this.#VD) {
      return false;
    }
    try {
      const res = await this.#VD.isConfigSupported({ codec: codecString });
      return Boolean(res?.supported);
    } catch {
      return false;
    }
  }

  get playing(): boolean {
    return this.#playing;
  }

  /**
   * Open at an anchor: fetch a keyframe-aligned window, probe codec support,
   * and (if supported) draw the anchor frame. Returns support so the UI can
   * degrade gracefully on hosts that can't decode this codec (e.g. HEVC on a
   * headless/NVIDIA Linux server).
   */
  async open(
    anchor: { logTime: string; sequence: number },
  ): Promise<{ supported: boolean; codecString: string }> {
    const win = await this.fetch(anchor, true, SEEK_WINDOW);
    this.#codecString = win.codecString;
    this.#frames = win.frames;
    this.#reachedEnd = win.reachedEnd;
    this.#nextAnchor = win.nextAnchor;
    this.#cursor = this.#indexForAnchor(anchor);

    if (!hasWebCodecs() || !(await this.isSupported(this.#codecString))) {
      return { supported: false, codecString: this.#codecString };
    }
    this.#resetDecoder(0);
    await this.#renderIndex(this.#cursor);
    return { supported: true, codecString: this.#codecString };
  }

  /** Raw bytes of the currently positioned frame (for the download fallback). */
  currentFrameBase64(): string | undefined {
    return this.#frames[this.#cursor]?.dataBase64;
  }

  get codecString(): string {
    return this.#codecString;
  }

  /** Time-based scrub: seek to a fraction of [startNs, endNs]. */
  async seekToTime(logTimeNs: string): Promise<void> {
    this.pause();
    const win = await this.fetch({ logTime: logTimeNs, sequence: 0 }, true, SEEK_WINDOW);
    this.#codecString = win.codecString || this.#codecString;
    this.#frames = win.frames;
    this.#reachedEnd = win.reachedEnd;
    this.#nextAnchor = win.nextAnchor;
    this.#resetDecoder(0);
    const wantMicros = microsOf(logTimeNs);
    let target = this.#frames.findIndex((f) => microsOf(f.logTime) >= wantMicros);
    if (target < 0) {
      target = Math.max(0, this.#frames.length - 1);
    }
    await this.#renderIndex(target);
    this.#cursor = target;
  }

  play(): void {
    if (this.#playing) {
      return;
    }
    this.#playing = true;
    this.#scheduleStep(0);
  }

  pause(): void {
    this.#playing = false;
    if (this.#playTimer) {
      clearTimeout(this.#playTimer);
      this.#playTimer = undefined;
    }
  }

  async step(delta: number): Promise<void> {
    this.pause();
    const next = Math.max(0, this.#cursor + delta);
    if (await this.#renderIndex(next)) {
      this.#cursor = next;
    }
  }

  dispose(): void {
    this.#disposed = true;
    this.pause();
    try {
      if (this.#decoder && this.#decoder.state !== "closed") {
        this.#decoder.close();
      }
    } catch {
      /* ignore */
    }
    this.#decoder = null;
  }

  // ---- internals ---------------------------------------------------------

  #scheduleStep(delayMs: number): void {
    this.#playTimer = setTimeout(() => {
      void this.#playStep();
    }, delayMs);
  }

  async #playStep(): Promise<void> {
    if (!this.#playing || this.#disposed) {
      return;
    }
    const next = this.#cursor + 1;
    const ok = await this.#renderIndex(next);
    if (!ok) {
      this.#playing = false;
      this.cb.onEnd();
      return;
    }
    this.#cursor = next;
    if (!this.#playing) {
      return;
    }
    this.#scheduleStep(this.#frameIntervalMs(next));
  }

  #frameIntervalMs(index: number): number {
    if (index <= 0 || index >= this.#frames.length) {
      return 33;
    }
    const dt = (microsOf(this.#frames[index]!.logTime) - microsOf(this.#frames[index - 1]!.logTime)) / 1000;
    return Math.min(1000, Math.max(1, Math.round(dt)));
  }

  #ensureDecoder(): void {
    if (this.#decoder && this.#decoder.state !== "closed") {
      return;
    }
    this.#decoder = new this.#VD({
      output: (frame: any) => this.#onOutput(frame),
      error: (e: any) => this.cb.onError(e?.message ?? String(e)),
    });
  }

  #resetDecoder(contiguousStart: number): void {
    this.#ensureDecoder();
    try {
      this.#decoder.reset();
    } catch {
      /* fresh decoder */
    }
    this.#decoder.configure({ codec: this.#codecString, optimizeForLatency: true });
    this.#contiguousStart = contiguousStart;
    this.#fedIndex = contiguousStart - 1;
    this.#outputIndex = contiguousStart - 1;
  }

  #onOutput(frame: any): void {
    this.#outputIndex += 1;
    try {
      if (this.#outputIndex === this.#pendingDraw) {
        this.cb.onDraw(frame);
      }
    } finally {
      frame.close();
    }
  }

  #lastKeyframeAtOrBefore(index: number): number {
    for (let i = Math.min(index, this.#frames.length - 1); i >= 0; i--) {
      if (this.#frames[i]!.keyframe) {
        return i;
      }
    }
    return 0;
  }

  #indexForAnchor(anchor: { logTime: string; sequence: number }): number {
    const exact = this.#frames.findIndex(
      (f) => f.logTime === anchor.logTime && f.sequence === anchor.sequence,
    );
    if (exact >= 0) {
      return exact;
    }
    const wantMicros = microsOf(anchor.logTime);
    const byTime = this.#frames.findIndex((f) => microsOf(f.logTime) >= wantMicros);
    return byTime >= 0 ? byTime : 0;
  }

  /** Feeds/decodes just enough to draw `index`. Fetches more frames if needed. */
  async #renderIndex(index: number): Promise<boolean> {
    if (this.#VD == null) {
      return false;
    }
    if (!(await this.#ensureFramesUpTo(index)) || this.#disposed) {
      return false;
    }
    if (index < 0 || index >= this.#frames.length) {
      return false;
    }

    const keyStart = this.#lastKeyframeAtOrBefore(index);
    if (!this.#decoder || this.#decoder.state === "closed" || keyStart !== this.#contiguousStart || index <= this.#fedIndex) {
      this.#resetDecoder(keyStart);
    }

    this.#pendingDraw = index;
    for (let k = this.#fedIndex + 1; k <= index; k++) {
      const f = this.#frames[k]!;
      const Chunk = (globalThis as any).EncodedVideoChunk;
      this.#decoder.decode(
        new Chunk({
          type: f.keyframe ? "key" : "delta",
          timestamp: microsOf(f.logTime),
          data: b64ToBytes(f.dataBase64),
        }),
      );
    }
    this.#fedIndex = index;
    try {
      await this.#decoder.flush();
    } catch (e) {
      this.cb.onError(e instanceof Error ? e.message : String(e));
      return false;
    }
    this.cb.onPosition(index, this.#frames.length, this.#frames[index]!);
    return true;
  }

  /** Extends the loaded window forward (playback continuation) when possible. */
  async #ensureFramesUpTo(index: number): Promise<boolean> {
    while (index >= this.#frames.length) {
      if (this.#reachedEnd || !this.#nextAnchor) {
        return index < this.#frames.length;
      }
      const win = await this.fetch(this.#nextAnchor, false, PLAY_WINDOW);
      if (win.frames.length === 0) {
        this.#reachedEnd = true;
        return index < this.#frames.length;
      }
      this.#frames = this.#frames.concat(win.frames);
      this.#reachedEnd = win.reachedEnd;
      this.#nextAnchor = win.nextAnchor;
    }
    return true;
  }
}
/* eslint-enable @typescript-eslint/no-explicit-any */
