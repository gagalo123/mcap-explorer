import { TempBuffer } from "@mcap/core";
import { loadDecompressHandlers } from "@mcap/support";
import { describe, expect, it } from "vitest";

import { MeteredReadable } from "../../src/extension/meteredReadable";
import { McapFileSession } from "../../src/extension/readerService";
import type { SessionOptions } from "../../src/extension/readerService";
import type { ChannelDto } from "../../src/shared/dto";
import {
  FIXTURE_MESSAGE_INTERVAL,
  FIXTURE_START_TIME,
  h265Frame,
  makeMcap,
  makeMediaMcap,
} from "../fixtures/makeMcap";

const VIDEO_TOPIC = "/camera/front/image_raw/compressed";
const neverAbort = new AbortController().signal;

async function openSession(bytes: Uint8Array, overrides: Partial<SessionOptions> = {}) {
  const readable = new MeteredReadable(new TempBuffer(bytes));
  const session = await McapFileSession.open(readable, {
    fileName: "media.mcap",
    fileSize: bytes.byteLength,
    decompressHandlers: await loadDecompressHandlers(),
    maxChunkUncompressedSize: 256 * 1024 * 1024,
    ...overrides,
  });
  return { session, readable };
}

function channel(session: McapFileSession, topic: string): ChannelDto {
  const ch = session.summary().channels.find((c) => c.topic === topic);
  if (!ch) {
    throw new Error(`no channel ${topic}`);
  }
  return ch;
}

const at = (i: number): string => (FIXTURE_START_TIME + BigInt(i) * FIXTURE_MESSAGE_INTERVAL).toString();

describe("summary preview flags", () => {
  it("marks previewable channels by schema", async () => {
    const { session } = await openSession(await makeMediaMcap());
    const byTopic = Object.fromEntries(session.summary().channels.map((c) => [c.topic, c.preview]));
    expect(byTopic[VIDEO_TOPIC]).toBe("video");
    expect(byTopic["/camera/front/jpeg"]).toBe("image");
    expect(byTopic["/camera/front/raw"]).toBe("image");
    expect(byTopic["/ros/image/compressed"]).toBe("image");
  });
});

describe("getFrameWindow — seek", () => {
  it("seeks to the preceding keyframe and returns a decodable window", async () => {
    const { session } = await openSession(await makeMediaMcap({ videoCount: 12, gop: 4, codec: "h265" }));
    const ch = channel(session, VIDEO_TOPIC);
    const res = await session.getFrameWindow(
      { channelId: ch.id, anchor: { logTime: at(6), sequence: 6 }, count: 8, needKeyframe: true },
      neverAbort,
    );
    expect(res.codec).toBe("h265");
    expect(res.codecString).toBe("hev1.1.6.L93.B0");
    expect(res.keyframeIndex).toBe(0);
    expect(res.frames[0]?.keyframe).toBe(true);
    expect(res.frames[0]?.sequence).toBe(4); // keyframe before anchor 6
    expect(res.frames.some((f) => f.sequence === 6)).toBe(true); // anchor included
    expect(() => JSON.stringify(res)).not.toThrow();
  });

  it("round-trips frame bytes through base64", async () => {
    const { session } = await openSession(await makeMediaMcap({ videoCount: 4, gop: 4, codec: "h265" }));
    const ch = channel(session, VIDEO_TOPIC);
    const res = await session.getFrameWindow(
      { channelId: ch.id, anchor: { logTime: at(0), sequence: 0 }, count: 1, needKeyframe: true },
      neverAbort,
    );
    const decoded = new Uint8Array(Buffer.from(res.frames[0]!.dataBase64, "base64"));
    expect(decoded).toEqual(h265Frame(true));
  });

  it("throws NO_KEYFRAME_IN_RANGE when no keyframe precedes the anchor", async () => {
    const { session } = await openSession(await makeMediaMcap({ videoCount: 6, noKeyframes: true }));
    const ch = channel(session, VIDEO_TOPIC);
    await expect(
      session.getFrameWindow(
        { channelId: ch.id, anchor: { logTime: at(5), sequence: 5 }, count: 4, needKeyframe: true },
        neverAbort,
      ),
    ).rejects.toMatchObject({ code: "NO_KEYFRAME_IN_RANGE" });
  });
});

describe("getFrameWindow — pagination & continuation", () => {
  it("paginates via nextAnchor without gaps or repeats", async () => {
    const { session } = await openSession(await makeMediaMcap({ videoCount: 12, gop: 4 }));
    const ch = channel(session, VIDEO_TOPIC);
    const first = await session.getFrameWindow(
      { channelId: ch.id, anchor: { logTime: at(0), sequence: 0 }, count: 5, needKeyframe: true },
      neverAbort,
    );
    expect(first.reachedEnd).toBe(false);
    expect(first.nextAnchor).toBeDefined();
    const second = await session.getFrameWindow(
      { channelId: ch.id, anchor: first.nextAnchor!, count: 100, needKeyframe: false },
      neverAbort,
    );
    expect(second.reachedEnd).toBe(true);
    const seqs = [...first.frames.map((f) => f.sequence), ...second.frames.map((f) => f.sequence)];
    expect(seqs).toEqual(Array.from({ length: 12 }, (_, i) => i));
  });
});

describe("getImageFrame", () => {
  it("returns a compressed (jpeg) image frame", async () => {
    const { session } = await openSession(await makeMediaMcap());
    const ch = channel(session, "/camera/front/jpeg");
    const img = await session.getImageFrame(
      { channelId: ch.id, target: { logTime: at(0), sequence: 0 } },
      neverAbort,
    );
    expect(img.kind).toBe("compressed");
    expect(img.format).toBe("jpeg");
    expect(Buffer.from(img.dataBase64, "base64")[0]).toBe(0xff); // JPEG SOI
    expect(() => JSON.stringify(img)).not.toThrow();
  });

  it("returns a raw rgb8 image frame with dimensions", async () => {
    const { session } = await openSession(await makeMediaMcap());
    const ch = channel(session, "/camera/front/raw");
    const img = await session.getImageFrame(
      { channelId: ch.id, target: { logTime: at(0), sequence: 0 } },
      neverAbort,
    );
    expect(img).toMatchObject({ kind: "raw", format: "rgb8", width: 2, height: 2, step: 6 });
    expect(Buffer.from(img.dataBase64, "base64").length).toBe(12);
  });

  it("extracts a ROS 2 CompressedImage", async () => {
    const { session } = await openSession(await makeMediaMcap());
    const ch = channel(session, "/ros/image/compressed");
    const img = await session.getImageFrame(
      { channelId: ch.id, target: { logTime: at(0), sequence: 0 } },
      neverAbort,
    );
    expect(img).toMatchObject({ kind: "compressed", format: "png" });
  });
});

describe("getFrameWindow / getImageFrame — errors", () => {
  it("rejects getImageFrame on a non-previewable channel", async () => {
    const { session } = await openSession(await makeMcap());
    const ch = channel(session, "/fixture/json");
    await expect(
      session.getImageFrame({ channelId: ch.id, target: { logTime: at(0), sequence: 0 } }, neverAbort),
    ).rejects.toMatchObject({ code: "NOT_PREVIEWABLE" });
  });

  it("rejects getFrameWindow on an image channel", async () => {
    const { session } = await openSession(await makeMediaMcap());
    const ch = channel(session, "/camera/front/jpeg");
    await expect(
      session.getFrameWindow(
        { channelId: ch.id, anchor: { logTime: at(0), sequence: 0 }, count: 1, needKeyframe: true },
        neverAbort,
      ),
    ).rejects.toMatchObject({ code: "NOT_PREVIEWABLE" });
  });

  it("rejects getImageFrame on a video channel", async () => {
    const { session } = await openSession(await makeMediaMcap());
    const ch = channel(session, VIDEO_TOPIC);
    await expect(
      session.getImageFrame({ channelId: ch.id, target: { logTime: at(0), sequence: 0 } }, neverAbort),
    ).rejects.toMatchObject({ code: "NOT_PREVIEWABLE" });
  });
});
