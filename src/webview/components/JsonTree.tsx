import { useState } from "preact/hooks";

import type { DecodedValue } from "../../shared/dto";

interface BytesNode {
  type: "bytes";
  length: number;
  previewHex: string;
}

function isBytes(v: DecodedValue): v is BytesNode {
  return (
    typeof v === "object" &&
    v !== null &&
    !Array.isArray(v) &&
    (v as { type?: unknown }).type === "bytes"
  );
}

/** Renders a JSON-safe DecodedValue as a collapsible tree. */
export function JsonTree({ value }: { value: DecodedValue }) {
  return (
    <div class="json-tree">
      <JsonNode value={value} depth={0} />
    </div>
  );
}

function JsonNode({ value, name, depth }: { value: DecodedValue; name?: string; depth: number }) {
  const [expanded, setExpanded] = useState(depth < 2);
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
          <JsonNode key={k} value={v} name={isArray ? undefined : k} depth={depth + 1} />
        ))}
      {expanded && (
        <div class="json-line" style={pad}>
          <span class="dim">{close}</span>
        </div>
      )}
    </div>
  );
}
