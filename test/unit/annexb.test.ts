import { describe, expect, it } from "vitest";

import { classifyFrame, codecStringFor, normalizeCodec } from "../../src/extension/media/annexb";
import { h264Frame, h265Frame } from "../fixtures/makeMcap";

describe("normalizeCodec", () => {
  it("maps foxglove format strings to the codec union", () => {
    expect(normalizeCodec("h264")).toBe("h264");
    expect(normalizeCodec("AVC")).toBe("h264");
    expect(normalizeCodec("h265")).toBe("h265");
    expect(normalizeCodec("HEVC")).toBe("h265");
    expect(normalizeCodec("vp9")).toBe("vp9");
    expect(normalizeCodec("av1")).toBe("av1");
    expect(normalizeCodec("mjpeg")).toBeUndefined();
  });
});

describe("classifyFrame — H.264", () => {
  it("detects an IDR keyframe vs a P frame", () => {
    expect(classifyFrame(h264Frame(true), "h264").keyframe).toBe(true);
    expect(classifyFrame(h264Frame(false), "h264").keyframe).toBe(false);
  });
});

describe("classifyFrame — H.265", () => {
  it("detects an IDR keyframe vs a TRAIL frame", () => {
    expect(classifyFrame(h265Frame(true), "h265").keyframe).toBe(true);
    expect(classifyFrame(h265Frame(false), "h265").keyframe).toBe(false);
  });

  it("handles 3-byte start codes", () => {
    const idr3 = new Uint8Array([0, 0, 1, (19 << 1) & 0xff, 0x01, 0xaf]);
    const trail3 = new Uint8Array([0, 0, 1, (1 << 1) & 0xff, 0x01, 0xd0]);
    expect(classifyFrame(idr3, "h265").keyframe).toBe(true);
    expect(classifyFrame(trail3, "h265").keyframe).toBe(false);
  });
});

describe("classifyFrame — VP9", () => {
  it("reads the key/inter frame_type bit", () => {
    // frame_marker=10, profile0, show_existing=0, frame_type=0 → key
    expect(classifyFrame(new Uint8Array([0x80]), "vp9").keyframe).toBe(true);
    // frame_type=1 → inter
    expect(classifyFrame(new Uint8Array([0x84]), "vp9").keyframe).toBe(false);
  });
});

describe("codecStringFor", () => {
  it("parses an H.264 SPS → avc1.640028", () => {
    expect(codecStringFor("h264", h264Frame(true))).toBe("avc1.640028");
  });

  it("parses an H.265 SPS → hev1.1.6.L93.B0", () => {
    expect(codecStringFor("h265", h265Frame(true))).toBe("hev1.1.6.L93.B0");
  });

  it("falls back to a default when no parameter sets are present", () => {
    expect(codecStringFor("h264", h264Frame(false))).toBe("avc1.42E01E");
    expect(codecStringFor("h265", h265Frame(false))).toBe("hev1.1.6.L93.B0");
    expect(codecStringFor("vp9")).toMatch(/^vp09\./);
    expect(codecStringFor("av1")).toMatch(/^av01\./);
  });
});
