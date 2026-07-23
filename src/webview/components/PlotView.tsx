import type { ComponentChildren } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import uPlot from "uplot";

import { numericFieldPaths } from "../numericPaths";
import type { ChannelDto, TimeSeriesDto } from "../../shared/dto";
import type { RpcClient } from "../rpcClient";
import { RpcError } from "../rpcClient";

const MAX_POINTS = 2000;
const DEFAULT_FIELDS = 3;

type Status = "loading" | "empty" | "ready" | "error";

/**
 * Time-series plot for one channel. Discovers numeric field paths from a sample
 * message, plots the selected ones over the channel's time range with uPlot,
 * and re-queries the server for detail when the user drag-selects a sub-range
 * (server-side downsampling keeps the payload bounded at any zoom).
 */
export function PlotPanel({
  channel,
  rpc,
}: {
  channel: ChannelDto;
  rpc: RpcClient;
}) {
  const [status, setStatus] = useState<Status>("loading");
  const [error, setError] = useState<string | undefined>(undefined);
  const [fields, setFields] = useState<string[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [zoomed, setZoomed] = useState(false);
  const [info, setInfo] = useState<string>("");

  const hostRef = useRef<HTMLDivElement>(null);
  const plotRef = useRef<uPlot | null>(null);
  const baseNsRef = useRef<bigint>(0n);
  const abortRef = useRef<AbortController | null>(null);
  const selectedRef = useRef<string[]>([]);

  // Discover numeric fields once per channel, then load the full range.
  useEffect(() => {
    let cancelled = false;
    setStatus("loading");
    setError(undefined);
    setZoomed(false);
    void (async () => {
      try {
        const body = await rpc.request({
          op: "queryMessages",
          topics: [channel.topic],
          limitCount: 1,
          limitBytes: 4_000_000,
        });
        if (cancelled) {
          return;
        }
        const first = body.type === "messages" ? body.page.messages[0] : undefined;
        const paths = first?.value !== undefined ? numericFieldPaths(first.value) : [];
        if (paths.length === 0) {
          setStatus("empty");
          return;
        }
        // Default to signal fields, not header counters / covariance matrices.
        const preferred = paths.filter(
          (p) => !/(^|\.)header(\.|$)/.test(p) && !p.includes("covariance"),
        );
        const initial = (preferred.length > 0 ? preferred : paths).slice(0, DEFAULT_FIELDS);
        setFields(paths);
        setSelected(initial);
        selectedRef.current = initial;
        await load(undefined, undefined, initial);
      } catch (e) {
        if (!cancelled) {
          fail(e);
        }
      }
    })();
    return () => {
      cancelled = true;
      abortRef.current?.abort();
      plotRef.current?.destroy();
      plotRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channel.id]);

  const fail = (e: unknown) => {
    setError(e instanceof RpcError ? e.message : e instanceof Error ? e.message : String(e));
    setStatus("error");
  };

  /** Query a range (undefined = whole channel) for the given fields and (re)draw. */
  const load = async (start: string | undefined, end: string | undefined, useFields: string[]) => {
    if (useFields.length === 0) {
      plotRef.current?.destroy();
      plotRef.current = null;
      setStatus("ready");
      setInfo("Select at least one field to plot.");
      return;
    }
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setStatus("loading");
    setError(undefined);
    try {
      const body = await rpc.request(
        { op: "queryTimeSeries", channelId: channel.id, fields: useFields, start, end, maxPoints: MAX_POINTS },
        { signal: controller.signal },
      );
      if (controller.signal.aborted || body.type !== "timeSeries") {
        return;
      }
      draw(body.data, useFields);
      setStatus("ready");
      setInfo(
        `${body.data.sampled} pts${body.data.reachedCap ? " (capped)" : ""}` +
          (start !== undefined ? " · zoomed" : ""),
      );
      setZoomed(start !== undefined);
    } catch (e) {
      if (!controller.signal.aborted) {
        fail(e);
      }
    }
  };

  const draw = (data: TimeSeriesDto, useFields: string[]) => {
    baseNsRef.current = BigInt(data.startNs);
    const host = hostRef.current;
    if (!host) {
      return;
    }
    plotRef.current?.destroy();
    const theme = themeColors();
    const aligned: uPlot.AlignedData = [data.t, ...data.values.map((v) => v as (number | null)[])];
    const opts: uPlot.Options = {
      width: Math.max(320, host.clientWidth),
      height: Math.max(240, host.clientHeight || 420),
      scales: { x: { time: false } },
      legend: { show: true },
      cursor: { drag: { x: true, y: false, setScale: false } },
      series: [
        { label: "t (s)" },
        ...useFields.map((path, i) => ({
          label: path === "" ? "(value)" : path,
          stroke: theme.palette[i % theme.palette.length]!,
          width: 1,
          spanGaps: false,
        })),
      ],
      axes: [axis(theme, (v) => `${v}s`), axis(theme)],
      hooks: {
        setSelect: [
          (u) => {
            if (u.select.width <= 2) {
              return;
            }
            const lo = u.posToVal(u.select.left, "x");
            const hi = u.posToVal(u.select.left + u.select.width, "x");
            u.setSelect({ left: 0, top: 0, width: 0, height: 0 }, false);
            const start = baseNsRef.current + BigInt(Math.round(lo * 1e9));
            const end = baseNsRef.current + BigInt(Math.round(hi * 1e9));
            void load(start.toString(), end.toString(), selectedRef.current);
          },
        ],
      },
    };
    plotRef.current = new uPlot(opts, aligned, host);
  };

  const toggleField = (path: string) => {
    const next = selected.includes(path)
      ? selected.filter((p) => p !== path)
      : [...selected, path];
    setSelected(next);
    selectedRef.current = next;
    void load(undefined, undefined, next); // field change resets to full range
    setZoomed(false);
  };

  const resetZoom = () => {
    void load(undefined, undefined, selectedRef.current);
  };

  if (status === "empty") {
    return (
      <div class="dim detail-placeholder">
        No numeric fields to plot in this channel ({channel.schemaName}).
      </div>
    );
  }

  return (
    <>
      <div class="plot-fields">
        {fields.map((path) => (
          <label key={path} class="plot-field">
            <input
              type="checkbox"
              checked={selected.includes(path)}
              onChange={() => toggleField(path)}
            />
            <span class="mono">{path === "" ? "(value)" : path}</span>
          </label>
        ))}
      </div>
      <div class="plot-toolbar">
        {zoomed && <button onClick={resetZoom}>⤢ Reset zoom</button>}
        <span class="dim">{status === "loading" ? "Loading…" : info}</span>
        <span class="dim plot-hint">drag on the plot to zoom into a range</span>
      </div>
      {error && <div class="error-inline">{error}</div>}
      <div ref={hostRef} class="plot-host" />
    </>
  );
}

/** Full-screen page wrapper: header with Back + the PlotPanel. */
export function PlotView({
  channel,
  rpc,
  onBack,
}: {
  channel: ChannelDto;
  rpc: RpcClient;
  onBack: () => void;
}) {
  return (
    <Shell channel={channel} onBack={onBack}>
      <PlotPanel channel={channel} rpc={rpc} />
    </Shell>
  );
}

function Shell({
  channel,
  onBack,
  children,
}: {
  channel: ChannelDto;
  onBack: () => void;
  children: ComponentChildren;
}) {
  return (
    <main class="plot-view">
      <div class="browser-header">
        <button onClick={onBack}>← Back to messages</button>
        <span class="mono browser-topic">{channel.topic}</span>
        <span class="dim">{channel.schemaName}</span>
      </div>
      {children}
    </main>
  );
}

interface Theme {
  fg: string;
  grid: string;
  palette: string[];
}

function axis(theme: Theme, values?: (v: number) => string): uPlot.Axis {
  return {
    stroke: theme.fg,
    grid: { stroke: theme.grid, width: 1 },
    ticks: { stroke: theme.grid, width: 1 },
    ...(values ? { values: (_u, splits) => splits.map(values) } : {}),
  };
}

function themeColors(): Theme {
  const cs = getComputedStyle(document.body);
  const v = (name: string, fallback: string) => cs.getPropertyValue(name).trim() || fallback;
  return {
    fg: v("--vscode-foreground", "#cccccc"),
    grid: v("--vscode-panel-border", "rgba(128,128,128,0.25)"),
    palette: [
      v("--vscode-charts-blue", "#3794ff"),
      v("--vscode-charts-red", "#f14c4c"),
      v("--vscode-charts-green", "#89d185"),
      v("--vscode-charts-yellow", "#e2c08d"),
      v("--vscode-charts-orange", "#d18616"),
      v("--vscode-charts-purple", "#b180d7"),
    ],
  };
}
