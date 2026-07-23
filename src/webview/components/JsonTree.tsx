import { useEffect, useState } from "preact/hooks";

import type { DecodedValue } from "../../shared/dto";

interface BytesNode {
  type: "bytes";
  length: number;
  previewHex: string;
}

/**
 * Broadcasts a bulk expand/collapse request to every node. `gen` is bumped on
 * each "expand all" / "collapse all" click; each node re-syncs its local state
 * to `expand` when it changes (or when it mounts while `gen > 0`, so the change
 * cascades into subtrees that were unmounted while collapsed).
 */
interface ExpandControl {
  gen: number;
  expand: boolean;
}

function isBytes(v: DecodedValue): v is BytesNode {
  return (
    typeof v === "object" &&
    v !== null &&
    !Array.isArray(v) &&
    (v as { type?: unknown }).type === "bytes"
  );
}

/** Number of child entries if `v` is a collapsible container, else -1. */
function containerEntryCount(v: DecodedValue): number {
  if (typeof v !== "object" || v === null || isBytes(v)) return -1;
  return Array.isArray(v) ? v.length : Object.keys(v).length;
}

/** Renders a JSON-safe DecodedValue as a collapsible tree. */
export function JsonTree({ value }: { value: DecodedValue }) {
  const [control, setControl] = useState<ExpandControl>({ gen: 0, expand: true });
  const hasToggles = containerEntryCount(value) > 0;
  return (
    <div class="json-tree">
      {hasToggles && (
        <div class="json-tree-toolbar">
          <button
            type="button"
            class="json-tree-btn"
            onClick={() => setControl((c) => ({ gen: c.gen + 1, expand: true }))}
          >
            Expand all
          </button>
          <button
            type="button"
            class="json-tree-btn"
            onClick={() => setControl((c) => ({ gen: c.gen + 1, expand: false }))}
          >
            Collapse all
          </button>
        </div>
      )}
      <JsonNode value={value} depth={0} control={control} />
    </div>
  );
}

function JsonNode({
  value,
  name,
  depth,
  control,
}: {
  value: DecodedValue;
  name?: string;
  depth: number;
  control: ExpandControl;
}) {
  const [expanded, setExpanded] = useState(depth < 2);
  useEffect(() => {
    if (control.gen > 0) setExpanded(control.expand);
  }, [control.gen]);
  const key = name !== undefined ? <span class="json-key">{name}: </span> : null;
  const pad = { paddingLeft: `${depth * 1.1}rem` };

  if (value === null) {
    return (
      <div class="json-line" style={pad}>
        {key}
        <span class="json-null">null</span>
      </div>
    );
  }
  if (typeof value === "boolean") {
    return (
      <div class="json-line" style={pad}>
        {key}
        <span class="json-bool">{String(value)}</span>
      </div>
    );
  }
  if (typeof value === "number") {
    return (
      <div class="json-line" style={pad}>
        {key}
        <span class="json-num">{value}</span>
      </div>
    );
  }
  if (typeof value === "string") {
    return (
      <div class="json-line" style={pad}>
        {key}
        <span class="json-str">"{value}"</span>
      </div>
    );
  }
  if (isBytes(value)) {
    const shown = value.previewHex.length === 0 ? 0 : value.previewHex.split(" ").length;
    return (
      <div class="json-line" style={pad}>
        {key}
        <span class="json-bytes">bytes[{value.length}]</span>
        {value.previewHex && (
          <span class="dim mono"> {value.previewHex}{shown < value.length ? " …" : ""}</span>
        )}
      </div>
    );
  }

  const isArray = Array.isArray(value);
  const entries: Array<[string, DecodedValue]> = isArray
    ? (value as DecodedValue[]).map((v, i) => [String(i), v])
    : Object.entries(value as { [k: string]: DecodedValue });
  const open = isArray ? "[" : "{";
  const close = isArray ? "]" : "}";
  const count = `${entries.length} ${isArray ? "items" : "keys"}`;

  return (
    <div class="json-node">
      <div class="json-line json-toggle" style={pad} onClick={() => setExpanded(!expanded)}>
        <span class="chevron">{expanded ? "▾" : "▸"}</span>
        {key}
        <span class="dim">
          {open}
          {expanded ? "" : ` ${count} ${close}`}
        </span>
      </div>
      {expanded &&
        entries.map(([k, v]) => (
          <JsonNode
            key={k}
            value={v}
            name={isArray ? undefined : k}
            depth={depth + 1}
            control={control}
          />
        ))}
      {expanded && (
        <div class="json-line" style={pad}>
          <span class="dim">{close}</span>
        </div>
      )}
    </div>
  );
}
