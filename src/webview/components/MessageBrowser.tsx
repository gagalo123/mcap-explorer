import { useEffect, useMemo, useRef, useState } from "preact/hooks";

import { ImageViewer } from "./ImageViewer";
import { JsonTree } from "./JsonTree";
import { PlotPanel } from "./PlotView";
import { ScenePanel } from "./Scene3DView";
import { VideoPlayer } from "./VideoPlayer";
import type { ChannelDto, DecodedValue, MessageDto, TimeRangeDto } from "../../shared/dto";
import { isPoseSchema } from "../../shared/pose";
import { formatBytes, formatTimestamp } from "../../shared/time";
import { numericFieldPaths } from "../numericPaths";
import type { RpcClient } from "../rpcClient";
import { RpcError } from "../rpcClient";

/** Which visualization is shown in the detail pane's bounded panel. */
type VizMode = "none" | "image" | "plot" | "scene";

const ROW_H = 26;
const OVERSCAN = 12;
const PAGE_COUNT = 100;
const PAGE_BYTES = 1_000_000;

/**
 * Browses one channel's messages: an index-based list with fixed-row virtual
 * scrolling and cursor pagination on scroll, plus a detail pane showing the
 * selected message's decoded JSON tree.
 */
export function MessageBrowser({
  channel,
  rpc,
  timeRange,
  onBack,
  onPreview,
  onPlot,
  onScene3D,
}: {
  channel: ChannelDto;
  rpc: RpcClient;
  timeRange?: TimeRangeDto;
  onBack: () => void;
  /** Expands the inline image/video preview to the full-screen viewer. */
  onPreview?: (anchor: { logTime: string; sequence: number }) => void;
  /** Expands the inline plot to the full-screen plot view. */
  onPlot?: () => void;
  /** Expands the inline 3D scene to the full-screen scene view. */
  onScene3D?: () => void;
}) {
  const [messages, setMessages] = useState<MessageDto[]>([]);
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [reachedEnd, setReachedEnd] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [selected, setSelected] = useState<number | undefined>(undefined);
  const [vizMode, setVizMode] = useState<VizMode>(channel.preview ? "image" : "none");
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportH, setViewportH] = useState(400);
  const listRef = useRef<HTMLDivElement>(null);
  const loadingRef = useRef(false);
  const cursorRef = useRef<string | undefined>(undefined);
  const reachedEndRef = useRef(false);
  // True once the user explicitly picks a viz mode, so auto-selection stops
  // overriding their choice for the current channel.
  const userPickedRef = useRef(false);

  const loadNext = async () => {
    if (loadingRef.current || reachedEndRef.current) {
      return;
    }
    loadingRef.current = true;
    setLoading(true);
    setError(undefined);
    try {
      const body = await rpc.request({
        op: "queryMessages",
        topics: [channel.topic],
        cursor: cursorRef.current,
        limitCount: PAGE_COUNT,
        limitBytes: PAGE_BYTES,
      });
      if (body.type === "messages") {
        setMessages((prev) => [...prev, ...body.page.messages]);
        cursorRef.current = body.page.nextCursor;
        reachedEndRef.current = body.page.reachedEnd;
        setCursor(body.page.nextCursor);
        setReachedEnd(body.page.reachedEnd);
      }
    } catch (e) {
      setError(e instanceof RpcError ? e.message : String(e));
      reachedEndRef.current = true; // stop auto-retrying on error
      setReachedEnd(true);
    } finally {
      loadingRef.current = false;
      setLoading(false);
    }
  };

  useEffect(() => {
    // Reset when the channel changes and load the first page.
    setMessages([]);
    setSelected(undefined);
    setVizMode(channel.preview ? "image" : "none");
    userPickedRef.current = Boolean(channel.preview); // media defaults to image
    setScrollTop(0);
    cursorRef.current = undefined;
    reachedEndRef.current = false;
    setCursor(undefined);
    setReachedEnd(false);
    void loadNext();
    if (listRef.current) {
      setViewportH(listRef.current.clientHeight);
      listRef.current.scrollTop = 0;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channel.topic]);

  const onScroll = (e: Event) => {
    const el = e.currentTarget as HTMLDivElement;
    setScrollTop(el.scrollTop);
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - ROW_H * 5) {
      void loadNext();
    }
  };

  const total = messages.length;
  const startIdx = Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN);
  const endIdx = Math.min(total, Math.ceil((scrollTop + viewportH) / ROW_H) + OVERSCAN);
  const visible: Array<{ idx: number; msg: MessageDto }> = [];
  for (let i = startIdx; i < endIdx; i++) {
    const msg = messages[i];
    if (msg) {
      visible.push({ idx: i, msg });
    }
  }

  const selectedMsg = selected !== undefined ? messages[selected] : undefined;

  // Detect the channel's viz capabilities. Image/video and 3D are known from
  // the schema (zero-cost); "plottable" (is this a numeric time series?) is
  // decided from the first decoded message we already fetched — undefined until
  // the first page arrives.
  const hasMedia = channel.preview === "image" || channel.preview === "video";
  const isVideo = channel.preview === "video";
  const hasPose = isPoseSchema(channel.schemaName);
  const firstDecoded = messages.find((m) => m.value !== undefined && !m.decodeError);
  const plottable = useMemo(
    () =>
      firstDecoded?.value !== undefined
        ? numericFieldPaths(firstDecoded.value).length > 0
        : undefined,
    [firstDecoded],
  );
  const showVizPanel = hasMedia || hasPose || plottable === true;

  // Auto-select the default viz once capabilities are known: image for media
  // (set at reset) → plot for a numeric time series → none. 3D stays a manual
  // chip. Stops once the user picks a mode for this channel.
  useEffect(() => {
    if (!userPickedRef.current && plottable === true) {
      setVizMode("plot");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plottable]);

  const anchor = selectedMsg
    ? { logTime: selectedMsg.logTime, sequence: selectedMsg.sequence }
    : undefined;
  const toggleMode = (m: VizMode) => {
    userPickedRef.current = true;
    setVizMode((cur) => (cur === m ? "none" : m));
  };
  const expand = () => {
    if (vizMode === "image") {
      onPreview?.(anchor ?? { logTime: "0", sequence: 0 });
    } else if (vizMode === "plot") {
      onPlot?.();
    } else if (vizMode === "scene") {
      onScene3D?.();
    }
  };

  return (
    <main class="message-browser">
      <div class="browser-header">
        <button onClick={onBack}>← Back to summary</button>
        <span class="mono browser-topic">{channel.topic}</span>
        <span class="dim">
          {channel.messageEncoding}
          {channel.messageCount ? ` · ${channel.messageCount} msgs` : ""}
          {reachedEnd ? "" : " · scroll for more"}
        </span>
      </div>
      <div class="browser-split">
        <div ref={listRef} class="message-list" onScroll={onScroll}>
          <div class="virtual-spacer" style={{ height: `${total * ROW_H}px` }}>
            {visible.map(({ idx, msg }) => (
              <div
                key={idx}
                class={`message-row${selected === idx ? " selected" : ""}`}
                style={{ top: `${idx * ROW_H}px`, height: `${ROW_H}px` }}
                onClick={() => setSelected(idx)}
              >
                <span class="msg-seq mono">#{msg.sequence}</span>
                <span class="msg-time mono">{formatTimestamp(msg.logTime)}</span>
                <span class="msg-size dim">{formatBytes(msg.sizeBytes)}</span>
                <span class="msg-preview dim">{summarize(msg)}</span>
              </div>
            ))}
          </div>
          {loading && <div class="dim loading-row">Loading…</div>}
          {!loading && total === 0 && !error && <div class="empty">No messages.</div>}
          {error && <div class="error-inline">{error}</div>}
        </div>
        <div class="message-detail">
          {showVizPanel && (
          <div class={`viz-panel${vizMode === "none" ? " collapsed" : ""}`}>
            <div class="viz-toolbar">
              {hasMedia && (
                <button
                  class={`viz-chip${vizMode === "image" ? " active" : ""}`}
                  onClick={() => toggleMode("image")}
                >
                  {isVideo ? "▶ Video" : "🖼 Image"}
                </button>
              )}
              {plottable === true && (
                <button
                  class={`viz-chip${vizMode === "plot" ? " active" : ""}`}
                  onClick={() => toggleMode("plot")}
                >
                  📈 Plot
                </button>
              )}
              {hasPose && (
                <button
                  class={`viz-chip${vizMode === "scene" ? " active" : ""}`}
                  onClick={() => toggleMode("scene")}
                >
                  🧊 3D
                </button>
              )}
              {vizMode !== "none" && (
                <button class="viz-expand" title="Expand to full screen" onClick={expand}>
                  ⤢
                </button>
              )}
            </div>
            {vizMode === "image" && (
              <div class="viz-body">
                {isVideo ? (
                  <VideoPlayer channel={channel} rpc={rpc} anchor={anchor} timeRange={timeRange} />
                ) : (
                  <ImageViewer channel={channel} rpc={rpc} anchor={anchor} />
                )}
              </div>
            )}
            {vizMode === "plot" && (
              <div class="viz-body">
                <PlotPanel channel={channel} rpc={rpc} />
              </div>
            )}
            {vizMode === "scene" && (
              <div class="viz-body">
                <ScenePanel channel={channel} rpc={rpc} />
              </div>
            )}
          </div>
          )}
          <div class="detail-scroll">
            {selectedMsg ? (
              selectedMsg.decodeError ? (
                <div class="error-inline">Decode error: {selectedMsg.decodeError}</div>
              ) : (
                <>
                  <div class="detail-head">
                    <span class="dim">
                      #{selectedMsg.sequence} · {selectedMsg.decoder} ·{" "}
                      {formatTimestamp(selectedMsg.logTime)}
                    </span>
                  </div>
                  <JsonTree value={selectedMsg.value ?? null} />
                </>
              )
            ) : (
              <div class="dim detail-placeholder">
                Select a message to inspect its decoded fields.
              </div>
            )}
          </div>
        </div>
      </div>
    </main>
  );
}

function summarize(m: MessageDto): string {
  if (m.decodeError) {
    return `⚠ ${m.decodeError}`;
  }
  const v: DecodedValue | undefined = m.value;
  if (v && typeof v === "object" && !Array.isArray(v) && (v as { type?: unknown }).type !== "bytes") {
    return Object.keys(v).slice(0, 5).join(", ");
  }
  if (v && typeof v === "object" && (v as { type?: unknown }).type === "bytes") {
    return `bytes[${(v as { length: number }).length}]`;
  }
  return "";
}
