import { TempBuffer } from "@mcap/core";
import { loadDecompressHandlers } from "@mcap/support";
import { describe, expect, it } from "vitest";

import { MeteredReadable } from "../../src/extension/meteredReadable";
import { extractNumericAtPath, McapFileSession } from "../../src/extension/readerService";
import type { SessionOptions, TimeSeriesOptions } from "../../src/extension/readerService";
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

function channelId(session: McapFileSession, topic: string): number {
  const ch = session.summary().channels.find((c) => c.topic === topic);
  if (!ch) {
    throw new Error(`no channel ${topic}`);
  }
  return ch.id;
}

const ts = (over: Partial<TimeSeriesOptions> & { channelId: number }): TimeSeriesOptions => ({
  fields: ["value"],
  maxPoints: 1000,
  ...over,
});

const neverAbort = new AbortController().signal;

describe("queryTimeSeries — sampling", () => {
  it("returns every point when maxPoints exceeds message count", async () => {
    const { session } = await openSession(await makeMcap());
    const id = channelId(session, "/fixture/json");
    const out = await session.queryTimeSeries(ts({ channelId: id, fields: ["value"] }), neverAbort);

    expect(out.sampled).toBe(50);
    expect(out.t).toHaveLength(50);
    expect(out.values).toHaveLength(1);
    expect(out.values[0]).toEqual(Array.from({ length: 50 }, (_, i) => i));
    // x is relative seconds from startNs; fixture is 10 Hz.
    expect(out.t[0]).toBeCloseTo(0, 6);
    expect(out.t[49]).toBeCloseTo(4.9, 6);
    expect(out.reachedCap).toBe(false);
    expect(() => JSON.stringify(out)).not.toThrow();
  });

  it("time-bucket downsamples to about maxPoints regardless of frequency", async () => {
    const { session } = await openSession(await makeMcap());
    const id = channelId(session, "/fixture/json");
    const out = await session.queryTimeSeries(
      ts({ channelId: id, fields: ["value"], maxPoints: 10 }),
      neverAbort,
    );
    // One representative decode per time bucket → ~maxPoints points, not 50.
    expect(out.sampled).toBeGreaterThanOrEqual(9);
    expect(out.sampled).toBeLessThanOrEqual(11);
    expect(out.t).toHaveLength(out.sampled);
    expect(out.values[0]).toHaveLength(out.sampled);
    // Values still ascend across the range (first bucket is 0).
    expect(out.values[0]![0]).toBe(0);
    const nums = out.values[0]!.filter((v): v is number => v !== null);
    for (let i = 1; i < nums.length; i++) {
      expect(nums[i]!).toBeGreaterThan(nums[i - 1]!);
    }
  });

  it("strides over chunks when the scan byte budget is exceeded", async () => {
    // 500 messages across many small chunks; a 1-byte budget forces striding.
    const { session } = await openSession(await makeMcap({ messagesPerChannel: 500 }));
    const id = channelId(session, "/fixture/json");
    const strided = await session.queryTimeSeries(
      ts({ channelId: id, fields: ["value"], maxPoints: 1000, maxScanBytes: 1 }),
      neverAbort,
    );
    expect(strided.reachedCap).toBe(true);
    expect(strided.sampled).toBeGreaterThan(0);
    expect(strided.sampled).toBeLessThan(500); // did not read every message
    expect(() => JSON.stringify(strided)).not.toThrow();
  });

  it("respects an explicit start/end window", async () => {
    const { session } = await openSession(await makeMcap());
    const id = channelId(session, "/fixture/json");
    const full = await session.queryTimeSeries(ts({ channelId: id }), neverAbort);
    const startNs = BigInt(full.startNs);
    // Window covering only samples 10..19 (100 ms spacing).
    const windowStart = (startNs + 1_000_000_000n).toString();
    const windowEnd = (startNs + 1_900_000_000n).toString();
    const out = await session.queryTimeSeries(
      ts({ channelId: id, start: windowStart, end: windowEnd, maxPoints: 1000 }),
      neverAbort,
    );
    expect(out.values[0]![0]).toBe(10);
    expect(out.values[0]!.at(-1)).toBe(19);
  });
});

describe("queryTimeSeries — field extraction & decode", () => {
  it("extracts numeric fields (int64 → number) and nulls non-numeric ones", async () => {
    const { session } = await openSession(await makeDecodableMcap(5));
    const id = channelId(session, "/protobuf");
    const out = await session.queryTimeSeries(
      ts({ channelId: id, fields: ["id", "note"], maxPoints: 1000 }),
      neverAbort,
    );
    expect(out.sampled).toBe(5);
    // demo.Msg: id = 1000 + i (int64 → string → number); note = "n<i>" (non-numeric → null).
    expect(out.values[0]).toEqual([1000, 1001, 1002, 1003, 1004]);
    expect(out.values[1]).toEqual([null, null, null, null, null]);
  });

  it("nulls a missing field path without failing the series", async () => {
    const { session } = await openSession(await makeMcap());
    const id = channelId(session, "/fixture/json");
    const out = await session.queryTimeSeries(
      ts({ channelId: id, fields: ["value", "nope.deep"], maxPoints: 1000 }),
      neverAbort,
    );
    expect(out.values[0]![0]).toBe(0);
    expect(out.values[1]!.every((v) => v === null)).toBe(true);
  });
});

describe("queryTimeSeries — safety & errors", () => {
  it("throws NO_INDEX on unindexed files", async () => {
    const { session } = await openSession(await makeMcap({ indexed: false }));
    await expect(
      session.queryTimeSeries(ts({ channelId: 0, fields: ["value"] }), neverAbort),
    ).rejects.toMatchObject({ code: "NO_INDEX" });
  });

  it("cancels via AbortSignal", async () => {
    const { session } = await openSession(await makeMcap());
    const id = channelId(session, "/fixture/json");
    const controller = new AbortController();
    controller.abort();
    await expect(
      session.queryTimeSeries(ts({ channelId: id }), controller.signal),
    ).rejects.toMatchObject({ code: "CANCELLED" });
  });
});

describe("extractNumericAtPath", () => {
  it("walks nested objects and array indices", () => {
    expect(extractNumericAtPath({ a: { b: 3 } }, "a.b")).toBe(3);
    expect(extractNumericAtPath([{ x: 1 }, { x: 2 }], "1.x")).toBe(2);
  });
  it("parses numeric strings (int64 rendered as string)", () => {
    expect(extractNumericAtPath({ v: "1000" }, "v")).toBe(1000);
    expect(extractNumericAtPath({ v: "-2.5" }, "v")).toBe(-2.5);
  });
  it("returns null for non-numeric, missing, bytes, or NaN/Infinity", () => {
    expect(extractNumericAtPath({ v: "hi" }, "v")).toBeNull();
    expect(extractNumericAtPath({ v: true }, "v")).toBeNull();
    expect(extractNumericAtPath({}, "missing")).toBeNull();
    expect(extractNumericAtPath({ a: 1 }, "a.b")).toBeNull(); // descend past a scalar
    expect(extractNumericAtPath({ v: "NaN" }, "v")).toBeNull();
    expect(
      extractNumericAtPath({ d: { type: "bytes", length: 3, previewHex: "00 01 02" } }, "d"),
    ).toBeNull();
    expect(
      extractNumericAtPath({ d: { type: "bytes", length: 3, previewHex: "00 01 02" } }, "d.x"),
    ).toBeNull();
  });
});
