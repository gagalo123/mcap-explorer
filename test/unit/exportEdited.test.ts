import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { TempBuffer } from "@mcap/core";
import { loadDecompressHandlers } from "@mcap/support";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { McapExplorerError } from "../../src/extension/errors";
import { MeteredReadable } from "../../src/extension/meteredReadable";
import { McapFileSession } from "../../src/extension/readerService";
import type { SessionOptions } from "../../src/extension/readerService";
import type { EditSpec } from "../../src/shared/dto";
import { FIXTURE_MESSAGE_INTERVAL, FIXTURE_START_TIME, makeMcap } from "../fixtures/makeMcap";

async function openSession(bytes: Uint8Array, overrides: Partial<SessionOptions> = {}) {
  const readable = new MeteredReadable(new TempBuffer(bytes));
  return McapFileSession.open(readable, {
    fileName: "fixture.mcap",
    fileSize: bytes.byteLength,
    decompressHandlers: await loadDecompressHandlers(),
    maxChunkUncompressedSize: 256 * 1024 * 1024,
    ...overrides,
  });
}

const neverAbort = new AbortController().signal;

const emptySpec = (): EditSpec => ({
  dropTopics: [],
  renameTopics: {},
  metadata: { remove: [], upsert: [] },
  attachments: { removeIndexes: [], rename: [], add: [] },
});

/** Rewrite `session` through exportEdited and reopen the result. */
async function roundTrip(session: McapFileSession, spec: EditSpec): Promise<McapFileSession> {
  const out = new TempBuffer();
  await session.exportEdited(spec, out, undefined, neverAbort);
  return openSession(out.get());
}

describe("exportEdited — read-through rewrite", () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "mcap-export-"));
  });
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("copies an unedited file faithfully and stays indexed", async () => {
    const session = await openSession(await makeMcap({ withExtras: true }));
    const result = await roundTrip(session, emptySpec());
    const summary = result.summary();

    expect(summary.indexed).toBe(true);
    expect(summary.stats?.messageCount).toBe("100"); // 2 topics × 50
    expect(new Set(summary.channels.map((c) => c.topic))).toEqual(
      new Set(["/fixture/json", "/fixture/binary"]),
    );
    expect(summary.attachments).toHaveLength(2);
    expect(new Set(summary.metadata.map((m) => m.name))).toEqual(
      new Set(["recording.info", "burner.segment"]),
    );
  });

  it("drops topics and crops to a time range", async () => {
    const session = await openSession(await makeMcap());
    const spec = emptySpec();
    spec.dropTopics = ["/fixture/binary"];
    // Keep messages i=0..9 of the json topic (10 messages, inclusive end).
    spec.timeRange = {
      start: FIXTURE_START_TIME.toString(),
      end: (FIXTURE_START_TIME + 9n * FIXTURE_MESSAGE_INTERVAL).toString(),
    };
    const result = await roundTrip(session, spec);
    const summary = result.summary();

    expect(summary.channels.map((c) => c.topic)).toEqual(["/fixture/json"]);
    expect(summary.stats?.messageCount).toBe("10");
  });

  it("renames a topic and its messages remain queryable", async () => {
    const session = await openSession(await makeMcap());
    const spec = emptySpec();
    spec.renameTopics = { "/fixture/json": "/renamed/json" };
    const result = await roundTrip(session, spec);

    expect(new Set(result.summary().channels.map((c) => c.topic))).toEqual(
      new Set(["/renamed/json", "/fixture/binary"]),
    );
    const page = await result.queryMessages(
      { topics: ["/renamed/json"], limitCount: 100, limitBytes: 5_000_000 },
      neverAbort,
    );
    expect(page.messages).toHaveLength(50);
    expect(page.messages[0]).toMatchObject({ topic: "/renamed/json", value: { value: 0 } });
  });

  it("removes, replaces and adds metadata records", async () => {
    const session = await openSession(await makeMcap({ withExtras: true }));
    const spec = emptySpec();
    spec.metadata.remove = ["burner.segment"];
    spec.metadata.upsert = [
      { name: "recording.info", entries: { edited: "yes" } },
      { name: "extra.note", entries: { hello: "world" } },
    ];
    const result = await roundTrip(session, spec);

    expect(new Set(result.summary().metadata.map((m) => m.name))).toEqual(
      new Set(["recording.info", "extra.note"]),
    );
    // recording.info's two source records collapse into the single upsert.
    const recording = await result.getMetadata("recording.info");
    expect(recording).toEqual([{ name: "recording.info", entries: { edited: "yes" } }]);
    const extra = await result.getMetadata("extra.note");
    expect(extra).toEqual([{ name: "extra.note", entries: { hello: "world" } }]);
    expect(await result.getMetadata("burner.segment")).toEqual([]);
  });

  it("removes, renames and adds attachments", async () => {
    const session = await openSession(await makeMcap({ withExtras: true }));
    const addPath = join(tmp, "added.txt");
    await writeFile(addPath, "hello attachment");

    const spec = emptySpec();
    spec.attachments.removeIndexes = [1]; // drop calibration.bin
    spec.attachments.rename = [{ index: 0, name: "renamed.json" }]; // meta.json → renamed.json
    spec.attachments.add = [{ sourcePath: addPath, name: "added.txt", mediaType: "text/plain" }];
    const result = await roundTrip(session, spec);
    const summary = result.summary();

    expect(summary.attachments).toHaveLength(2);
    const names = new Set(summary.attachments.map((a) => a.name));
    expect(names).toEqual(new Set(["renamed.json", "added.txt"]));
    const added = summary.attachments.find((a) => a.name === "added.txt")!;
    expect(added.dataSize).toBe("16"); // "hello attachment".length
    expect(added.mediaType).toBe("text/plain");
  });

  it("reports progress and honors cancellation", async () => {
    const session = await openSession(await makeMcap());
    const progress: number[] = [];
    const out = new TempBuffer();
    await session.exportEdited(emptySpec(), out, (done) => progress.push(done), neverAbort);
    expect(progress.at(-1)).toBe(100);

    const aborted = new AbortController();
    aborted.abort();
    await expect(
      session.exportEdited(emptySpec(), new TempBuffer(), undefined, aborted.signal),
    ).rejects.toThrow(McapExplorerError);
  });

  it("refuses to export an unindexed file", async () => {
    const session = await openSession(await makeMcap({ indexed: false }));
    await expect(session.exportEdited(emptySpec(), new TempBuffer())).rejects.toMatchObject({
      code: "NO_INDEX",
    });
  });
});
