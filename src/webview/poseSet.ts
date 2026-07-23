import type { DecodedValue } from "../shared/dto";
import { isPoseSchema } from "../shared/pose";

/**
 * A single named 3D pose extracted from a decoded message. Positions are in the
 * message's own units (meters for Safari); `quaternion` is [x, y, z, w] and is
 * omitted when the source pose has no orientation.
 */
export interface Pose {
  name: string;
  position: [number, number, number];
  quaternion?: [number, number, number, number];
  parentFrameId?: string;
  active: boolean;
}

export interface PoseSet {
  poses: Pose[];
}

/**
 * Maps a decoded message tree to a schema-agnostic PoseSet the 3D view renders.
 * Returns null when the schema is not a known pose type or the message has no
 * usable poses. Adding a new source schema means adding both its name to
 * POSE_SCHEMAS (shared/pose.ts) and a branch here.
 */
export function extractPoseSet(
  schemaName: string,
  value: DecodedValue | undefined,
): PoseSet | null {
  if (!isPoseSchema(schemaName) || !isObject(value)) {
    return null;
  }
  // safari_sdk.protos.logging.Trackers { repeated Tracker trackers }
  const trackers = (value as Record<string, DecodedValue>).trackers;
  if (!Array.isArray(trackers)) {
    return null;
  }
  const poses: Pose[] = [];
  for (const entry of trackers) {
    if (!isObject(entry)) {
      continue;
    }
    const t = entry as Record<string, DecodedValue>;
    const pose = t.pose;
    if (!isObject(pose)) {
      continue;
    }
    const p = pose as Record<string, DecodedValue>;
    const position = vec3(p.position_meters_xyz);
    if (!position) {
      continue;
    }
    const status = t.status;
    poses.push({
      name: typeof t.name === "string" ? t.name : String(t.name ?? ""),
      position,
      quaternion: vec4(p.orientation_xyzw),
      parentFrameId:
        p.source_frame_id != null && p.source_frame_id !== ""
          ? String(p.source_frame_id)
          : undefined,
      // Protobuf enums decode to their name string ("ACTIVE"); tolerate the
      // numeric form too. Absent status is treated as active.
      active: status === undefined || status === "ACTIVE" || status === 1,
    });
  }
  return poses.length > 0 ? { poses } : null;
}

function isObject(v: DecodedValue | undefined): v is { [k: string]: DecodedValue } {
  return v != null && typeof v === "object" && !Array.isArray(v) && (v as { type?: unknown }).type !== "bytes";
}

/** Coerce a numeric leaf (number or numeric string, as int64s render). */
function num(v: DecodedValue): number | null {
  if (typeof v === "number") {
    return Number.isFinite(v) ? v : null;
  }
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function vec3(v: DecodedValue | undefined): [number, number, number] | undefined {
  if (!Array.isArray(v) || v.length < 3) {
    return undefined;
  }
  const x = num(v[0]!);
  const y = num(v[1]!);
  const z = num(v[2]!);
  return x != null && y != null && z != null ? [x, y, z] : undefined;
}

function vec4(v: DecodedValue | undefined): [number, number, number, number] | undefined {
  if (!Array.isArray(v) || v.length < 4) {
    return undefined;
  }
  const x = num(v[0]!);
  const y = num(v[1]!);
  const z = num(v[2]!);
  const w = num(v[3]!);
  return x != null && y != null && z != null && w != null ? [x, y, z, w] : undefined;
}
