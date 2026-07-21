import { TempBuffer } from "@mcap/core";
import { loadDecompressHandlers } from "@mcap/support";
import { describe, expect, it } from "vitest";

import { McapExplorerError } from "../../src/extension/errors";
import { MeteredReadable } from "../../src/extension/meteredReadable";
import { McapFileSession } from "../../src/extension/readerService";
import type { SessionOptions } from "../../src/extension/readerService";
import {
  FIXTURE_MESSAGE_INTERVAL,
  FIXTURE_START_TIME,
  makeMcap,
  makePatternedBytes,
  truncate,
} from "../fixtures/makeMcap";

async function openSession(bytes: Uint8Array, overrides: Partial<SessionOptions> = {}) {
  const readable = new MeteredReadable(new TempBuffer(bytes));
  const session = await McapFileSession.open(readable, {
    fileName: "fixture.mcap",
    fileSize: bytes.byteLength,
    decompressHandlers: await loadDecompressHandlers(),
    maxChunkUncompressedSize: 256 * 1024 * 1024,
    ...overrides,
  });
  return { session, readable };
}

const noProgress = () => {};
const neverAbort = new AbortController().signal;

describe("McapFileSession — indexed files", () => {
  it("builds a full summary from the index without reading message data", async () => {
    const bytes = await makeMcap({ withExtras: true });
    const { session, readable } = await openSession(bytes);

    const summary = session.summary();
    expect(summary.indexed).toBe(true);
    expect(summary.profile).toBe("test-profile");
    expect(summary.library).toBe("mcap-explorer-fixtures");
    expect(summary.stats?.messageCount).toBe("100");
    expect(summary.stats?.channelCount).toBe(2);
    expect(summary.channels.map((c) => c.topic)).toEqual(["/fixture/binary", "/fixture/json"]);
    for (const channel of summary.channels) {
      expect(channel.messageCount).toBe("50");
      expect(channel.freqHz).toBeCloseTo(10, 0);
    }
    expect(summary.timeRange?.start).toBe(FIXTURE_START_TIME.toString());
    expect(summary.timeRange?.end).toBe(
      (FIXTURE_START_TIME + 49n * FIXTURE_MESSAGE_INTERVAL).toString(),
    );
    expect(summary.attachments).toHaveLength(2);
    expect(summary.metadata).toHaveLength(3);
    expect(summary.chunks.count).toBeGreaterThan(0);

    // Summary reads must not scale with attachment/message payload size: the
    // fixture contains a 10MB attachment that must never be touched.
    expect(readable.bytesRead).toBeLessThan(bytes.byteLength / 2);
    expect(readable.bytesRead).toBeLessThan(1024 * 1024);
  });

  it("every DTO survives JSON.stringify (no bigint leaks)", async () => {
    const bytes = await makeMcap({ withExtras: true });
    const { session } = await openSession(bytes);
    expect(() => JSON.stringify(session.summary())).not.toThrow();
    expect(() => JSON.stringify(session.getSchemaSource(1))).not.toThrow();
    expect(() => JSON.stringify(session.getSchemaSource(2))).not.toThrow();
    const metadata = await session.getMetadata("recording.info");
    expect(() => JSON.stringify(metadata)).not.toThrow();
  });

  it("serves schema source as text for jsonschema and hex for binary", async () => {
    const bytes = await makeMcap();
    const { session } = await openSession(bytes);
    const summary = session.summary();

    const jsonSchema = summary.schemas.find((s) => s.encoding === "jsonschema");
    const binSchema = summary.schemas.find((s) => s.encoding === "protobuf");
    expect(jsonSchema).toBeDefined();
    expect(binSchema).toBeDefined();

    const text = session.getSchemaSource(jsonSchema!.id);
    expect(text.kind).toBe("text");
    expect(text.content).toContain('"type"');

    const hex = session.getSchemaSource(binSchema!.id);
    expect(hex.kind).toBe("hex");
    expect(hex.content).toContain("0a 0c");
  });

  it("reads metadata records by name, preserving duplicates", async () => {
    const bytes = await makeMcap({ withExtras: true });
    const { session } = await openSession(bytes);
    const records = await session.getMetadata("recording.info");
    expect(records).toHaveLength(2);
    expect(records[0]?.entries["scene_id"]).toBe("scene-42");
    expect(records[1]?.entries["segment"]).toBe("2");
  });

  it("extracts attachments byte-for-byte with a small streaming window", async () => {
    const bytes = await makeMcap({ withExtras: true });
    const { session } = await openSession(bytes);
    const big = session.summary().attachments.find((a) => a.name === "calibration.bin");
    expect(big).toBeDefined();

    const received: Uint8Array[] = [];
    const written = await session.extractAttachment(
      big!.index,
      async (chunk) => {
        received.push(chunk.slice());
      },
      undefined,
      64 * 1024, // force many windows
    );

    const expected = makePatternedBytes(10 * 1024 * 1024);
    expect(written).toBe(expected.byteLength);
    const combined = new Uint8Array(written);
    let pos = 0;
    for (const chunk of received) {
      combined.set(chunk, pos);
      pos += chunk.byteLength;
    }
    expect(received.length).toBeGreaterThan(100);
    expect(Buffer.from(combined).equals(Buffer.from(expected))).toBe(true);
  });

  it("extracts the right attachment when name+logTime collide (identity is the index)", async () => {
    const bytes = await makeMcap({ withDuplicateAttachments: true });
    const { session } = await openSession(bytes);
    const dups = session.summary().attachments.filter((a) => a.name === "dup.bin");
    expect(dups).toHaveLength(2);
    expect(dups[0]!.logTime).toBe(dups[1]!.logTime);
    expect(dups[0]!.index).not.toBe(dups[1]!.index);

    const contents: string[] = [];
    for (const dup of dups) {
      const parts: Uint8Array[] = [];
      await session.extractAttachment(dup.index, async (chunk) => {
        parts.push(chunk.slice());
      });
      contents.push(Buffer.concat(parts).toString("utf-8"));
    }
    expect(contents[0]).toBe("first payload");
    expect(contents[1]).toBe("second payload — different bytes");
  });

  it("cancels attachment extraction via AbortSignal", async () => {
    const bytes = await makeMcap({ withExtras: true });
    const { session } = await openSession(bytes);
    const big = session.summary().attachments.find((a) => a.name === "calibration.bin");
    const controller = new AbortController();
    controller.abort();
    await expect(
      session.extractAttachment(big!.index, async () => {}, controller.signal),
    ).rejects.toMatchObject({ code: "CANCELLED" });
  });

  it("reads zstd-compressed files (wasm decompress handlers smoke test)", async () => {
    const { compress } = await import("@foxglove/wasm-zstd");
    // wasm-zstd exposes an emscripten module; make sure it is ready.
    const zstd = await import("@foxglove/wasm-zstd");
    await zstd.isLoaded;
    const bytes = await makeMcap({
      compressChunk: (data) => ({ compression: "zstd", compressedData: compress(data) }),
    });
    const { session } = await openSession(bytes);
    const summary = session.summary();
    expect(summary.indexed).toBe(true);
    expect(summary.chunks.compressions["zstd"]).toBeGreaterThan(0);
    expect(summary.stats?.messageCount).toBe("100");
  });
});

describe("McapFileSession — error paths", () => {
  it("rejects non-MCAP files with NOT_MCAP", async () => {
    const junk = new TextEncoder().encode("this is definitely not an mcap file at all......");
    await expect(openSession(junk)).rejects.toMatchObject({ code: "NOT_MCAP" });
  });

  it("rejects tiny files with NOT_MCAP", async () => {
    await expect(openSession(new Uint8Array([0x89, 0x4d]))).rejects.toMatchObject({
      code: "NOT_MCAP",
    });
  });

  it("treats truncated files as unindexed instead of crashing", async () => {
    const bytes = truncate(await makeMcap(), 0.6);
    const { session } = await openSession(bytes);
    const summary = session.summary();
    expect(summary.indexed).toBe(false);
    expect(summary.profile).toBe("test-profile"); // header is still readable
  });
});

describe("McapFileSession — unindexed scan", () => {
  it("recovers channels, counts and time range via full scan", async () => {
    const bytes = await makeMcap({ indexed: false, withExtras: true });
    const { session } = await openSession(bytes);
    expect(session.summary().indexed).toBe(false);

    const summary = await session.scanUnindexed(noProgress, neverAbort);
    expect(summary.scanned).toBe(true);
    expect(summary.partial).toBeUndefined();
    expect(summary.stats?.messageCount).toBe("100");
    expect(summary.channels.map((c) => c.topic)).toEqual(["/fixture/binary", "/fixture/json"]);
    expect(summary.channels[0]?.messageCount).toBe("50");
    expect(summary.timeRange?.start).toBe(FIXTURE_START_TIME.toString());
    expect(summary.attachments.map((a) => a.name)).toContain("meta.json");
    expect(summary.metadata.map((m) => m.name)).toContain("burner.segment");

    // After the scan, metadata content queries work from captured records.
    const records = await session.getMetadata("recording.info");
    expect(records).toHaveLength(2);
    expect(() => JSON.stringify(summary)).not.toThrow();
  });

  it("marks truncated files as partial but keeps the aggregated prefix", async () => {
    // 500 messages/channel across many 4KB chunks so a 60% cut leaves several
    // complete chunks before the truncation point.
    const bytes = truncate(await makeMcap({ indexed: false, messagesPerChannel: 500 }), 0.6);
    const { session } = await openSession(bytes);
    const summary = await session.scanUnindexed(noProgress, neverAbort);
    expect(summary.scanned).toBe(true);
    expect(summary.partial).toBe(true);
    expect(Number(summary.stats?.messageCount)).toBeGreaterThan(0);
    expect(Number(summary.stats?.messageCount)).toBeLessThan(1000);
  });

  it("supports cancellation via AbortSignal", async () => {
    const bytes = await makeMcap({ indexed: false });
    const { session } = await openSession(bytes);
    const controller = new AbortController();
    controller.abort();
    await expect(session.scanUnindexed(noProgress, controller.signal)).rejects.toMatchObject({
      code: "CANCELLED",
    });
  });

  it("refuses to inflate chunks above the configured limit", async () => {
    const bytes = await makeMcap({ indexed: false, bigMessageBytes: 512 * 1024 });
    const { session } = await openSession(bytes, { maxChunkUncompressedSize: 64 * 1024 });
    await expect(session.scanUnindexed(noProgress, neverAbort)).rejects.toMatchObject({
      code: "CHUNK_TOO_LARGE",
    });
  });

  it("reports progress with monotonically increasing loadedBytes", async () => {
    const bytes = await makeMcap({ indexed: false });
    const { session } = await openSession(bytes);
    const seen: number[] = [];
    await session.scanUnindexed((p) => seen.push(p.loadedBytes), neverAbort);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen[seen.length - 1]).toBe(bytes.byteLength);
    for (let i = 1; i < seen.length; i++) {
      expect(seen[i]!).toBeGreaterThanOrEqual(seen[i - 1]!);
    }
  });

  it("refuses attachment extraction on unindexed files", async () => {
    const bytes = await makeMcap({ indexed: false, withExtras: true });
    const { session } = await openSession(bytes);
    await session.scanUnindexed(noProgress, neverAbort);
    await expect(session.extractAttachment(0, async () => {})).rejects.toBeInstanceOf(
      McapExplorerError,
    );
  });

  it("shares one in-flight scan across concurrent callers", async () => {
    const bytes = await makeMcap({ indexed: false, messagesPerChannel: 500 });
    const { session, readable } = await openSession(bytes);
    const before = readable.bytesRead;
    const [a, b] = await Promise.all([
      session.scanUnindexed(noProgress, neverAbort),
      session.scanUnindexed(noProgress, neverAbort),
    ]);
    expect(a).toBe(b); // same summary object from the shared scan
    // Two concurrent calls must read the file once, not twice.
    expect(readable.bytesRead - before).toBeLessThanOrEqual(bytes.byteLength + 1024);
  });
});
