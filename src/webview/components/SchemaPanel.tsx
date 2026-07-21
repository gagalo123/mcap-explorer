import { useState } from "preact/hooks";

import type { SchemaDto, SchemaSourceDto } from "../../shared/dto";
import { formatBytes } from "../../shared/time";
import type { RpcClient } from "../rpcClient";
import { RpcError } from "../rpcClient";

type Entry = SchemaSourceDto | "loading" | { failed: string };

export function SchemaPanel({ schemas, rpc }: { schemas: SchemaDto[]; rpc: RpcClient }) {
  const [sources, setSources] = useState<ReadonlyMap<number, Entry>>(new Map());

  if (schemas.length === 0) {
    return (
      <section>
        <h2>Schemas</h2>
        <p class="empty">No schemas.</p>
      </section>
    );
  }

  const toggle = async (schemaId: number) => {
    if (sources.has(schemaId)) {
      setSources((prev) => {
        const next = new Map(prev);
        next.delete(schemaId);
        return next;
      });
      return;
    }
    setSources((prev) => new Map(prev).set(schemaId, "loading"));
    let entry: Entry;
    try {
      const body = await rpc.request({ op: "getSchemaSource", schemaId });
      entry = body.type === "schemaSource" ? body.source : { failed: "Unexpected response." };
    } catch (err) {
      const message = err instanceof RpcError ? err.message : String(err);
      entry = { failed: `Failed to load schema: ${message}` };
    }
    // Only apply if the row is still expanded (not collapsed mid-flight).
    setSources((prev) =>
      prev.get(schemaId) === "loading" ? new Map(prev).set(schemaId, entry) : prev,
    );
  };

  return (
    <section>
      <h2>
        Schemas <span class="count">({schemas.length})</span>
      </h2>
      <ul class="expandable-list">
        {schemas.map((schema) => {
          const source = sources.get(schema.id);
          return (
            <li key={schema.id}>
              <button class="row-toggle" onClick={() => void toggle(schema.id)}>
                <span class="chevron">{source !== undefined ? "▾" : "▸"}</span>
                <span class="mono">{schema.name}</span>
                <span class="dim">
                  {schema.encoding} · {formatBytes(schema.dataLength)}
                </span>
              </button>
              {source === "loading" && <p class="dim">Loading…</p>}
              {source !== undefined && source !== "loading" && "failed" in source && (
                <p class="error-inline">{source.failed}</p>
              )}
              {source !== undefined && source !== "loading" && "content" in source && (
                <pre class={source.kind === "hex" ? "hexdump" : "schema-source"}>
                  {source.content}
                  {source.truncated
                    ? `\n… truncated (${formatBytes(source.totalLength)} total)`
                    : ""}
                </pre>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
