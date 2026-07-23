import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { TempBuffer } from "@mcap/core";
import { loadDecompressHandlers } from "@mcap/support";
import { afterEach, describe, expect, it } from "vitest";

import { safeAttachmentFileName, streamAttachmentToFile } from "../../src/extension/attachmentIo";
import { MeteredReadable } from "../../src/extension/meteredReadable";
import { McapFileSession } from "../../src/extension/readerService";
import { makeMcap, makePatternedBytes } from "../fixtures/makeMcap";

async function openSession(bytes: Uint8Array) {
  const readable = new MeteredReadable(new TempBuffer(bytes));
  return McapFileSession.open(readable, {
    fileName: "fixture.mcap",
    fileSize: bytes.byteLength,
    decompressHandlers: await loadDecompressHandlers(),
    maxChunkUncompressedSize: 256 * 1024 * 1024,
  });
}

describe("streamAttachmentToFile", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });
  async function tmp() {
    const dir = await mkdtemp(join(tmpdir(), "mcap-attach-"));
    dirs.push(dir);
    return dir;
  }

  it("streams an attachment to disk byte-for-byte and returns the byte count", async () => {
    const bytes = await makeMcap({ withExtras: true });
    const session = await openSession(bytes);
    const big = session.summary().attachments.find((a) => a.name === "calibration.bin")!;
    const target = join(await tmp(), "out.bin");

    const written = await streamAttachmentToFile(
      session,
      big.index,
      target,
      new AbortController().signal,
    );

    const expected = makePatternedBytes(10 * 1024 * 1024);
    expect(written).toBe(expected.byteLength);
    const onDisk = await readFile(target);
    expect(onDisk.equals(Buffer.from(expected))).toBe(true);
  });

  it("rejects with CANCELLED when the signal is already aborted", async () => {
    const bytes = await makeMcap({ withExtras: true });
    const session = await openSession(bytes);
    const big = session.summary().attachments.find((a) => a.name === "calibration.bin")!;
    const controller = new AbortController();
    controller.abort();
    const target = join(await tmp(), "out.bin");

    await expect(
      streamAttachmentToFile(session, big.index, target, controller.signal),
    ).rejects.toMatchObject({ code: "CANCELLED" });
  });
});

describe("safeAttachmentFileName", () => {
  it("keeps a clean basename with its extension", () => {
    expect(safeAttachmentFileName("meta.json", 0)).toBe("meta.json");
  });

  it("strips directory components, keeping only the basename", () => {
    expect(safeAttachmentFileName("a/b/c/frame.png", 3)).toBe("frame.png");
    expect(safeAttachmentFileName("..\\..\\evil.txt", 3)).toBe("evil.txt");
  });

  it("falls back to attachment-<index> when the name is empty or blank", () => {
    expect(safeAttachmentFileName("", 7)).toBe("attachment-7");
    expect(safeAttachmentFileName("   ", 7)).toBe("attachment-7");
  });

  it("never yields a traversal component", () => {
    expect(safeAttachmentFileName("..", 4)).toBe("attachment-4");
    expect(safeAttachmentFileName(".", 4)).toBe("attachment-4");
  });

  it("appends an extension derived from mediaType when the name lacks one", () => {
    expect(safeAttachmentFileName("frame", 1, "image/png")).toBe("frame.png");
    expect(safeAttachmentFileName("", 2, "application/json")).toBe("attachment-2.json");
  });

  it("ignores mediaType parameters when mapping to an extension", () => {
    expect(safeAttachmentFileName("doc", 1, "text/plain; charset=utf-8")).toBe("doc.txt");
  });

  it("leaves the name unextended when the mediaType is unknown or absent", () => {
    expect(safeAttachmentFileName("blob", 1, "application/x-weird")).toBe("blob");
    expect(safeAttachmentFileName("blob", 1)).toBe("blob");
  });

  it("does not double an extension the name already has", () => {
    expect(safeAttachmentFileName("frame.png", 1, "image/png")).toBe("frame.png");
  });
});
