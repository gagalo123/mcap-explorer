import { useEffect, useState } from "preact/hooks";

import { AttachmentPanel } from "./components/AttachmentPanel";
import { ChannelTable } from "./components/ChannelTable";
import { MetadataPanel } from "./components/MetadataPanel";
import { ScanBanner } from "./components/ScanBanner";
import { SchemaPanel } from "./components/SchemaPanel";
import { SummaryHeader } from "./components/SummaryHeader";
import type { RpcClient } from "./rpcClient";
import type { SummaryDto } from "../shared/dto";
import type { ErrorDto } from "../shared/protocol";

type Phase =
  | { kind: "loading" }
  | { kind: "error"; error: ErrorDto }
  | { kind: "ready"; summary: SummaryDto };

/** Bump when SummaryDto changes shape — stale persisted state is discarded. */
const STATE_VERSION = 1;

interface PersistedState {
  v: number;
  summary?: SummaryDto;
}

export function App({ rpc }: { rpc: RpcClient }) {
  const [phase, setPhase] = useState<Phase>(() => {
    // Instant repaint when the webview is rebuilt after a tab switch; the
    // host's init message refreshes this immediately afterwards.
    try {
      const persisted = rpc.getState<PersistedState>();
      if (persisted?.v === STATE_VERSION && persisted.summary) {
        return { kind: "ready", summary: persisted.summary };
      }
    } catch {
      // Corrupt persisted state — fall through to loading.
    }
    return { kind: "loading" };
  });

  useEffect(() => {
    rpc.onInit((msg) => {
      if (msg.summary) {
        setPhase({ kind: "ready", summary: msg.summary });
        rpc.setState({ v: STATE_VERSION, summary: msg.summary } satisfies PersistedState);
      } else {
        setPhase({
          kind: "error",
          error: msg.error ?? { code: "IO_ERROR", message: "Unknown error opening file." },
        });
      }
    });
    rpc.ready();
  }, [rpc]);

  const onScanned = (summary: SummaryDto) => {
    setPhase({ kind: "ready", summary });
    rpc.setState({ v: STATE_VERSION, summary } satisfies PersistedState);
  };

  if (phase.kind === "loading") {
    return <main class="centered dim">Reading MCAP summary…</main>;
  }

  if (phase.kind === "error") {
    return (
      <main class="centered">
        <div class="error-box">
          <h1>Cannot open this file</h1>
          <p class="mono">{phase.error.code}</p>
          <p>{phase.error.message}</p>
        </div>
      </main>
    );
  }

  const { summary } = phase;
  return (
    <main>
      <SummaryHeader summary={summary} />
      {!summary.indexed && !summary.scanned && (
        <ScanBanner summary={summary} rpc={rpc} onScanned={onScanned} />
      )}
      <ChannelTable channels={summary.channels} />
      <SchemaPanel schemas={summary.schemas} rpc={rpc} />
      <MetadataPanel metadata={summary.metadata} rpc={rpc} />
      <AttachmentPanel attachments={summary.attachments} indexed={summary.indexed} rpc={rpc} />
    </main>
  );
}
