import { describe, expect, it } from "vitest";

import { createMediaExtractor, mediaKindForSchema } from "../../src/extension/media/extract";

describe("mediaKindForSchema", () => {
  it("classifies known image/video schemas", () => {
    expect(mediaKindForSchema("foxglove.CompressedVideo")).toBe("video");
    expect(mediaKindForSchema("foxglove.CompressedImage")).toBe("image");
    expect(mediaKindForSchema("foxglove.RawImage")).toBe("image");
    expect(mediaKindForSchema("sensor_msgs/msg/CompressedImage")).toBe("image");
    expect(mediaKindForSchema("sensor_msgs/CompressedImage")).toBe("image");
    expect(mediaKindForSchema("sensor_msgs/Image")).toBe("image");
    expect(mediaKindForSchema("sensor_msgs/msg/Image")).toBe("image");
    expect(mediaKindForSchema("std_msgs/String")).toBeUndefined();
  });
});

describe("createMediaExtractor", () => {
  it("returns null without a schema", async () => {
    expect(await createMediaExtractor("protobuf", undefined)).toBeNull();
  });

  it("returns null for a non-media schema", async () => {
    const extractor = await createMediaExtractor("protobuf", {
      name: "foo.Bar",
      encoding: "protobuf",
      data: new Uint8Array(),
    });
    expect(extractor).toBeNull();
  });
});
