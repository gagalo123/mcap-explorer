import type { DecodedValue } from "../shared/dto";

const MAX_PATHS = 200;
/** Cap how many elements of a numeric array become individual plot fields. */
const MAX_ARRAY_ELEMS = 16;

/**
 * Collects dotted paths to numeric scalar leaves in a decoded message so the
 * plot view can offer them as plottable fields. Numbers and numeric strings
 * (int64/uint64 render as strings) count; booleans, bytes nodes and
 * non-numeric strings are skipped. Array elements get an indexed path (`a.0`),
 * capped so a large numeric array doesn't explode into hundreds of fields. A
 * bare top-level scalar yields the empty path "" (whole-message value).
 */
export function numericFieldPaths(value: DecodedValue): string[] {
  const out: string[] = [];
  walk(value, "", out);
  return out.slice(0, MAX_PATHS);
}

function isNumeric(v: DecodedValue): boolean {
  if (typeof v === "number") {
    return Number.isFinite(v);
  }
  if (typeof v === "string") {
    const n = Number(v);
    return v.trim() !== "" && Number.isFinite(n);
  }
  return false;
}

function walk(v: DecodedValue, prefix: string, out: string[]): void {
  if (out.length >= MAX_PATHS) {
    return;
  }
  if (v === null || typeof v !== "object") {
    if (isNumeric(v)) {
      out.push(prefix);
    }
    return;
  }
  if ((v as { type?: unknown }).type === "bytes") {
    return;
  }
  if (Array.isArray(v)) {
    const n = Math.min(v.length, MAX_ARRAY_ELEMS);
    for (let i = 0; i < n && out.length < MAX_PATHS; i++) {
      walk(v[i]!, prefix ? `${prefix}.${i}` : String(i), out);
    }
    return;
  }
  for (const key of Object.keys(v as { [k: string]: DecodedValue })) {
    if (out.length >= MAX_PATHS) {
      return;
    }
    walk((v as { [k: string]: DecodedValue })[key]!, prefix ? `${prefix}.${key}` : key, out);
  }
}
