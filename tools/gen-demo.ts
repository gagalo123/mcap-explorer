/**
 * Generates a small self-contained demo MCAP (examples/demo.mcap) with an IMU
 * (sine signals), a PNG camera topic and odometry, then opens it through the
 * real reader and writes a browser harness (dist/demo-harness.html) that renders
 * the actual webview UI against the extracted DTOs — used to capture the README
 * demo screenshots headlessly. Run via `npm run gen-demo`.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";

import { McapWriter, TempBuffer } from "@mcap/core";
import { loadDecompressHandlers } from "@mcap/support";
import protobuf from "protobufjs";
import descriptor from "protobufjs/ext/descriptor";

import { McapFileSession } from "../src/extension/readerService";

const enc = (s: string) => new TextEncoder().encode(s);
const FRAME_W = 320;
const FRAME_H = 240;
const START = 1_730_000_000_000_000_000n;
const HZ = 50;
const N = 150;

// ---- minimal PNG (RGBA, color type 6) ------------------------------------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = enc(type);
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  out.set(typeBytes, 4);
  out.set(data, 8);
  const crcInput = new Uint8Array(typeBytes.length + data.length);
  crcInput.set(typeBytes, 0);
  crcInput.set(data, typeBytes.length);
  dv.setUint32(8 + data.length, crc32(crcInput));
  return out;
}
function pngEncode(w: number, h: number, rgba: Uint8Array): Uint8Array {
  const sig = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, w);
  dv.setUint32(4, h);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = new Uint8Array(h * (1 + w * 4));
  for (let y = 0; y < h; y++) {
    raw[y * (1 + w * 4)] = 0; // filter: none
    raw.set(rgba.subarray(y * w * 4, (y + 1) * w * 4), y * (1 + w * 4) + 1);
  }
  const idat = new Uint8Array(deflateSync(raw));
  const parts = [sig, chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", new Uint8Array(0))];
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}
function renderFrame(k: number): Uint8Array {
  const rgba = new Uint8Array(FRAME_W * FRAME_H * 4);
  const frac = (k % 8) / 8;
  const cx = FRAME_W * (0.25 + 0.5 * frac);
  const cy = FRAME_H * (0.4 + 0.2 * Math.sin(k));
  for (let y = 0; y < FRAME_H; y++) {
    for (let x = 0; x < FRAME_W; x++) {
      const i = (y * FRAME_W + x) * 4;
      const d = Math.hypot(x - cx, y - cy);
      if (d < 42) {
        rgba[i] = 255;
        rgba[i + 1] = 210;
        rgba[i + 2] = 80;
      } else {
        rgba[i] = Math.round((x / FRAME_W) * 90) + 20;
        rgba[i + 1] = Math.round((y / FRAME_H) * 120) + 30;
        rgba[i + 2] = 90;
      }
      rgba[i + 3] = 255;
    }
  }
  return rgba;
}

async function buildDemo(): Promise<Uint8Array> {
  const buffer = new TempBuffer();
  const writer = new McapWriter({
    writable: buffer,
    useChunks: true,
    useStatistics: true,
    useChunkIndex: true,
    useMessageIndex: true,
    useSummaryOffsets: true,
    useMetadataIndex: true,
    repeatSchemas: true,
    repeatChannels: true,
    chunkSize: 512 * 1024,
  });
  await writer.start({ profile: "", library: "mcap-explorer demo" });

  const imuSchema = await writer.registerSchema({ name: "sensor_msgs/Imu", encoding: "jsonschema", data: enc("{}") });
  const imuCh = await writer.registerChannel({ topic: "/imu/front", schemaId: imuSchema, messageEncoding: "json", metadata: new Map() });
  const odomSchema = await writer.registerSchema({ name: "nav_msgs/Odometry", encoding: "jsonschema", data: enc("{}") });
  const odomCh = await writer.registerChannel({ topic: "/odom", schemaId: odomSchema, messageEncoding: "json", metadata: new Map() });

  const root = protobuf.Root.fromJSON({
    nested: {
      foxglove: {
        nested: {
          CompressedImage: {
            fields: { frame_id: { type: "string", id: 1 }, format: { type: "string", id: 2 }, data: { type: "bytes", id: 3 } },
          },
        },
      },
    },
  });
  const CompressedImage = root.lookupType("foxglove.CompressedImage");
  const fds = descriptor.FileDescriptorSet.encode(root.toDescriptor("proto3")).finish();
  const camSchema = await writer.registerSchema({ name: "foxglove.CompressedImage", encoding: "protobuf", data: new Uint8Array(fds) });
  const camCh = await writer.registerChannel({ topic: "/camera/front/image", schemaId: camSchema, messageEncoding: "protobuf", metadata: new Map() });

  await writer.addMetadata({
    name: "recording.info",
    metadata: new Map([
      ["robot", "demo-bot"],
      ["site", "warehouse-3"],
      ["operator", "mcap-explorer"],
    ]),
  });

  const dt = 1_000_000_000n / BigInt(HZ);
  for (let i = 0; i < N; i++) {
    const t = START + BigInt(i) * dt;
    const s = i / HZ;
    // angular_velocity first so the plot picker defaults to a lively signal.
    const imu = {
      angular_velocity: {
        x: +(Math.sin(s * 2) * 1.5).toFixed(4),
        y: +(Math.cos(s * 1.3) * 1.2).toFixed(4),
        z: +(Math.sin(s * 0.7) * 0.8).toFixed(4),
      },
      linear_acceleration: {
        x: +(Math.sin(s * 3) * 0.5).toFixed(4),
        y: +(Math.cos(s * 2.1) * 0.5).toFixed(4),
        z: +(9.81 + Math.sin(s) * 0.2).toFixed(4),
      },
      orientation: { x: 0, y: 0, z: 0, w: 1 },
      header: { seq: i, stamp: { sec: Number(t / 1_000_000_000n), nsec: Number(t % 1_000_000_000n) }, frame_id: "imu_front" },
    };
    await writer.addMessage({ channelId: imuCh, sequence: i, logTime: t, publishTime: t, data: enc(JSON.stringify(imu)) });

    const odom = {
      pose: { position: { x: +(s * 1.0).toFixed(3), y: +(Math.sin(s * 0.5) * 2).toFixed(3), z: 0 } },
      twist: { linear: { x: +(1 + Math.sin(s) * 0.3).toFixed(3), y: 0, z: 0 }, angular: { z: +(Math.sin(s * 1.5) * 0.4).toFixed(3) } },
    };
    await writer.addMessage({ channelId: odomCh, sequence: i, logTime: t, publishTime: t, data: enc(JSON.stringify(odom)) });

    if (i % 5 === 0) {
      const png = pngEncode(FRAME_W, FRAME_H, renderFrame(i / 5));
      const msg = CompressedImage.encode(CompressedImage.create({ frame_id: "cam_front", format: "png", data: png })).finish();
      await writer.addMessage({ channelId: camCh, sequence: i / 5, logTime: t, publishTime: t, data: new Uint8Array(msg) });
    }
  }

  await writer.end();
  return buffer.get();
}

function idOf(session: McapFileSession, topic: string): number {
  const ch = session.summary().channels.find((c) => c.topic === topic);
  if (!ch) {
    throw new Error(`no channel ${topic}`);
  }
  return ch.id;
}

async function main(): Promise<void> {
  const bytes = await buildDemo();
  mkdirSync("examples", { recursive: true });
  writeFileSync("examples/demo.mcap", bytes);

  const session = await McapFileSession.open(new TempBuffer(bytes), {
    fileName: "demo.mcap",
    fileSize: bytes.byteLength,
    decompressHandlers: await loadDecompressHandlers(),
    maxChunkUncompressedSize: 256 * 1024 * 1024,
  });

  const imuId = idOf(session, "/imu/front");
  const camId = idOf(session, "/camera/front/image");
  const summary = session.summary();
  const imuMessages = await session.queryMessages({ topics: ["/imu/front"], limitCount: 100, limitBytes: 2_000_000 });
  const image = await session.getImageFrame({
    channelId: camId,
    target: { logTime: summary.timeRange!.start, sequence: 0 },
  });
  const series = await session.queryTimeSeries({
    channelId: imuId,
    fields: ["angular_velocity.x", "angular_velocity.y", "angular_velocity.z"],
    maxPoints: 2000,
  });

  const mock = { summary, imuMessages, image, series, imuId, camId };
  mkdirSync("dist", { recursive: true });
  writeFileSync("dist/demo-harness.html", harnessHtml(JSON.stringify(mock)));
  console.log(
    `wrote examples/demo.mcap (${(bytes.byteLength / 1024).toFixed(0)} KiB), ` +
      `dist/demo-harness.html — imu=${imuId} cam=${camId}, ` +
      `${series.sampled} plot pts, image ${image.width ?? "?"}x${image.height ?? "?"}`,
  );
}

function harnessHtml(mockJson: string): string {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8">
<link href="webview.css" rel="stylesheet">
<style>
  :root {
    --vscode-font-family: -apple-system, "Segoe UI", Ubuntu, sans-serif;
    --vscode-foreground: #cccccc; --vscode-editor-background: #1e1e1e;
    --vscode-editor-foreground: #d4d4d4; --vscode-panel-border: #3c3c3c;
    --vscode-focusBorder: #007fd4;
    --vscode-button-background: #0e639c; --vscode-button-foreground: #ffffff;
    --vscode-button-hoverBackground: #1177bb;
    --vscode-list-hoverBackground: #2a2d2e;
    --vscode-list-activeSelectionBackground: #094771;
    --vscode-list-activeSelectionForeground: #ffffff;
    --vscode-editorWidget-background: #252526;
    --vscode-textLink-foreground: #3794ff;
    --vscode-descriptionForeground: #9d9d9d;
    --vscode-charts-blue: #3794ff; --vscode-charts-red: #f14c4c;
    --vscode-charts-green: #89d185; --vscode-charts-yellow: #e2c08d;
    --vscode-charts-orange: #d18616; --vscode-charts-purple: #b180d7;
  }
  html,body { margin:0; background:var(--vscode-editor-background); color:var(--vscode-foreground);
    font-family:var(--vscode-font-family); font-size:13px; height:100%; }
  #root { height:100vh; }
</style></head>
<body><div id="root"></div>
<script>
  const MOCK = ${mockJson};
  const view = location.hash.slice(1) || "summary";
  const V = view === "messages" ? { kind:"messages", channelId:MOCK.imuId }
    : view === "preview" ? { kind:"preview", channelId:MOCK.camId, anchor:{ logTime:MOCK.image.logTime, sequence:MOCK.image.sequence } }
    : view === "plot" ? { kind:"plot", channelId:MOCK.imuId }
    : { kind:"summary" };
  let STATE = { v:5, summary:MOCK.summary, view:V };
  function post(data){ window.dispatchEvent(new MessageEvent("message", { data })); }
  function reply(id, body){ post({ kind:"response", id, ok:true, body }); }
  window.acquireVsCodeApi = () => ({
    postMessage: (msg) => setTimeout(() => handle(msg), 0),
    getState: () => STATE,
    setState: (s) => { STATE = s; },
  });
  function handle(msg){
    if (msg.kind === "ready"){ post({ kind:"init", summary:MOCK.summary }); return; }
    if (msg.kind !== "request") return;
    const op = msg.op;
    if (op.op === "getSummary") reply(msg.id, { type:"summary", summary:MOCK.summary });
    else if (op.op === "queryMessages") reply(msg.id, { type:"messages", page:{ messages:MOCK.imuMessages.messages.slice(0, op.limitCount), reachedEnd:true } });
    else if (op.op === "getImageFrame") reply(msg.id, { type:"imageFrame", data:MOCK.image });
    else if (op.op === "getImageWindow") {
      const n = 18;
      const frames = Array.from({ length: n }, (_, i) => ({ ...MOCK.image, sequence: i, logTime: MOCK.imuMessages.messages[i]?.logTime ?? MOCK.image.logTime }));
      reply(msg.id, { type:"imageFrames", data:{ frames, reachedEnd:true } });
    }
    else if (op.op === "queryTimeSeries") reply(msg.id, { type:"timeSeries", data:MOCK.series });
    else post({ kind:"response", id:msg.id, ok:false, error:{ code:"UNSUPPORTED_OP", message:"demo harness" } });
  }
</script>
<script src="webview.js"></script>
</body></html>`;
}

void main();
