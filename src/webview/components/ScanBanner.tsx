import { useRef, useState } from "preact/hooks";

import type { SummaryDto } from "../../shared/dto";
import { formatBytes } from "../../shared/time";
import type { RpcClient } from "../rpcClient";
import { RpcError } from "../rpcClient";

type ScanState =
  | { kind: "idle" }
  | { kind: "running"; loadedBytes: number; totalBytes?: number }
  | { kind: "failed"; message: string };

export function ScanBanner({
  summary,
  rpc,
  onScanned,
}: {
  summary: SummaryDto;
  rpc: RpcClient;
  onScanned: (summary: SummaryDto) => void;
}) {
  const [state, setState] = useState<ScanState>({ kind: "idle" });
  const abortRef = useRef<AbortController | undefined>(undefined);

  const start = async () => {
    const controller = new AbortController();
    abortRef.current = controller;
    setState({ kind: "running", loadedBytes: 0 });
    try {
      const body = await rpc.request(
        { op: "scanUnindexed" },
        {
          signal: controller.signal,
          onProgress: (loadedBytes, totalBytes) =>
            setState({ kind: "running", loadedBytes, totalBytes }),
        },
      );
      if (body.type === "summary") {
        setState({ kind: "idle" });
        onScanned(body.summary);
      }
    } catch (err) {
      if (err instanceof RpcError && err.dto.code === "CANCELLED") {
        setState({ kind: "idle" });
      } else {
        setState({ kind: "failed", message: err instanceof Error ? err.message : String(err) });
      }
    }
  };

  const cancel = () => {
    abortRef.current?.abort();
  };

  return (
    <div class="scan-banner">
      {state.kind === "idle" && (
        <>
          <p>
            This file has no summary section (unindexed). Topics, counts and time range require a
            full scan of {formatBytes(summary.fileSize)} — this reads the whole file and may take a
            while on large files or over Remote SSH.
          </p>
          <button onClick={() => void start()}>Scan file</button>
        </>
      )}
      {state.kind === "running" && (
        <>
          <p>
            Scanning… {formatBytes(state.loadedBytes)}
            {state.totalBytes ? ` / ${formatBytes(state.totalBytes)}` : ""}
          </p>
          <progress
            max={state.totalBytes ?? summary.fileSize}
            value={state.loadedBytes}
          ></progress>
          <button onClick={cancel}>Cancel</button>
        </>
      )}
      {state.kind === "failed" && (
        <>
          <p class="error-inline">Scan failed: {state.message}</p>
          <button onClick={() => void start()}>Retry</button>
        </>
      )}
    </div>
  );
}
