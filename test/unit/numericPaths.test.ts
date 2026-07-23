import { describe, expect, it } from "vitest";

import { numericFieldPaths } from "../../src/webview/numericPaths";

describe("numericFieldPaths", () => {
  it("collects numeric scalar leaves as dotted paths", () => {
    expect(
      numericFieldPaths({
        angular_velocity: { x: 1, y: 2, z: 3 },
        header: { stamp: 0 },
      }),
    ).toEqual(["angular_velocity.x", "angular_velocity.y", "angular_velocity.z", "header.stamp"]);
  });

  it("skips bytes nodes, booleans and non-numeric strings; keeps numeric strings", () => {
    expect(
      numericFieldPaths({
        data: { type: "bytes", length: 3, previewHex: "00 01 02" },
        ok: true,
        name: "hello",
        n: 3,
        big: "1000", // int64 → numeric string
      }),
    ).toEqual(["n", "big"]);
  });

  it("indexes array elements and caps very long numeric arrays", () => {
    expect(numericFieldPaths({ v: [1, 2, 3] })).toEqual(["v.0", "v.1", "v.2"]);
    const long = numericFieldPaths({ v: Array.from({ length: 40 }, () => 1) });
    expect(long).toHaveLength(16);
    expect(long[0]).toBe("v.0");
    expect(long.at(-1)).toBe("v.15");
  });

  it("handles a bare top-level scalar (empty path) and ignores non-numeric roots", () => {
    expect(numericFieldPaths(5)).toEqual([""]);
    expect(numericFieldPaths("hi")).toEqual([]);
    expect(numericFieldPaths(null)).toEqual([]);
  });

  it("caps total paths at 200", () => {
    const obj: Record<string, number> = {};
    for (let i = 0; i < 250; i++) {
      obj[`k${i}`] = i;
    }
    expect(numericFieldPaths(obj)).toHaveLength(200);
  });
});
