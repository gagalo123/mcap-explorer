import { describe, expect, it } from "vitest";

import type { DecodedValue } from "../../src/shared/dto";
import { extractPoseSet } from "../../src/webview/poseSet";

const SCHEMA = "safari_sdk.protos.logging.Trackers";

/** Shape a decoded Trackers message the way the protobuf decoder produces it. */
function trackers(entries: DecodedValue[]): DecodedValue {
  return { trackers: entries };
}

describe("extractPoseSet", () => {
  it("extracts named poses with position, orientation, parent frame and status", () => {
    const value = trackers([
      {
        name: "pelvis",
        pose: {
          position_meters_xyz: [0.25, 0.15, 0.045],
          orientation_xyzw: [-0.18, 0.19, 0.71, 0.65],
          source_frame_id: "world",
        },
        status: "ACTIVE",
      },
      {
        name: "spine1",
        pose: { position_meters_xyz: [-0.017, -0.0026, 0.1], source_frame_id: "pelvis" },
        status: "ACTIVE",
      },
    ]);
    const set = extractPoseSet(SCHEMA, value);
    expect(set).not.toBeNull();
    expect(set!.poses).toHaveLength(2);

    const pelvis = set!.poses[0]!;
    expect(pelvis.name).toBe("pelvis");
    expect(pelvis.position).toEqual([0.25, 0.15, 0.045]);
    expect(pelvis.quaternion).toEqual([-0.18, 0.19, 0.71, 0.65]);
    expect(pelvis.parentFrameId).toBe("world");
    expect(pelvis.active).toBe(true);

    const spine = set!.poses[1]!;
    expect(spine.quaternion).toBeUndefined(); // no orientation → omitted
    expect(spine.parentFrameId).toBe("pelvis");
  });

  it("treats a non-ACTIVE status as inactive and tolerates numeric enums", () => {
    const set = extractPoseSet(
      SCHEMA,
      trackers([
        { name: "a", pose: { position_meters_xyz: [1, 2, 3] }, status: "INACTIVE" },
        { name: "b", pose: { position_meters_xyz: [4, 5, 6] }, status: 1 },
      ]),
    );
    expect(set!.poses[0]!.active).toBe(false);
    expect(set!.poses[1]!.active).toBe(true);
  });

  it("skips entries without a valid 3-vector position", () => {
    const set = extractPoseSet(
      SCHEMA,
      trackers([
        { name: "ok", pose: { position_meters_xyz: [1, 2, 3] } },
        { name: "short", pose: { position_meters_xyz: [1, 2] } },
        { name: "nopose" },
      ]),
    );
    expect(set!.poses.map((p) => p.name)).toEqual(["ok"]);
  });

  it("returns null for an unknown schema or an empty/invalid tree", () => {
    expect(extractPoseSet("some.other.Schema", trackers([]))).toBeNull();
    expect(extractPoseSet(SCHEMA, undefined)).toBeNull();
    expect(extractPoseSet(SCHEMA, { trackers: [] })).toBeNull();
    expect(extractPoseSet(SCHEMA, { notTrackers: 1 })).toBeNull();
  });
});
