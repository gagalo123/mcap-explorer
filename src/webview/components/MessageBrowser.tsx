import { useEffect, useRef, useState } from "preact/hooks";

import { JsonTree } from "./JsonTree";
import type { ChannelDto, DecodedValue, MessageDto } from "../../shared/dto";
import { formatBytes, formatTimestamp } from "../../shared/time";
import type { RpcClient } from "../rpcClient";
import { RpcError } from "../rpcClient";

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
  onBack,
  onPreview,
  onPlot,
  onScene3D,
}: {
  channel: ChannelDto;
  rpc: RpcClient;
  onBack: () => void;
  /** Set for image/video channels: opens the preview at the given message. */
  onPreview?: (anchor: { logTime: string; sequence: number }) => void;
  /** Opens the time-series plot for this channel's numeric fields. */
  onPlot?: () => void;
  /** Set for pose/tracker channels: opens the 3D scene view. */
  onScene3D?: () => void;
}) {
  const [messages, setMessages] = useState<MessageDto[]>([]);
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [reachedEnd, setReachedEnd] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [selected, setSelected] = useState<number | undefined>(undefined);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportH, setViewportH] = useState(400);
  const listRef = useRef<HTMLDivElement>(null);
  const loadingRef = useRef(false);
  const cursorRef = useRef<string | undefined>(undefined);
  const reachedEndRef = useRef(false);

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
        {onPlot && (
          <button class="plot-btn" onClick={onPlot}>
            📈 Plot
          </button>
        )}
        {onScene3D && (
          <button class="plot-btn" onClick={onScene3D}>
            🧊 3D View
          </button>
        )}
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
                  {onPreview && (
                    <button
                      class="preview-btn"
                      onClick={() =>
                        onPreview({ logTime: selectedMsg.logTime, sequence: selectedMsg.sequence })
                      }
                    >
                      {channel.preview === "video" ? "▶ Preview frame" : "🖼 Preview image"}
                    </button>
                  )}
                </div>
                <JsonTree value={selectedMsg.value ?? null} />
              </>
            )
          ) : (
            <div class="dim detail-placeholder">Select a message to inspect its decoded fields.</div>
          )}
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
