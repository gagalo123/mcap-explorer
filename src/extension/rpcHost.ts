import * as vscode from "vscode";

import { saveAttachmentInteractive } from "./attachmentSaver";
import { McapExplorerError, toErrorDto } from "./errors";
import type { McapDocument } from "./mcapDocument";
import type { HostToWebview, RequestOp, ResponseBody, WebviewToHost } from "../shared/protocol";

/**
 * Host side of the webview RPC bridge. One instance per webview panel; the
 * underlying document (file handle, reader, summary cache) may be shared.
 */
export class RpcHost {
  #aborts = new Map<number, AbortController>();
  #subscription: vscode.Disposable;

  constructor(
    private readonly webview: vscode.Webview,
    private readonly document: McapDocument,
    private readonly log: (message: string) => void,
  ) {
    this.#subscription = webview.onDidReceiveMessage((msg: WebviewToHost) => {
      void this.#handle(msg);
    });
  }

  dispose(): void {
    for (const controller of this.#aborts.values()) {
      controller.abort();
    }
    this.#aborts.clear();
    this.#subscription.dispose();
  }

  #post(message: HostToWebview): void {
    void this.webview.postMessage(message);
  }

  async #handle(msg: WebviewToHost): Promise<void> {
    switch (msg.kind) {
      case "ready": {
        // A `ready` after startup means the webview was rebuilt (tab switch):
        // the old JS context is gone, nobody will consume in-flight responses
        // and its request ids restart at 1 — abort the orphans.
        for (const controller of this.#aborts.values()) {
          controller.abort();
        }
        this.#aborts.clear();
        if (this.document.session) {
          this.#post({ kind: "init", summary: this.document.session.summary() });
          this.#logReadStats("summary served");
        } else {
          this.#post({ kind: "init", error: this.document.openError });
        }
        return;
      }
      case "cancel": {
        this.#aborts.get(msg.id)?.abort();
        return;
      }
      case "request": {
        const controller = new AbortController();
        this.#aborts.set(msg.id, controller);
        try {
          const body = await this.#dispatch(msg.id, msg.op, controller.signal);
          this.#post({ kind: "response", id: msg.id, ok: true, body });
        } catch (err) {
          this.#post({ kind: "response", id: msg.id, ok: false, error: toErrorDto(err) });
        } finally {
          this.#aborts.delete(msg.id);
        }
        return;
      }
    }
  }

  async #dispatch(id: number, op: RequestOp, signal: AbortSignal): Promise<ResponseBody> {
    const session = this.document.session;
    if (!session) {
      throw new McapExplorerError(
        this.document.openError?.code ?? "IO_ERROR",
        this.document.openError?.message ?? "File failed to open.",
      );
    }
    switch (op.op) {
      case "getSummary":
        return { type: "summary", summary: session.summary() };
      case "getSchemaSource":
        return { type: "schemaSource", source: session.getSchemaSource(op.schemaId) };
      case "getMetadata":
        return { type: "metadata", records: await session.getMetadata(op.name) };
      case "saveAttachment": {
        const result = await saveAttachmentInteractive(session, op.attachmentIndex, signal);
        return { type: "saveAttachment", result };
      }
      case "scanUnindexed": {
        await this.#confirmLargeScan();
        const summary = await session.scanUnindexed((progress) => {
          this.#post({
            kind: "progress",
            id,
            loadedBytes: progress.loadedBytes,
            totalBytes: progress.totalBytes,
          });
        }, signal);
        this.#logReadStats("scan finished");
        return { type: "summary", summary };
      }
      case "queryMessages": {
        const page = await session.queryMessages(op, signal);
        return { type: "messages", page };
      }
      case "getFrameWindow": {
        const data = await session.getFrameWindow(op, signal);
        return { type: "videoFrames", data };
      }
      case "getImageFrame": {
        const data = await session.getImageFrame(op, signal);
        return { type: "imageFrame", data };
      }
      case "getImageWindow": {
        const data = await session.getImageWindow(op, signal);
        return { type: "imageFrames", data };
      }
      case "queryTimeSeries": {
        const data = await session.queryTimeSeries(op, signal);
        return { type: "timeSeries", data };
      }
      default:
        throw new McapExplorerError(
          "UNSUPPORTED_OP",
          `Operation "${op.op}" is not implemented yet.`,
        );
    }
  }

  /** Asks before a full scan of a large unindexed file (config-gated). */
  async #confirmLargeScan(): Promise<void> {
    const threshold = vscode.workspace
      .getConfiguration("mcapExplorer")
      .get<number>("unindexedScanConfirmSize", 200 * 1024 * 1024);
    const fileSize = this.document.session?.summary().fileSize ?? 0;
    if (fileSize <= threshold) {
      return;
    }
    const sizeGb = (fileSize / 1024 / 1024 / 1024).toFixed(1);
    const answer = await vscode.window.showWarningMessage(
      `Scan this ${sizeGb} GB unindexed MCAP file? The whole file will be read, which may take a while.`,
      { modal: true },
      "Scan",
    );
    if (answer !== "Scan") {
      throw new McapExplorerError("CANCELLED", "Scan declined.");
    }
  }

  #logReadStats(context: string): void {
    const metered = this.document.metered;
    if (metered) {
      this.log(
        `[${this.document.uri.fsPath}] ${context}: ` +
          `${metered.bytesRead} bytes in ${metered.readCalls} reads`,
      );
    }
  }
}
