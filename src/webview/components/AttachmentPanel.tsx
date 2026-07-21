import { useState } from "preact/hooks";

import type { AttachmentIndexDto } from "../../shared/dto";
import { formatBytes, formatTimestamp } from "../../shared/time";
import type { RpcClient } from "../rpcClient";
import { RpcError } from "../rpcClient";

export function AttachmentPanel({
  attachments,
  indexed,
  rpc,
}: {
  attachments: AttachmentIndexDto[];
  indexed: boolean;
  rpc: RpcClient;
}) {
  const [status, setStatus] = useState<Record<number, string>>({});

  if (attachments.length === 0) {
    return (
      <section>
        <h2>Attachments</h2>
        <p class="empty">No attachments.</p>
      </section>
    );
  }

  const save = async (attachment: AttachmentIndexDto) => {
    const key = attachment.index;
    setStatus((prev) => ({ ...prev, [key]: "Saving…" }));
    try {
      const body = await rpc.request({
        op: "saveAttachment",
        attachmentIndex: attachment.index,
      });
      if (body.type === "saveAttachment") {
        setStatus((prev) => ({
          ...prev,
          [key]: body.result.saved
            ? `Saved ${formatBytes(body.result.bytesWritten ?? 0)} → ${body.result.targetPath ?? ""}`
            : "Cancelled",
        }));
      }
    } catch (err) {
      const message = err instanceof RpcError ? err.message : String(err);
      setStatus((prev) => ({ ...prev, [key]: `Failed: ${message}` }));
    }
  };

  return (
    <section>
      <h2>
        Attachments <span class="count">({attachments.length})</span>
      </h2>
      <table>
        <thead>
          <tr>
            <th>Name</th>
            <th>Media type</th>
            <th>Size</th>
            <th>Log time</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {attachments.map((attachment) => {
            const key = attachment.index;
            return (
              <tr key={key}>
                <td class="mono">{attachment.name}</td>
                <td>{attachment.mediaType || "(unknown)"}</td>
                <td class="num">{formatBytes(Number(attachment.dataSize))}</td>
                <td>{formatTimestamp(attachment.logTime)}</td>
                <td>
                  <button
                    disabled={!indexed}
                    title={indexed ? "Save attachment to disk" : "Requires an indexed file"}
                    onClick={() => void save(attachment)}
                  >
                    Save As…
                  </button>
                  {status[key] && <span class="dim"> {status[key]}</span>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}
