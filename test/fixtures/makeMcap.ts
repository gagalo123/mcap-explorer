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
