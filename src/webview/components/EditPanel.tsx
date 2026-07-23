import { useState } from "preact/hooks";

import type { AttachmentSourceDto, EditSpec, SummaryDto } from "../../shared/dto";
import { formatBytes, fromTimeNs, toTimeNs } from "../../shared/time";
import type { RpcClient } from "../rpcClient";
import { RpcError } from "../rpcClient";

type UpsertDraft = { name: string; entries: [string, string][]; fromExisting: boolean };

type Status =
  | { kind: "idle" }
  | { kind: "exporting"; done: number; total: number }
  | { kind: "done"; message: string }
  | { kind: "error"; message: string };

/**
 * Collects an EditSpec (drop/rename topics, time crop, metadata & attachment
 * edits) and exports the file as a new MCAP. Nothing here mutates the source —
 * the host rewrites to a user-chosen destination via `exportEdited`.
 */
export function EditPanel({
  summary,
  rpc,
  onBack,
}: {
  summary: SummaryDto;
  rpc: RpcClient;
  onBack: () => void;
}) {
  const topics = [...new Set(summary.channels.map((c) => c.topic))];
  const metaNames = [...new Set(summary.metadata.map((m) => m.name))];
  const fileStart = summary.timeRange ? fromTimeNs(summary.timeRange.start) : 0n;
  const durationSec = summary.timeRange
    ? Number(fromTimeNs(summary.timeRange.end) - fileStart) / 1e9
    : 0;

  const [drop, setDrop] = useState<Record<string, boolean>>({});
  const [rename, setRename] = useState<Record<string, string>>({});
  const [crop, setCrop] = useState(false);
  const [startSec, setStartSec] = useState(0);
  const [endSec, setEndSec] = useState(durationSec);
  const [removeMeta, setRemoveMeta] = useState<Record<string, boolean>>({});
  const [upserts, setUpserts] = useState<UpsertDraft[]>([]);
  const [removeAtt, setRemoveAtt] = useState<Record<number, boolean>>({});
  const [renameAtt, setRenameAtt] = useState<Record<number, string>>({});
  const [adds, setAdds] = useState<AttachmentSourceDto[]>([]);
  const [status, setStatus] = useState<Status>({ kind: "idle" });

  const isUpserting = (name: string) => upserts.some((u) => u.name === name);

  const editExisting = async (name: string) => {
    if (isUpserting(name)) {
      return;
    }
    // Merge every record sharing this name into one editable map.
    const merged = new Map<string, string>();
    try {
      const body = await rpc.request({ op: "getMetadata", name });
      if (body.type === "metadata") {
        for (const record of body.records) {
          for (const [k, v] of Object.entries(record.entries)) {
            merged.set(k, v);
          }
        }
      }
    } catch {
      // Fall through with whatever we have (possibly empty).
    }
    const entries: [string, string][] = merged.size ? [...merged] : [["", ""]];
    setUpserts((prev) => [...prev, { name, entries, fromExisting: true }]);
  };

  const addRecord = () => {
    setUpserts((prev) => [...prev, { name: "", entries: [["", ""]], fromExisting: false }]);
  };

  const patchUpsert = (i: number, patch: Partial<UpsertDraft>) => {
    setUpserts((prev) => prev.map((u, idx) => (idx === i ? { ...u, ...patch } : u)));
  };

  const removeUpsert = (i: number) => {
    setUpserts((prev) => prev.filter((_, idx) => idx !== i));
  };

  const addFile = async () => {
    try {
      const body = await rpc.request({ op: "pickAttachmentFile" });
      if (body.type === "attachmentSource" && body.source) {
        setAdds((prev) => [...prev, body.source!]);
      }
    } catch (err) {
      setStatus({ kind: "error", message: err instanceof RpcError ? err.message : String(err) });
    }
  };

  const buildSpec = (): EditSpec => {
    const secToNs = (sec: number): string => toTimeNs(fileStart + BigInt(Math.round(sec * 1e9)));
    const upsertNames = new Set(upserts.map((u) => u.name.trim()).filter(Boolean));
    return {
      dropTopics: topics.filter((t) => drop[t]),
      renameTopics: Object.fromEntries(
        topics
          .filter((t) => !drop[t] && rename[t]?.trim() && rename[t].trim() !== t)
          .map((t) => [t, rename[t]!.trim()]),
      ),
      timeRange:
        crop && summary.timeRange
          ? { start: secToNs(Math.max(0, startSec)), end: secToNs(Math.min(durationSec, endSec)) }
          : undefined,
      metadata: {
        remove: metaNames.filter((n) => removeMeta[n] && !upsertNames.has(n)),
        upsert: upserts
          .map((u) => ({
            name: u.name.trim(),
            entries: Object.fromEntries(u.entries.filter(([k]) => k.trim() !== "")),
          }))
          .filter((u) => u.name !== ""),
      },
      attachments: {
        removeIndexes: summary.attachments.filter((a) => removeAtt[a.index]).map((a) => a.index),
        rename: summary.attachments
          .filter((a) => !removeAtt[a.index] && renameAtt[a.index]?.trim())
          .map((a) => ({ index: a.index, name: renameAtt[a.index]!.trim() })),
        add: adds.map((a) => ({ sourcePath: a.path, name: a.name, mediaType: a.mediaType })),
      },
    };
  };

  const doExport = async () => {
    setStatus({ kind: "exporting", done: 0, total: Number(summary.stats?.messageCount ?? 0) });
    try {
      const body = await rpc.request(
        { op: "exportEdited", spec: buildSpec() },
        {
          onProgress: (loaded, total) =>
            setStatus({ kind: "exporting", done: loaded, total: total ?? 0 }),
        },
      );
      if (body.type === "exportResult") {
        setStatus(
          body.result.saved
            ? {
                kind: "done",
                message: `Exported ${formatBytes(body.result.bytesWritten ?? 0)} → ${body.result.targetPath}`,
              }
            : { kind: "idle" },
        );
      }
    } catch (err) {
      setStatus({ kind: "error", message: err instanceof RpcError ? err.message : String(err) });
    }
  };

  const busy = status.kind === "exporting";

  return (
    <main class="edit-view">
      <div class="browser-header">
        <button onClick={onBack} disabled={busy}>
          ← Back to summary
        </button>
        <span class="browser-topic">Edit &amp; export</span>
        <span class="dim">rewrites to a new file · the original is never changed</span>
      </div>

      {/* Topics */}
      <section>
        <h2>
          Topics <span class="count">(uncheck to drop · rename optional)</span>
        </h2>
        <table>
          <thead>
            <tr>
              <th>Keep</th>
              <th>Topic</th>
              <th>Rename to</th>
            </tr>
          </thead>
          <tbody>
            {topics.map((t) => (
              <tr key={t}>
                <td>
                  <input
                    type="checkbox"
                    checked={!drop[t]}
                    onInput={(e) =>
                      setDrop((prev) => ({ ...prev, [t]: !(e.target as HTMLInputElement).checked }))
                    }
                  />
                </td>
                <td class={`mono${drop[t] ? " edit-dropped" : ""}`}>{t}</td>
                <td>
                  <input
                    class="mono edit-input"
                    type="text"
                    placeholder="(unchanged)"
                    disabled={drop[t]}
                    value={rename[t] ?? ""}
                    onInput={(e) =>
                      setRename((prev) => ({ ...prev, [t]: (e.target as HTMLInputElement).value }))
                    }
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {/* Time crop */}
      <section>
        <h2>Time range</h2>
        {summary.timeRange ? (
          <>
            <label class="edit-check">
              <input
                type="checkbox"
                checked={crop}
                onInput={(e) => setCrop((e.target as HTMLInputElement).checked)}
              />
              Crop to a sub-range (seconds from file start)
            </label>
            {crop && (
              <div class="edit-row">
                <label>
                  start&nbsp;
                  <input
                    class="edit-input"
                    type="number"
                    min={0}
                    max={durationSec}
                    step={0.001}
                    value={startSec}
                    onInput={(e) => setStartSec(Number((e.target as HTMLInputElement).value))}
                  />
                </label>
                <label>
                  end&nbsp;
                  <input
                    class="edit-input"
                    type="number"
                    min={0}
                    max={durationSec}
                    step={0.001}
                    value={endSec}
                    onInput={(e) => setEndSec(Number((e.target as HTMLInputElement).value))}
                  />
                </label>
                <span class="dim">of {durationSec.toFixed(3)} s total</span>
              </div>
            )}
          </>
        ) : (
          <p class="empty">No time range (file has no messages).</p>
        )}
      </section>

      {/* Metadata */}
      <section>
        <h2>
          Metadata <span class="count">({metaNames.length} records)</span>
        </h2>
        {metaNames.length === 0 && upserts.length === 0 && (
          <p class="empty">No metadata records.</p>
        )}
        <ul class="expandable-list">
          {metaNames.map((name) => (
            <li key={name}>
              <div class="edit-row">
                <label class="edit-check">
                  <input
                    type="checkbox"
                    checked={!!removeMeta[name]}
                    disabled={isUpserting(name)}
                    onInput={(e) =>
                      setRemoveMeta((prev) => ({
                        ...prev,
                        [name]: (e.target as HTMLInputElement).checked,
                      }))
                    }
                  />
                  remove
                </label>
                <span class={`mono${removeMeta[name] ? " edit-dropped" : ""}`}>{name}</span>
                <button
                  class="edit-small"
                  disabled={isUpserting(name) || removeMeta[name]}
                  onClick={() => void editExisting(name)}
                >
                  Edit…
                </button>
              </div>
            </li>
          ))}
        </ul>
        {upserts.map((u, i) => (
          <div class="edit-card" key={`upsert-${i}`}>
            <div class="edit-row">
              <input
                class="mono edit-input"
                type="text"
                placeholder="record name"
                value={u.name}
                disabled={u.fromExisting}
                onInput={(e) => patchUpsert(i, { name: (e.target as HTMLInputElement).value })}
              />
              <span class="dim">{u.fromExisting ? "(replaces existing)" : "(new record)"}</span>
              <button class="edit-small" onClick={() => removeUpsert(i)}>
                Discard
              </button>
            </div>
            <table class="kv-table">
              <tbody>
                {u.entries.map(([k, v], row) => (
                  <tr key={row}>
                    <td>
                      <input
                        class="mono edit-input"
                        type="text"
                        placeholder="key"
                        value={k}
                        onInput={(e) => {
                          const value = (e.target as HTMLInputElement).value;
                          patchUpsert(i, {
                            entries: u.entries.map((pair, r) =>
                              r === row ? [value, pair[1]] : pair,
                            ),
                          });
                        }}
                      />
                    </td>
                    <td>
                      <input
                        class="mono edit-input"
                        type="text"
                        placeholder="value"
                        value={v}
                        onInput={(e) => {
                          const value = (e.target as HTMLInputElement).value;
                          patchUpsert(i, {
                            entries: u.entries.map((pair, r) =>
                              r === row ? [pair[0], value] : pair,
                            ),
                          });
                        }}
                      />
                    </td>
                    <td>
                      <button
                        class="edit-small"
                        onClick={() =>
                          patchUpsert(i, { entries: u.entries.filter((_, r) => r !== row) })
                        }
                      >
                        ✕
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <button
              class="edit-small"
              onClick={() => patchUpsert(i, { entries: [...u.entries, ["", ""]] })}
            >
              + key
            </button>
          </div>
        ))}
        <div class="edit-actions">
          <button class="edit-small" onClick={addRecord}>
            + Add metadata record
          </button>
        </div>
      </section>

      {/* Attachments */}
      <section>
        <h2>
          Attachments <span class="count">({summary.attachments.length})</span>
        </h2>
        {summary.attachments.length === 0 && adds.length === 0 && (
          <p class="empty">No attachments.</p>
        )}
        {summary.attachments.length > 0 && (
          <table>
            <thead>
              <tr>
                <th>Remove</th>
                <th>Name</th>
                <th>Rename to</th>
                <th>Size</th>
              </tr>
            </thead>
            <tbody>
              {summary.attachments.map((a) => (
                <tr key={a.index}>
                  <td>
                    <input
                      type="checkbox"
                      checked={!!removeAtt[a.index]}
                      onInput={(e) =>
                        setRemoveAtt((prev) => ({
                          ...prev,
                          [a.index]: (e.target as HTMLInputElement).checked,
                        }))
                      }
                    />
                  </td>
                  <td class={`mono${removeAtt[a.index] ? " edit-dropped" : ""}`}>{a.name}</td>
                  <td>
                    <input
                      class="mono edit-input"
                      type="text"
                      placeholder="(unchanged)"
                      disabled={!!removeAtt[a.index]}
                      value={renameAtt[a.index] ?? ""}
                      onInput={(e) =>
                        setRenameAtt((prev) => ({
                          ...prev,
                          [a.index]: (e.target as HTMLInputElement).value,
                        }))
                      }
                    />
                  </td>
                  <td class="num">{formatBytes(Number(a.dataSize))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {adds.length > 0 && (
          <table>
            <tbody>
              {adds.map((a, i) => (
                <tr key={`add-${i}`}>
                  <td class="dim">new</td>
                  <td>
                    <input
                      class="mono edit-input"
                      type="text"
                      value={a.name}
                      onInput={(e) => {
                        const name = (e.target as HTMLInputElement).value;
                        setAdds((prev) => prev.map((x, idx) => (idx === i ? { ...x, name } : x)));
                      }}
                    />
                  </td>
                  <td class="dim mono">{a.mediaType}</td>
                  <td class="num">{formatBytes(Number(a.dataSize))}</td>
                  <td>
                    <button
                      class="edit-small"
                      onClick={() => setAdds((prev) => prev.filter((_, idx) => idx !== i))}
                    >
                      ✕
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <div class="edit-actions">
          <button class="edit-small" onClick={() => void addFile()}>
            Add file…
          </button>
          <span class="dim">added files are read into memory when exporting</span>
        </div>
      </section>

      {/* Export */}
      <section class="edit-export">
        <button onClick={() => void doExport()} disabled={busy}>
          {busy ? "Exporting…" : "Export edited MCAP…"}
        </button>
        {status.kind === "exporting" && (
          <div class="edit-progress">
            <progress
              value={status.total > 0 ? status.done : undefined}
              max={status.total > 0 ? status.total : undefined}
            />
            <span class="dim">
              {status.total > 0
                ? `${status.done.toLocaleString()} / ${status.total.toLocaleString()} messages`
                : "working…"}
            </span>
          </div>
        )}
        {status.kind === "done" && <span class="dim edit-ok"> {status.message}</span>}
        {status.kind === "error" && <span class="error-inline"> {status.message}</span>}
      </section>
    </main>
  );
}
