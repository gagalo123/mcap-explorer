import { useState } from "preact/hooks";

import type { MetadataDto, MetadataIndexDto } from "../../shared/dto";
import type { RpcClient } from "../rpcClient";
import { RpcError } from "../rpcClient";

type Entry = MetadataDto[] | "loading" | { failed: string };

export function MetadataPanel({
  metadata,
  rpc,
}: {
  metadata: MetadataIndexDto[];
  rpc: RpcClient;
}) {
  // Map, not a plain object: metadata names come straight from the file and
  // may collide with Object.prototype keys ("__proto__", "constructor", …).
  const [loaded, setLoaded] = useState<ReadonlyMap<string, Entry>>(new Map());

  if (metadata.length === 0) {
    return (
      <section>
        <h2>Metadata</h2>
        <p class="empty">No metadata records.</p>
      </section>
    );
  }

  const names = [...new Set(metadata.map((m) => m.name))];

  const toggle = async (name: string) => {
    if (loaded.has(name)) {
      setLoaded((prev) => {
        const next = new Map(prev);
        next.delete(name);
        return next;
      });
      return;
    }
    setLoaded((prev) => new Map(prev).set(name, "loading"));
    let entry: Entry;
    try {
      const body = await rpc.request({ op: "getMetadata", name });
      entry = body.type === "metadata" ? body.records : { failed: "Unexpected response." };
    } catch (err) {
      const message = err instanceof RpcError ? err.message : String(err);
      entry = { failed: `Failed to load metadata: ${message}` };
    }
    // Only apply if the row is still expanded — the user may have collapsed
    // it while the request was in flight.
    setLoaded((prev) => (prev.get(name) === "loading" ? new Map(prev).set(name, entry) : prev));
  };

  return (
    <section>
      <h2>
        Metadata <span class="count">({metadata.length} records)</span>
      </h2>
      <ul class="expandable-list">
        {names.map((name) => {
          const records = loaded.get(name);
          return (
            <li key={name}>
              <button class="row-toggle" onClick={() => void toggle(name)}>
                <span class="chevron">{records !== undefined ? "▾" : "▸"}</span>
                <span class="mono">{name}</span>
              </button>
              {records === "loading" && <p class="dim">Loading…</p>}
              {records !== undefined && records !== "loading" && !Array.isArray(records) && (
                <p class="error-inline">{records.failed}</p>
              )}
              {Array.isArray(records) &&
                records.map((record, i) => (
                  <table class="kv-table" key={i}>
                    <tbody>
                      {Object.entries(record.entries).map(([key, value]) => (
                        <tr key={key}>
                          <td class="mono kv-key">{key}</td>
                          <td class="mono">{value}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ))}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
