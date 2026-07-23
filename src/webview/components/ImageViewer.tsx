import { useEffect, useRef, useState } from "preact/hooks";

import { b64ToBytes, imageMime } from "../base64";
import type { ChannelDto, ImageFrameDto } from "../../shared/dto";
import { formatBytes, formatTimestamp } from "../../shared/time";
import type { RpcClient } from "../rpcClient";
import { RpcError } from "../rpcClient";

/** Frames to request per playback window (server also caps by total bytes). */
const PLAY_WINDOW = 32;
/** Target ms between frames while playing (decode latency may dominate). */
const PLAY_MS = 40;

/** Fetches and renders one image message; prev/next walk the channel lazily. */
export function ImageViewer({
  channel,
  rpc,
  anchor,
}: {
  channel: ChannelDto;
  rpc: RpcClient;
  anchor?: { logTime: string; sequence: number };
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [frame, setFrame] = useState<ImageFrameDto | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  // Lazily-built {logTime, sequence} index for prev/next navigation.
  const indexRef = useRef<Array<{ logTime: string; sequence: number }> | undefined>(undefined);
  const [pos, setPos] = useState<number | undefined>(undefined);
  const [playing, setPlaying] = useState(false);
  const playingRef = useRef(false);

  const load = async (target: { logTime: string; sequence: number }) => {
    setLoading(true);
    setError(undefined);
    try {
      const body = await rpc.request({ op: "getImageFrame", channelId: channel.id, target });
      if (body.type === "imageFrame") {
        setFrame(body.data);
      }
    } catch (e) {
      setError(e instanceof RpcError ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  // Load the anchored image (or the channel's first message). Re-runs when the
  // selected message changes so the embedded preview follows row selection;
  // harmless for the full-screen viewer where the anchor is fixed.
  useEffect(() => {
    setPlaying(false); // a new selection or channel stops playback
    void load(anchor ?? { logTime: "0", sequence: 0 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channel.id, anchor?.logTime, anchor?.sequence]);

  // Lazily fetch a navigation index the first time it's needed.
  const ensureIndex = async (): Promise<Array<{ logTime: string; sequence: number }>> => {
    if (indexRef.current) {
      return indexRef.current;
    }
    const body = await rpc.request({
      op: "queryMessages",
      topics: [channel.topic],
      limitCount: 2000,
      limitBytes: 4_000_000,
    });
    const list =
      body.type === "messages"
        ? body.page.messages.map((m) => ({ logTime: m.logTime, sequence: m.sequence }))
        : [];
    indexRef.current = list;
    return list;
  };

  const step = async (delta: number) => {
    const list = await ensureIndex();
    if (list.length === 0) {
      return;
    }
    let current = pos;
    if (current === undefined) {
      const a = anchor;
      current = a
        ? Math.max(0, list.findIndex((m) => m.logTime === a.logTime && m.sequence === a.sequence))
        : 0;
    }
    const next = Math.min(list.length - 1, Math.max(0, current + delta));
    setPos(next);
    await load(list[next]!);
  };

  // Playback: fetch frames a window at a time (one RPC round-trip per window)
  // and display them from memory, prefetching the next window before the
  // current runs out. This replaces the per-frame round-trip that made naive
  // stepping slow and jittery. Stops at the end.
  useEffect(() => {
    playingRef.current = playing;
    if (!playing) {
      return;
    }
    let cancelled = false;

    const fetchWindow = async (a: { logTime: string; sequence: number }) => {
      const body = await rpc.request({
        op: "getImageWindow",
        channelId: channel.id,
        anchor: a,
        count: PLAY_WINDOW,
      });
      return body.type === "imageFrames"
        ? body.data
        : { frames: [], reachedEnd: true, nextAnchor: undefined };
    };

    void (async () => {
      const list = await ensureIndex();
      if (cancelled || list.length === 0) {
        setPlaying(false);
        return;
      }
      let cur =
        pos ??
        (anchor
          ? Math.max(
              0,
              list.findIndex((m) => m.logTime === anchor.logTime && m.sequence === anchor.sequence),
            )
          : 0);
      if (cur >= list.length - 1) {
        cur = 0; // restart from the beginning when starting at the end
      }
      let win = await fetchWindow(list[cur]!);
      let prefetch: ReturnType<typeof fetchWindow> | null = null;
      while (!cancelled && playingRef.current && win.frames.length > 0) {
        for (let i = 0; i < win.frames.length; i++) {
          if (cancelled || !playingRef.current) {
            return;
          }
          setFrame(win.frames[i]);
          setPos(cur);
          cur += 1;
          // Prefetch the next window a few frames early so playback never stalls.
          if (i === win.frames.length - 4 && !win.reachedEnd && win.nextAnchor && !prefetch) {
            prefetch = fetchWindow(win.nextAnchor);
          }
          await new Promise((r) => setTimeout(r, PLAY_MS));
        }
        if (win.reachedEnd || !win.nextAnchor) {
          break;
        }
        win = await (prefetch ?? fetchWindow(win.nextAnchor));
        prefetch = null;
      }
      if (!cancelled) {
        setPlaying(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing]);

  // Draw whenever the frame changes.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !frame) {
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const bytes = b64ToBytes(frame.dataBase64);
        if (frame.kind === "compressed") {
          const bitmap = await createImageBitmap(
            new Blob([bytes.buffer as ArrayBuffer], { type: imageMime(frame.format) }),
          );
          if (cancelled) {
            bitmap.close();
            return;
          }
          canvas.width = bitmap.width;
          canvas.height = bitmap.height;
          canvas.getContext("2d")?.drawImage(bitmap, 0, 0);
          bitmap.close();
        } else {
          const imageData = rawToRGBA(bytes, frame);
          if (!imageData) {
            setError(`Unsupported raw encoding "${frame.format}".`);
            return;
          }
          canvas.width = imageData.width;
          canvas.height = imageData.height;
          canvas.getContext("2d")?.putImageData(imageData, 0, 0);
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [frame]);

  return (
    <div class="preview-body">
      <div class="preview-controls">
        <button
          onClick={() => {
            setPlaying(false);
            void step(-1);
          }}
          disabled={loading && !playing}
        >
          ◀ Prev
        </button>
        <button onClick={() => setPlaying((p) => !p)} title={playing ? "Pause" : "Play"}>
          {playing ? "⏸ Pause" : "▶ Play"}
        </button>
        <button
          onClick={() => {
            setPlaying(false);
            void step(1);
          }}
          disabled={loading && !playing}
        >
          Next ▶
        </button>
        {frame && (
          <span class="dim mono preview-meta">
            #{frame.sequence} · {frame.format}
            {frame.width && frame.height ? ` · ${frame.width}×${frame.height}` : ""} ·{" "}
            {formatBytes(b64Len(frame.dataBase64))} · {formatTimestamp(frame.logTime)}
          </span>
        )}
      </div>
      {error && <div class="error-inline">{error}</div>}
      {loading && !error && !playing && <div class="dim">Loading image…</div>}
      <div class="preview-canvas-wrap">
        <canvas ref={canvasRef} class="preview-canvas" />
      </div>
    </div>
  );
}

/** Approximate decoded byte length of a base64 string. */
function b64Len(b64: string): number {
  const padding = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
  return Math.floor((b64.length * 3) / 4) - padding;
}

function bytesPerPixel(format: string): number {
  if (format.startsWith("mono")) {
    return 1;
  }
  return format.includes("a") ? 4 : 3;
}

/** Convert a RawImage payload to canvas-ready RGBA, honoring row stride. */
function rawToRGBA(bytes: Uint8Array, frame: ImageFrameDto): ImageData | null {
  const w = frame.width ?? 0;
  const h = frame.height ?? 0;
  const fmt = frame.format.trim().toLowerCase();
  if (w <= 0 || h <= 0) {
    return null;
  }
  const srcStride = frame.step && frame.step > 0 ? frame.step : bytesPerPixel(fmt) * w;
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const di = (y * w + x) * 4;
      if (fmt === "mono8") {
        const v = bytes[y * srcStride + x] ?? 0;
        out[di] = v;
        out[di + 1] = v;
        out[di + 2] = v;
        out[di + 3] = 255;
      } else if (fmt === "rgb8") {
        const si = y * srcStride + x * 3;
        out[di] = bytes[si] ?? 0;
        out[di + 1] = bytes[si + 1] ?? 0;
        out[di + 2] = bytes[si + 2] ?? 0;
        out[di + 3] = 255;
      } else if (fmt === "bgr8") {
        const si = y * srcStride + x * 3;
        out[di] = bytes[si + 2] ?? 0;
        out[di + 1] = bytes[si + 1] ?? 0;
        out[di + 2] = bytes[si] ?? 0;
        out[di + 3] = 255;
      } else if (fmt === "rgba8") {
        const si = y * srcStride + x * 4;
        out[di] = bytes[si] ?? 0;
        out[di + 1] = bytes[si + 1] ?? 0;
        out[di + 2] = bytes[si + 2] ?? 0;
        out[di + 3] = bytes[si + 3] ?? 255;
      } else if (fmt === "bgra8") {
        const si = y * srcStride + x * 4;
        out[di] = bytes[si + 2] ?? 0;
        out[di + 1] = bytes[si + 1] ?? 0;
        out[di + 2] = bytes[si] ?? 0;
        out[di + 3] = bytes[si + 3] ?? 255;
      } else {
        return null;
      }
    }
  }
  return new ImageData(out, w, h);
}
