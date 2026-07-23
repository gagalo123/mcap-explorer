import protobuf from "protobufjs";
import descriptor from "protobufjs/ext/descriptor";
import { describe, expect, it } from "vitest";

import {
  createMediaExtractor,
  isCompressedImageFormat,
  mediaKindForSchema,
} from "../../src/extension/media/extract";

describe("mediaKindForSchema", () => {
  it("classifies known image/video schemas", () => {
    expect(mediaKindForSchema("foxglove.CompressedVideo")).toBe("video");
    expect(mediaKindForSchema("foxglove.CompressedImage")).toBe("image");
    expect(mediaKindForSchema("foxglove.RawImage")).toBe("image");
    expect(mediaKindForSchema("sensor_msgs/msg/CompressedImage")).toBe("image");
    expect(mediaKindForSchema("sensor_msgs/CompressedImage")).toBe("image");
    expect(mediaKindForSchema("sensor_msgs/Image")).toBe("image");
    expect(mediaKindForSchema("sensor_msgs/msg/Image")).toBe("image");
    expect(mediaKindForSchema("safari_sdk.protos.Image")).toBe("image");
    expect(mediaKindForSchema("std_msgs/String")).toBeUndefined();
  });
});

describe("isCompressedImageFormat", () => {
  it("recognizes still-image containers, not raw encodings", () => {
    expect(isCompressedImageFormat("jpeg")).toBe(true);
    expect(isCompressedImageFormat("JPG")).toBe(true);
    expect(isCompressedImageFormat("png")).toBe(true);
    expect(isCompressedImageFormat("rgb8")).toBe(false);
    expect(isCompressedImageFormat("")).toBe(false);
  });
});

/** Build a FileDescriptorSet + message bytes for safari_sdk.protos.Image. */
function safariImageFixture(pixelType: Record<string, number>, data: Uint8Array) {
  const root = protobuf.Root.fromJSON({
    nested: {
      safari_sdk: {
        nested: {
          protos: {
            nested: {
              Image: {
                fields: {
                  cols: { type: "int32", id: 1 },
                  rows: { type: "int32", id: 2 },
                  pixel_type: { type: "PixelType", id: 3 },
                  data: { type: "bytes", id: 4 },
                },
                nested: {
                  PixelType: {
                    fields: {
                      pixel_primitive: { type: "PixelPrimitive", id: 1 },
                      channel_type_1: { type: "ChannelType1", id: 2 },
                      channel_type_3: { type: "ChannelType3", id: 3 },
                      channel_type_4: { type: "ChannelType4", id: 4 },
                      compression: { type: "Compression", id: 5 },
                    },
                    nested: {
                      PixelPrimitive: { values: { UNSPECIFIED: 0, UCHAR8: 1, UINT16: 2 } },
                      ChannelType1: { values: { UNSPECIFIED_1: 0, MONO: 1, DEPTH: 2 } },
                      ChannelType3: { values: { UNSPECIFIED_3: 0, RGB: 1 } },
                      ChannelType4: { values: { UNSPECIFIED_4: 0, RGBA: 1 } },
                      Compression: { values: { NO_COMPRESSION: 0, JPEG: 1, PNG: 2 } },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  });
  const Image = root.lookupType("safari_sdk.protos.Image");
  const fds = root.toDescriptor("proto3");
  const schemaData = new Uint8Array(descriptor.FileDescriptorSet.encode(fds).finish());
  const payload = new Uint8Array(
    Image.encode(Image.create({ cols: 4, rows: 2, pixel_type: pixelType, data })).finish(),
  );
  return { schemaData, payload };
}

describe("createMediaExtractor — safari_sdk.protos.Image", () => {
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);

  it("extracts a JPEG payload as a compressed image", async () => {
    const { schemaData, payload } = safariImageFixture({ compression: 1 }, jpeg);
    const extractor = await createMediaExtractor("protobuf", {
      name: "safari_sdk.protos.Image",
      encoding: "protobuf",
      data: schemaData,
    });
    expect(extractor?.kind).toBe("image-safari");
    const media = extractor!.extract(payload);
    expect(media.format).toBe("jpeg");
    expect(media.width).toBe(4);
    expect(media.height).toBe(2);
    expect(Array.from(media.payload)).toEqual(Array.from(jpeg));
  });

  it("maps an uncompressed RGB image to a raw rgb8 encoding", async () => {
    const rgb = new Uint8Array(4 * 2 * 3).fill(7);
    const { schemaData, payload } = safariImageFixture(
      { compression: 0, channel_type_3: 1, pixel_primitive: 1 },
      rgb,
    );
    const extractor = await createMediaExtractor("protobuf", {
      name: "safari_sdk.protos.Image",
      encoding: "protobuf",
      data: schemaData,
    });
    const media = extractor!.extract(payload);
    expect(media.format).toBe("rgb8");
    expect(media.width).toBe(4);
    expect(media.height).toBe(2);
    expect(isCompressedImageFormat(media.format)).toBe(false);
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
