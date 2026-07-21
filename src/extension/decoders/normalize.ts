import type { DecodedValue } from "../../shared/dto";

const DEFAULT_MAX_DEPTH = 100;
const DEFAULT_MAX_ARRAY = 1000;
const DEFAULT_BYTES_PREVIEW = 64;

export interface NormalizeOptions {
  maxDepth?: number;
  maxArrayLength?: number;
  bytesPreviewLimit?: number;
}

/**
 * Convert an arbitrary decoded JS value into a JSON-safe DecodedValue:
 * bigint/Long → string, byte arrays → a bytes node, numeric typed arrays →
 * truncated number arrays, NaN/Infinity → string. This is where the
 * "no bigint / no binary crosses the bridge" rule is enforced for message data.
 */
export function normalize(value: unknown, options: NormalizeOptions = {}): DecodedValue {
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const maxArray = options.maxArrayLength ?? DEFAULT_MAX_ARRAY;
  const bytesPreview = options.bytesPreviewLimit ?? DEFAULT_BYTES_PREVIEW;
  return walk(value, maxDepth, maxArray, bytesPreview);
}

function bytesNode(data: Uint8Array, previewLimit: number): DecodedValue {
  const preview = data.subarray(0, previewLimit);
  return {
    type: "bytes",
    length: data.byteLength,
    previewHex: Array.from(preview, (b) => b.toString(16).padStart(2, "0")).join(" "),
  };
}

function walk(value: unknown, depth: number, maxArray: number, bytesPreview: number): DecodedValue {
  if (value === null || value === undefined) {
    return null;
  }
  const t = typeof value;
  if (t === "boolean" || t === "string") {
    return value as boolean | string;
  }
  if (t === "number") {
    const n = value as number;
    return Number.isFinite(n) ? n : String(n); // NaN / Infinity → string
  }
  if (t === "bigint") {
    return (value as bigint).toString();
  }
  if (t === "function" || t === "symbol") {
    return String(value);
  }

  if (depth <= 0) {
    return "…(max depth reached)";
  }

  // Raw byte buffers → bytes node.
  if (value instanceof Uint8Array || value instanceof Int8Array || value instanceof Uint8ClampedArray) {
    return bytesNode(
      new Uint8Array(value.buffer, value.byteOffset, value.byteLength),
      bytesPreview,
    );
  }
  if (value instanceof DataView) {
    return bytesNode(new Uint8Array(value.buffer, value.byteOffset, value.byteLength), bytesPreview);
  }
  // Numeric / bigint typed arrays → truncated arrays of scalars.
  if (ArrayBuffer.isView(value)) {
    const arr = value as unknown as { length: number; [i: number]: number | bigint };
    return truncatedArray(
      arr.length,
      (i) => {
        const el = arr[i];
        if (typeof el === "bigint") {
          return el.toString();
        }
        return typeof el === "number" && Number.isFinite(el) ? el : String(el);
      },
      maxArray,
    );
  }
  if (Array.isArray(value)) {
    return truncatedArray(
      value.length,
      (i) => walk(value[i], depth - 1, maxArray, bytesPreview),
      maxArray,
    );
  }
  // protobufjs Long: { low, high, unsigned } with a toString().
  if (isLong(value)) {
    return (value as { toString(): string }).toString();
  }
  if (t === "object") {
    const obj = value as Record<string, unknown>;
    const out: { [key: string]: DecodedValue } = {};
    for (const key of Object.keys(obj)) {
      out[key] = walk(obj[key], depth - 1, maxArray, bytesPreview);
    }
    return out;
  }
  return String(value);
}

function truncatedArray(
  length: number,
  get: (i: number) => DecodedValue,
  maxArray: number,
): DecodedValue {
  const n = Math.min(length, maxArray);
  const out: DecodedValue[] = [];
  for (let i = 0; i < n; i++) {
    out.push(get(i));
  }
  if (length > maxArray) {
    out.push(`… (${length - maxArray} more of ${length} total)`);
  }
  return out;
}

function isLong(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { low?: unknown }).low === "number" &&
    typeof (value as { high?: unknown }).high === "number" &&
    typeof (value as { unsigned?: unknown }).unsigned === "boolean"
  );
}
