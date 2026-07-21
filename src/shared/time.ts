/**
 * Timestamps cross the extension↔webview bridge as decimal nanosecond strings:
 * postMessage serialization throws on bigint, and JS numbers lose precision
 * above 2^53. All conversions live here so no other module touches bigint I/O.
 */
export type TimeNs = string;

export function toTimeNs(value: bigint): TimeNs {
  return value.toString(10);
}

export function fromTimeNs(value: TimeNs): bigint {
  return BigInt(value);
}

const NS_PER_SEC = 1_000_000_000n;
const NS_PER_MS = 1_000_000n;

/** Format a nanosecond timestamp as a UTC ISO-8601 string with millisecond precision. */
export function formatTimestamp(time: TimeNs): string {
  const ns = fromTimeNs(time);
  if (ns === 0n) {
    return "n/a";
  }
  const ms = Number(ns / NS_PER_MS);
  return new Date(ms).toISOString();
}

/** Format a nanosecond duration as a compact human-readable string, e.g. "1h 2m 3.456s". */
export function formatDuration(durationNs: bigint): string {
  if (durationNs < 0n) {
    return "n/a";
  }
  const totalMs = Number(durationNs / NS_PER_MS);
  const hours = Math.floor(totalMs / 3_600_000);
  const minutes = Math.floor((totalMs % 3_600_000) / 60_000);
  const seconds = (totalMs % 60_000) / 1000;
  const parts: string[] = [];
  if (hours > 0) {
    parts.push(`${hours}h`);
  }
  if (minutes > 0) {
    parts.push(`${minutes}m`);
  }
  parts.push(`${seconds.toFixed(3)}s`);
  return parts.join(" ");
}

/** Duration between two nanosecond timestamps, clamped at zero. */
export function durationBetween(start: TimeNs, end: TimeNs): bigint {
  const diff = fromTimeNs(end) - fromTimeNs(start);
  return diff > 0n ? diff : 0n;
}

/** Messages per second over a nanosecond time span; undefined when the span is empty. */
export function frequencyHz(messageCount: bigint, durationNs: bigint): number | undefined {
  if (durationNs <= 0n || messageCount <= 0n) {
    return undefined;
  }
  const seconds = Number(durationNs) / Number(NS_PER_SEC);
  return Number(messageCount) / seconds;
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) {
    return "n/a";
  }
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let value = bytes;
  let unit = "B";
  for (const next of units) {
    if (value < 1024) {
      break;
    }
    value /= 1024;
    unit = next;
  }
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${unit}`;
}
