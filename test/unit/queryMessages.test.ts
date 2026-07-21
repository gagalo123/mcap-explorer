import { TempBuffer } from "@mcap/core";
import { loadDecompressHandlers } from "@mcap/support";
import { describe, expect, it } from "vitest";

import { MeteredReadable } from "../../src/extension/meteredReadable";
import { McapFileSession } from "../../src/extension/readerService";
import type { QueryMessagesOptions, SessionOptions } from "../../src/extension/readerService";
import { makeDecodableMcap, makeMcap } from "../fixtures/makeMcap";

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

const query = (over: Partial<QueryMessagesOptions>): QueryMessagesOptions => ({
  topics: [],
  limitCount: 100,
  limitBytes: 5_000_000,
  ...over,
});

const neverAbort = new AbortController().signal;

describe("queryMessages — pagination & filtering", () => {
  it("returns decoded json messages for one topic", async () => {
    const { session } = await openSession(await makeMcap());
    const page = await session.queryMessages(query({ topics: ["/fixture/json"] }), neverAbort);
    expect(page.messages).toHaveLength(50);
    expect(page.reachedEnd).toBe(true);
    expect(page.nextCursor).toBeUndefined();
    expect(page.messages[0]).toMatchObject({
      topic: "/fixture/json",
      decoder: "json",
      value: { value: 0 },
    });
    expect(() => JSON.stringify(page)).not.toThrow();
  });

  it("filters to the requested topic only", async () => {
    const { session } = await openSession(await makeMcap());
    const page = await session.queryMessages(query({ topics: ["/fixture/json"] }), neverAbort);
    expect(page.messages.every((m) => m.topic === "/fixture/json")).toBe(true);
  });

  it("paginates by count and resumes from the cursor without gaps or repeats", async () => {
    const { session } = await openSession(await makeMcap());
    const seen: number[] = [];
    let cursor: string | undefined;
    for (let guard = 0; guard < 100; guard++) {
      const page = await session.queryMessages(
        query({ topics: ["/fixture/json"], limitCount: 7, cursor }),
        neverAbort,
      );
      for (const m of page.messages) {
        seen.push((m.value as { value: number }).value);
      }
      if (page.reachedEnd) {
        break;
      }
      cursor = page.nextCursor;
      expect(cursor).toBeDefined();
    }
    expect(seen).toEqual(Array.from({ length: 50 }, (_, i) => i));
  });

  it("supports reverse order", async () => {
    const { session } = await openSession(await makeMcap());
    const page = await session.queryMessages(
      query({ topics: ["/fixture/json"], reverse: true, limitCount: 3 }),
      neverAbort,
    );
    expect(page.messages.map((m) => (m.value as { value: number }).value)).toEqual([49, 48, 47]);
  });

  it("falls back to raw for a channel whose protobuf schema is invalid", async () => {
    const { session } = await openSession(await makeMcap());
    const page = await session.queryMessages(query({ topics: ["/fixture/binary"] }), neverAbort);
    expect(page.messages[0]?.decoder).toBe("raw");
    expect(page.messages[0]?.value).toMatchObject({ type: "bytes" });
  });
});

describe("queryMessages — real protobuf & ros2 decode", () => {
  it("decodes protobuf (int64 → string) and ros2 cdr end-to-end", async () => {
    const { session } = await openSession(await makeDecodableMcap(5));

    const pb = await session.queryMessages(query({ topics: ["/protobuf"] }), neverAbort);
    expect(pb.messages).toHaveLength(5);
    expect(pb.messages[0]).toMatchObject({ decoder: "protobuf", value: { id: "1000", note: "n0" } });

    const ros = await session.queryMessages(query({ topics: ["/ros2"] }), neverAbort);
    expect(ros.messages).toHaveLength(5);
    expect(ros.messages[0]).toMatchObject({ decoder: "ros2", value: { x: 0, label: "r0" } });

    const json = await session.queryMessages(query({ topics: ["/json"] }), neverAbort);
    expect(json.messages[2]).toMatchObject({ decoder: "json", value: { value: 2 } });
  });
});

describe("queryMessages — safety & errors", () => {
  it("throws NO_INDEX on unindexed files", async () => {
    const { session } = await openSession(await makeMcap({ indexed: false }));
    await expect(
      session.queryMessages(query({ topics: ["/fixture/json"] }), neverAbort),
    ).rejects.toMatchObject({ code: "NO_INDEX" });
  });

  it("refuses queries hitting an oversized chunk", async () => {
    const { session } = await openSession(await makeMcap({ bigMessageBytes: 512 * 1024 }), {
      maxChunkUncompressedSize: 64 * 1024,
    });
    await expect(
      session.queryMessages(query({ topics: ["/fixture/binary"] }), neverAbort),
    ).rejects.toMatchObject({ code: "CHUNK_TOO_LARGE" });
  });

  it("cancels via AbortSignal", async () => {
    const { session } = await openSession(await makeMcap());
    const controller = new AbortController();
    controller.abort();
    await expect(
      session.queryMessages(query({ topics: ["/fixture/json"] }), controller.signal),
    ).rejects.toMatchObject({ code: "CANCELLED" });
  });
});
