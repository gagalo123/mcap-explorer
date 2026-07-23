import { useEffect, useRef, useState } from "preact/hooks";

import { b64ToBytes } from "../base64";
import { hasWebCodecs, VideoController } from "../videoController";
import type { ChannelDto, TimeRangeDto, VideoFrameDto, VideoFramesDto } from "../../shared/dto";
import { fromTimeNs, formatTimestamp, toTimeNs } from "../../shared/time";
import type { RpcClient } from "../rpcClient";
import { RpcError } from "../rpcClient";

type Status = "loading" | "ready" | "unsupported" | "no-webcodecs" | "error";

export function VideoPlayer({
  channel,
  rpc,
  anchor,
  timeRange,
}: {
  channel: ChannelDto;
  rpc: RpcClient;
  anchor?: { logTime: string; sequence: number };
  timeRange?: TimeRangeDto;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const controllerRef = useRef<VideoController | null>(null);
  const [status, setStatus] = useState<Status>("loading");
  const [error, setError] = useState<string | undefined>(undefined);
  const [codecString, setCodecString] = useState<string>("");
  const [playing, setPlaying] = useState(false);
  const [posLabel, setPosLabel] = useState<string>("");
  const [scrub, setScrub] = useState(0);

  useEffect(() => {
    const fetchWindow = async (
      a: { logTime: string; sequence: number },
      needKeyframe: boolean,
      count: number,
    ): Promise<VideoFramesDto> => {
      const body = await rpc.request({
        op: "getFrameWindow",
        channelId: channel.id,
        anchor: a,
        count,
        needKeyframe,
      });
      if (body.type !== "videoFrames") {
        throw new Error("unexpected response");
      }
      return body.data;
    };

    const controller = new VideoController(fetchWindow, {
      onDraw: (frame) => drawFrame(canvasRef.current, frame),
      onPosition: (_index, _total, frame: VideoFrameDto) => {
        setPosLabel(`#${frame.sequence} · ${formatTimestamp(frame.logTime)}`);
        if (timeRange) {
          setScrub(fractionOf(frame.logTime, timeRange));
        }
      },
      onEnd: () => setPlaying(false),
      onError: (message) => {
        setError(message);
        setStatus("error");
      },
    });
    controllerRef.current = controller;

    void (async () => {
      try {
        const { supported, codecString: cs } = await controller.open(
          anchor ?? { logTime: "0", sequence: 0 },
        );
        setCodecString(cs);
        if (!hasWebCodecs()) {
          setStatus("no-webcodecs");
        } else {
          setStatus(supported ? "ready" : "unsupported");
        }
      } catch (e) {
        setError(e instanceof RpcError ? e.message : e instanceof Error ? e.message : String(e));
        setStatus("error");
      }
    })();

    return () => controller.dispose();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channel.id]);

  const togglePlay = () => {
    const c = controllerRef.current;
    if (!c) {
      return;
    }
    if (c.playing) {
      c.pause();
      setPlaying(false);
    } else {
      c.play();
      setPlaying(true);
    }
  };

  const onScrub = (e: Event) => {
    const c = controllerRef.current;
    if (!c || !timeRange) {
      return;
    }
    const fraction = Number((e.currentTarget as HTMLInputElement).value) / 1000;
    setScrub(fraction);
    const start = fromTimeNs(timeRange.start);
    const end = fromTimeNs(timeRange.end);
    const t = start + BigInt(Math.round(Number(end - start) * fraction));
    void c.seekToTime(toTimeNs(t)).catch((err) => setError(String(err)));
    setPlaying(false);
  };

  const downloadFrame = () => {
    const c = controllerRef.current;
    const b64 = c?.currentFrameBase64();
    if (!b64) {
      return;
    }
    const blob = new Blob([b64ToBytes(b64).buffer as ArrayBuffer], {
      type: "application/octet-stream",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `frame.${(channel.messageEncoding && codecString.split(".")[0]) || "bin"}`;
    a.click();
    URL.revokeObjectURL(url);
  };

  if (status === "unsupported" || status === "no-webcodecs") {
    return (
      <div class="preview-body">
        <div class="preview-degraded">
          <p>
            {status === "no-webcodecs"
              ? "This host has no WebCodecs API, so video can't be decoded here."
              : `This host can't decode ${codecString || "this codec"}.`}
          </p>
          <p class="dim">
            H.265/HEVC decoding needs hardware support — it works on macOS, Windows, or Linux
            with an Intel VAAPI GPU, but not on headless or NVIDIA-only Linux. A WASM software
            decoder for these hosts is planned (Phase 3.5).
          </p>
          <button onClick={downloadFrame}>Download this frame's bitstream</button>
        </div>
      </div>
    );
  }

  return (
    <div class="preview-body">
      <div class="preview-controls">
        <button onClick={togglePlay} disabled={status !== "ready"}>
          {playing ? "⏸ Pause" : "▶ Play"}
        </button>
        <button onClick={() => void controllerRef.current?.step(-1)} disabled={status !== "ready" || playing}>
          ◀ Step
        </button>
        <button onClick={() => void controllerRef.current?.step(1)} disabled={status !== "ready" || playing}>
          Step ▶
        </button>
        {timeRange && (
          <input
            type="range"
            class="preview-scrub"
            min={0}
            max={1000}
            value={Math.round(scrub * 1000)}
            onInput={onScrub}
            disabled={status !== "ready"}
          />
        )}
        <span class="dim mono preview-meta">
          {status === "loading" ? "Decoding…" : posLabel}
          {codecString ? ` · ${codecString}` : ""}
        </span>
      </div>
      {error && <div class="error-inline">{error}</div>}
      <div class="preview-canvas-wrap">
        <canvas ref={canvasRef} class="preview-canvas" />
      </div>
    </div>
  );
}

function fractionOf(logTime: string, range: TimeRangeDto): number {
  const start = Number(fromTimeNs(range.start));
  const end = Number(fromTimeNs(range.end));
  if (end <= start) {
    return 0;
  }
  return Math.min(1, Math.max(0, (Number(fromTimeNs(logTime)) - start) / (end - start)));
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function drawFrame(canvas: HTMLCanvasElement | null, frame: any): void {
  if (!canvas) {
    return;
  }
  const w = frame.displayWidth ?? frame.codedWidth ?? canvas.width;
  const h = frame.displayHeight ?? frame.codedHeight ?? canvas.height;
  if (w && h && (canvas.width !== w || canvas.height !== h)) {
    canvas.width = w;
    canvas.height = h;
  }
  canvas.getContext("2d")?.drawImage(frame, 0, 0);
}
