import { McapWriter, TempBuffer } from "@mcap/core";
import protobuf from "protobufjs";
import descriptor from "protobufjs/ext/descriptor";
import { parse } from "@foxglove/rosmsg";
import { MessageWriter as Ros2Writer } from "@foxglove/rosmsg2-serialization";

export interface FixtureOptions {
  indexed?: boolean;
  compressChunk?: (chunkData: Uint8Array) => { compression: string; compressedData: Uint8Array };
  withExtras?: boolean;
  /** Two attachments with identical name AND logTime but different payloads. */
  withDuplicateAttachments?: boolean;
  /** Approximate size of one big binary message, to manufacture a large chunk. */
  bigMessageBytes?: number;
  messagesPerChannel?: number;
}

export const FIXTURE_START_TIME = 1_700_000_000_000_000_000n;
export const FIXTURE_MESSAGE_INTERVAL = 100_000_000n; // 10 Hz

/**
 * Builds a small MCAP file in memory: a JSON channel and a binary
 * (protobuf-like) channel, optionally with attachments/metadata, optionally
 * unindexed or compressed.
 */
export async function makeMcap(options: FixtureOptions = {}): Promise<Uint8Array> {
  const {
    indexed = true,
    compressChunk,
    withExtras = false,
    withDuplicateAttachments = false,
    bigMessageBytes,
    messagesPerChannel = 50,
  } = options;

  const buffer = new TempBuffer();
  const writer = new McapWriter({
    writable: buffer,
    useChunks: true,
    useStatistics: indexed,
    useChunkIndex: indexed,
    useMessageIndex: indexed,
    useSummaryOffsets: indexed,
    useAttachmentIndex: indexed,
    useMetadataIndex: indexed,
    repeatChannels: indexed,
    repeatSchemas: indexed,
    chunkSize: 4 * 1024,
    compressChunk,
  });

  await writer.start({ profile: "test-profile", library: "mcap-explorer-fixtures" });

  const jsonSchemaId = await writer.registerSchema({
    name: "fixture.JsonMessage",
    encoding: "jsonschema",
    data: new TextEncoder().encode(
      JSON.stringify({ type: "object", properties: { value: { type: "number" } } }),
    ),
  });
  const jsonChannelId = await writer.registerChannel({
    topic: "/fixture/json",
    schemaId: jsonSchemaId,
    messageEncoding: "json",
    metadata: new Map(),
  });

  const binarySchemaId = await writer.registerSchema({
    name: "fixture.BinaryMessage",
    encoding: "protobuf",
    data: new Uint8Array([0x0a, 0x0c, 0x66, 0x69, 0x78, 0x74, 0x75, 0x72, 0x65, 0x00, 0x01, 0x02]),
  });
  const binaryChannelId = await writer.registerChannel({
    topic: "/fixture/binary",
    schemaId: binarySchemaId,
    messageEncoding: "protobuf",
    metadata: new Map(),
  });

  for (let i = 0; i < messagesPerChannel; i++) {
    const logTime = FIXTURE_START_TIME + BigInt(i) * FIXTURE_MESSAGE_INTERVAL;
    await writer.addMessage({
      channelId: jsonChannelId,
      sequence: i,
      logTime,
      publishTime: logTime,
      data: new TextEncoder().encode(JSON.stringify({ value: i })),
    });
    await writer.addMessage({
      channelId: binaryChannelId,
      sequence: i,
      logTime,
      publishTime: logTime,
      data: new Uint8Array([i % 256, (i * 7) % 256, 0xff]),
    });
  }

  if (bigMessageBytes !== undefined) {
    const big = new Uint8Array(bigMessageBytes);
    for (let i = 0; i < big.length; i++) {
      big[i] = i % 251;
    }
    const logTime = FIXTURE_START_TIME + BigInt(messagesPerChannel) * FIXTURE_MESSAGE_INTERVAL;
    await writer.addMessage({
      channelId: binaryChannelId,
      sequence: messagesPerChannel,
      logTime,
      publishTime: logTime,
      data: big,
    });
  }

  if (withExtras) {
    await writer.addAttachment({
      name: "meta.json",
      logTime: FIXTURE_START_TIME,
      createTime: FIXTURE_START_TIME,
      mediaType: "application/json",
      data: new TextEncoder().encode(JSON.stringify({ fixture: true, cameras: ["front"] })),
    });
    await writer.addAttachment({
      name: "calibration.bin",
      logTime: FIXTURE_START_TIME + 1n,
      createTime: FIXTURE_START_TIME + 1n,
      mediaType: "application/octet-stream",
      data: makePatternedBytes(10 * 1024 * 1024),
    });
    await writer.addMetadata({
      name: "recording.info",
      metadata: new Map([
        ["scene_id", "scene-42"],
        ["operator", "fixture-bot"],
      ]),
    });
    await writer.addMetadata({
      name: "recording.info",
      metadata: new Map([["segment", "2"]]),
    });
    await writer.addMetadata({
      name: "burner.segment",
      metadata: new Map([
        ["start_sec", "0"],
        ["end_sec", "5"],
      ]),
    });
  }

  if (withDuplicateAttachments) {
    for (const payload of ["first payload", "second payload — different bytes"]) {
      await writer.addAttachment({
        name: "dup.bin",
        logTime: FIXTURE_START_TIME,
        createTime: FIXTURE_START_TIME,
        mediaType: "application/octet-stream",
        data: new TextEncoder().encode(payload),
      });
    }
  }

  await writer.end();
  return buffer.get();
}

// ---- Synthetic Annex-B frames (Phase 3 video preview) --------------------

function nalH265(type: number, payload: number[]): number[] {
  return [0, 0, 0, 1, (type << 1) & 0xff, 0x01, ...payload];
}

/** An SPS RBSP whose profile_tier_level encodes Main / level 3.1 → hev1.1.6.L93.B0. */
const HEVC_SPS_RBSP = [
  0x01, // sps_video_parameter_set_id=0, max_sub_layers_minus1=0, temporal_id_nesting=1
  0x01, // profile_space=0, tier=0, profile_idc=1
  0x60, 0x00, 0x00, 0x00, // compatibility flags → reversed hex "6"
  0xb0, 0x00, 0x00, 0x00, 0x00, 0x00, // constraint flags → "B0"
  0x5d, // general_level_idc = 93
];

/** One H.265 Annex-B frame: keyframe = VPS+SPS+PPS+IDR, else a TRAIL slice. */
export function h265Frame(keyframe: boolean): Uint8Array {
  if (keyframe) {
    return new Uint8Array([
      ...nalH265(32, [0x0c, 0x01, 0xff]), // VPS
      ...nalH265(33, HEVC_SPS_RBSP), // SPS
      ...nalH265(34, [0xc1, 0x93]), // PPS
      ...nalH265(19, [0xaf, 0x08, 0x46, 0x24]), // IDR_W_RADL
    ]);
  }
  return new Uint8Array(nalH265(1, [0xd0, 0x28, 0x00])); // TRAIL_R (non-key)
}

function nalH264(headerByte: number, payload: number[]): number[] {
  return [0, 0, 0, 1, headerByte, ...payload];
}

/** One H.264 Annex-B frame: keyframe = SPS+PPS+IDR (avc1.640028), else a P slice. */
export function h264Frame(keyframe: boolean): Uint8Array {
  if (keyframe) {
    return new Uint8Array([
      ...nalH264(0x67, [0x64, 0x00, 0x28, 0xac, 0xd9]), // SPS: High / level 4.0
      ...nalH264(0x68, [0xeb, 0xe3, 0xcb]), // PPS
      ...nalH264(0x65, [0x88, 0x84, 0x00]), // IDR slice
    ]);
  }
  return new Uint8Array(nalH264(0x41, [0x9a, 0x00, 0x10])); // non-IDR slice (type 1)
}

/**
 * An indexed MCAP exercising the media-preview paths: a foxglove.CompressedVideo
 * channel with a controlled keyframe cadence, foxglove CompressedImage/RawImage
 * channels, and a ROS 2 sensor_msgs CompressedImage channel.
 */
export async function makeMediaMcap(
  options: { videoCount?: number; gop?: number; codec?: "h264" | "h265"; noKeyframes?: boolean } = {},
): Promise<Uint8Array> {
  const { videoCount = 12, gop = 4, codec = "h265", noKeyframes = false } = options;
  const frameFor = codec === "h264" ? h264Frame : h265Frame;

  const buffer = new TempBuffer();
  const writer = new McapWriter({
    writable: buffer,
    useChunks: true,
    useStatistics: true,
    useChunkIndex: true,
    useMessageIndex: true,
    useSummaryOffsets: true,
    useAttachmentIndex: true,
    useMetadataIndex: true,
    repeatSchemas: true,
    repeatChannels: true,
    chunkSize: 4 * 1024,
  });
  await writer.start({ profile: "", library: "mcap-explorer-fixtures" });

  const root = protobuf.Root.fromJSON({
    nested: {
      foxglove: {
        nested: {
          CompressedVideo: {
            fields: {
              frame_id: { type: "string", id: 2 },
              data: { type: "bytes", id: 3 },
              format: { type: "string", id: 4 },
            },
          },
          CompressedImage: {
            fields: {
              frame_id: { type: "string", id: 2 },
              data: { type: "bytes", id: 3 },
              format: { type: "string", id: 4 },
            },
          },
          RawImage: {
            fields: {
              frame_id: { type: "string", id: 2 },
              width: { type: "uint32", id: 3 },
              height: { type: "uint32", id: 4 },
              encoding: { type: "string", id: 5 },
              step: { type: "uint32", id: 6 },
              data: { type: "bytes", id: 7 },
            },
          },
        },
      },
    },
  });
  const CompressedVideo = root.lookupType("foxglove.CompressedVideo");
  const CompressedImage = root.lookupType("foxglove.CompressedImage");
  const RawImage = root.lookupType("foxglove.RawImage");
  const fds = new Uint8Array(descriptor.FileDescriptorSet.encode(root.toDescriptor("proto3")).finish());

  const videoSchema = await writer.registerSchema({
    name: "foxglove.CompressedVideo",
    encoding: "protobuf",
    data: fds,
  });
  const videoCh = await writer.registerChannel({
    topic: "/camera/front/image_raw/compressed",
    schemaId: videoSchema,
    messageEncoding: "protobuf",
    metadata: new Map(),
  });

  const cImgSchema = await writer.registerSchema({
    name: "foxglove.CompressedImage",
    encoding: "protobuf",
    data: fds,
  });
  const cImgCh = await writer.registerChannel({
    topic: "/camera/front/jpeg",
    schemaId: cImgSchema,
    messageEncoding: "protobuf",
    metadata: new Map(),
  });

  const rawSchema = await writer.registerSchema({
    name: "foxglove.RawImage",
    encoding: "protobuf",
    data: fds,
  });
  const rawCh = await writer.registerChannel({
    topic: "/camera/front/raw",
    schemaId: rawSchema,
    messageEncoding: "protobuf",
    metadata: new Map(),
  });

  const rosDef = "string format\nuint8[] data";
  const rosWriter = new Ros2Writer(parse(rosDef, { ros2: true }));
  const rosSchema = await writer.registerSchema({
    name: "sensor_msgs/msg/CompressedImage",
    encoding: "ros2msg",
    data: enc(rosDef),
  });
  const rosCh = await writer.registerChannel({
    topic: "/ros/image/compressed",
    schemaId: rosSchema,
    messageEncoding: "cdr",
    metadata: new Map(),
  });

  for (let i = 0; i < videoCount; i++) {
    const t = FIXTURE_START_TIME + BigInt(i) * FIXTURE_MESSAGE_INTERVAL;
    const frame = frameFor(!noKeyframes && i % gop === 0);
    await writer.addMessage({
      channelId: videoCh,
      sequence: i,
      logTime: t,
      publishTime: t,
      data: new Uint8Array(
        CompressedVideo.encode(
          CompressedVideo.create({ frame_id: "front", data: frame, format: codec }),
        ).finish(),
      ),
    });
  }

  // A couple of images (jpeg magic bytes; raw 2×2 rgb8).
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0xff, 0xd9]);
  const raw = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  for (let i = 0; i < 3; i++) {
    const t = FIXTURE_START_TIME + BigInt(i) * FIXTURE_MESSAGE_INTERVAL;
    await writer.addMessage({
      channelId: cImgCh,
      sequence: i,
      logTime: t,
      publishTime: t,
      data: new Uint8Array(
        CompressedImage.encode(
          CompressedImage.create({ frame_id: "front", data: jpeg, format: "jpeg" }),
        ).finish(),
      ),
    });
    await writer.addMessage({
      channelId: rawCh,
      sequence: i,
      logTime: t,
      publishTime: t,
      data: new Uint8Array(
        RawImage.encode(
          RawImage.create({
            frame_id: "front",
            width: 2,
            height: 2,
            encoding: "rgb8",
            step: 6,
            data: raw,
          }),
        ).finish(),
      ),
    });
    await writer.addMessage({
      channelId: rosCh,
      sequence: i,
      logTime: t,
      publishTime: t,
      data: rosWriter.writeMessage({ format: "png", data: new Uint8Array([0x89, 0x50, 0x4e, 0x47]) }),
    });
  }

  await writer.end();
  return buffer.get();
}

export function makePatternedBytes(length: number): Uint8Array {
  const data = new Uint8Array(length);
  for (let i = 0; i < length; i++) {
    data[i] = (i * 31 + 7) % 256;
  }
  return data;
}

export function truncate(bytes: Uint8Array, keepFraction: number): Uint8Array {
  return bytes.slice(0, Math.floor(bytes.length * keepFraction));
}

const enc = (s: string) => new TextEncoder().encode(s);

/**
 * An indexed MCAP with one channel per real wire format (json / protobuf /
 * ros2-cdr), each with `count` messages sharing timestamps. Used to test the
 * full decode path end-to-end through queryMessages.
 */
export async function makeDecodableMcap(count = 5): Promise<Uint8Array> {
  const buffer = new TempBuffer();
  const writer = new McapWriter({
    writable: buffer,
    useChunks: true,
    useStatistics: true,
    useChunkIndex: true,
    useMessageIndex: true,
    useSummaryOffsets: true,
    useAttachmentIndex: true,
    useMetadataIndex: true,
    repeatSchemas: true,
    repeatChannels: true,
    chunkSize: 4 * 1024,
  });
  await writer.start({ profile: "", library: "mcap-explorer-fixtures" });

  const jsonSchema = await writer.registerSchema({
    name: "demo.Json",
    encoding: "jsonschema",
    data: enc("{}"),
  });
  const jsonCh = await writer.registerChannel({
    topic: "/json",
    schemaId: jsonSchema,
    messageEncoding: "json",
    metadata: new Map(),
  });

  const root = protobuf.Root.fromJSON({
    nested: {
      demo: {
        nested: {
          Msg: {
            fields: { id: { type: "int64", id: 1 }, note: { type: "string", id: 2 } },
          },
        },
      },
    },
  });
  const Msg = root.lookupType("demo.Msg");
  const fds = descriptor.FileDescriptorSet.encode(root.toDescriptor("proto3")).finish();
  const pbSchema = await writer.registerSchema({
    name: "demo.Msg",
    encoding: "protobuf",
    data: new Uint8Array(fds),
  });
  const pbCh = await writer.registerChannel({
    topic: "/protobuf",
    schemaId: pbSchema,
    messageEncoding: "protobuf",
    metadata: new Map(),
  });

  const rosDef = "int32 x\nstring label";
  const ros2Writer = new Ros2Writer(parse(rosDef, { ros2: true }));
  const rosSchema = await writer.registerSchema({
    name: "demo/Ros",
    encoding: "ros2msg",
    data: enc(rosDef),
  });
  const rosCh = await writer.registerChannel({
    topic: "/ros2",
    schemaId: rosSchema,
    messageEncoding: "cdr",
    metadata: new Map(),
  });

  for (let i = 0; i < count; i++) {
    const t = FIXTURE_START_TIME + BigInt(i) * FIXTURE_MESSAGE_INTERVAL;
    await writer.addMessage({
      channelId: jsonCh,
      sequence: i,
      logTime: t,
      publishTime: t,
      data: enc(JSON.stringify({ value: i })),
    });
    await writer.addMessage({
      channelId: pbCh,
      sequence: i,
      logTime: t,
      publishTime: t,
      data: new Uint8Array(Msg.encode(Msg.create({ id: 1000 + i, note: `n${i}` })).finish()),
    });
    await writer.addMessage({
      channelId: rosCh,
      sequence: i,
      logTime: t,
      publishTime: t,
      data: ros2Writer.writeMessage({ x: i, label: `r${i}` }),
    });
  }

  await writer.end();
  return buffer.get();
}
