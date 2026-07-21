import { McapWriter, TempBuffer } from "@mcap/core";

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
