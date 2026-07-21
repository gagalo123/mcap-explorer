import { useEffect, useState } from "preact/hooks";

import { AttachmentPanel } from "./components/AttachmentPanel";
import { ChannelTable } from "./components/ChannelTable";
import { MessageBrowser } from "./components/MessageBrowser";
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

type View = { kind: "summary" } | { kind: "messages"; channelId: number };

/** Bump when persisted-state shape changes — stale state is discarded. */
const STATE_VERSION = 2;

interface PersistedState {
  v: number;
  summary?: SummaryDto;
  view?: View;
}

export function App({ rpc }: { rpc: RpcClient }) {
  const persisted = (() => {
    try {
      const p = rpc.getState<PersistedState>();
      return p?.v === STATE_VERSION ? p : undefined;
    } catch {
      return undefined;
    }
  })();

  const [phase, setPhase] = useState<Phase>(
    // Instant repaint when the webview is rebuilt after a tab switch; the
    // host's init message refreshes this immediately afterwards.
    persisted?.summary ? { kind: "ready", summary: persisted.summary } : { kind: "loading" },
  );
  const [view, setView] = useState<View>(persisted?.view ?? { kind: "summary" });

  const persist = (next: { summary?: SummaryDto; view?: View }) => {
    const current = rpc.getState<PersistedState>();
    rpc.setState({
      v: STATE_VERSION,
      summary: next.summary ?? current?.summary,
      view: next.view ?? current?.view,
    } satisfies PersistedState);
  };

  useEffect(() => {
    rpc.onInit((msg) => {
      if (msg.summary) {
        setPhase({ kind: "ready", summary: msg.summary });
        persist({ summary: msg.summary });
      } else {
        setPhase({
          kind: "error",
          error: msg.error ?? { code: "IO_ERROR", message: "Unknown error opening file." },
        });
      }
    });
    rpc.ready();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rpc]);

  const goToMessages = (channelId: number) => {
    const next: View = { kind: "messages", channelId };
    setView(next);
    persist({ view: next });
  };

  const goToSummary = () => {
    const next: View = { kind: "summary" };
    setView(next);
    persist({ view: next });
  };

  const onScanned = (summary: SummaryDto) => {
    setPhase({ kind: "ready", summary });
    persist({ summary });
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

  if (view.kind === "messages") {
    const channel = summary.channels.find((c) => c.id === view.channelId);
    if (channel && summary.indexed) {
      return <MessageBrowser channel={channel} rpc={rpc} onBack={goToSummary} />;
    }
    // Channel gone or file not indexed — fall back to summary.
  }

  return (
    <main>
      <SummaryHeader summary={summary} />
      {!summary.indexed && !summary.scanned && (
        <ScanBanner summary={summary} rpc={rpc} onScanned={onScanned} />
      )}
      <ChannelTable
        channels={summary.channels}
        onSelect={summary.indexed ? goToMessages : undefined}
      />
      <SchemaPanel schemas={summary.schemas} rpc={rpc} />
      <MetadataPanel metadata={summary.metadata} rpc={rpc} />
      <AttachmentPanel attachments={summary.attachments} indexed={summary.indexed} rpc={rpc} />
    </main>
  );
}
