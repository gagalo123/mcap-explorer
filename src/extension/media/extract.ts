/**
 * Recognizes the well-known image/video message schemas and pulls the raw
 * media bytes (plus format/dimensions) out of a single message. Kept separate
 * from the JsonTree decoders because those normalize binary fields into bytes
 * nodes — here we need the untouched payload to hand to WebCodecs.
 *
 * Heavy parsers (protobufjs, rosmsg) load lazily inside createMediaExtractor().
 */

export type MediaKind = "video" | "image-compressed" | "image-raw" | "image-safari";

export interface MediaPayload {
  /** video/compressed: codec/container format; raw: pixel encoding ("rgb8"…). */
  format: string;
  width?: number;
  height?: number;
  step?: number;
  payload: Uint8Array;
}

/**
 * Compressed still-image container formats. Used to classify an `image-safari`
 * frame (whose compressed/raw nature lives in the message, not the schema name)
 * into the DTO's "compressed" | "raw" kind.
 */
const COMPRESSED_IMAGE_FORMATS = new Set(["jpeg", "jpg", "png", "webp"]);

export function isCompressedImageFormat(format: string): boolean {
  return COMPRESSED_IMAGE_FORMATS.has(format.trim().toLowerCase());
}

export interface MediaExtractor {
  kind: MediaKind;
  extract(data: Uint8Array): MediaPayload;
}

const VIDEO_SCHEMAS = new Set(["foxglove.CompressedVideo"]);
const COMPRESSED_IMAGE_SCHEMAS = new Set([
  "foxglove.CompressedImage",
  "sensor_msgs/CompressedImage",
  "sensor_msgs/msg/CompressedImage",
]);
const RAW_IMAGE_SCHEMAS = new Set([
  "foxglove.RawImage",
  "sensor_msgs/Image",
  "sensor_msgs/msg/Image",
]);
/**
 * Google Safari SDK image wrapper. Unlike the foxglove/ROS types it carries no
 * `format`/`encoding` string — the codec (JPEG/PNG/none) and pixel layout live
 * in a nested `pixel_type` message, so the compressed-vs-raw decision is made
 * per message in readMediaFields, not from the schema name.
 */
const SAFARI_IMAGE_SCHEMA = "safari_sdk.protos.Image";

/** Coarse kind for the summary's per-channel `preview` flag (no decode). */
export function mediaKindForSchema(schemaName: string): "video" | "image" | undefined {
  if (VIDEO_SCHEMAS.has(schemaName)) {
    return "video";
  }
  if (
    COMPRESSED_IMAGE_SCHEMAS.has(schemaName) ||
    RAW_IMAGE_SCHEMAS.has(schemaName) ||
    schemaName === SAFARI_IMAGE_SCHEMA
  ) {
    return "image";
  }
  return undefined;
}

function kindForSchema(name: string): MediaKind | undefined {
  if (VIDEO_SCHEMAS.has(name)) {
    return "video";
  }
  if (COMPRESSED_IMAGE_SCHEMAS.has(name)) {
    return "image-compressed";
  }
  if (RAW_IMAGE_SCHEMAS.has(name)) {
    return "image-raw";
  }
  if (name === SAFARI_IMAGE_SCHEMA) {
    return "image-safari";
  }
  return undefined;
}

export async function createMediaExtractor(
  messageEncoding: string,
  schema: { name: string; encoding: string; data: Uint8Array } | undefined,
): Promise<MediaExtractor | null> {
  if (!schema) {
    return null;
  }
  const kind = kindForSchema(schema.name);
  if (!kind) {
    return null;
  }

  if (messageEncoding === "protobuf" && schema.encoding === "protobuf") {
    /* eslint-disable @typescript-eslint/no-explicit-any */
    const protobuf: any = await import("protobufjs");
    const descriptor: any = await import("protobufjs/ext/descriptor");
    const Root = protobuf.Root ?? protobuf.default?.Root;
    const FileDescriptorSet = descriptor.FileDescriptorSet ?? descriptor.default?.FileDescriptorSet;
    /* eslint-enable @typescript-eslint/no-explicit-any */
    const root = Root.fromDescriptor(FileDescriptorSet.decode(schema.data));
    root.resolveAll();
    const type = root.lookupType(schema.name);
    return {
      kind,
      extract(data) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return readMediaFields(kind, type.decode(data) as any);
      },
    };
  }

  if (messageEncoding === "cdr" && (schema.encoding === "ros2msg" || schema.encoding === "ros2idl")) {
    const { parse } = await import("@foxglove/rosmsg");
    const { MessageReader } = await import("@foxglove/rosmsg2-serialization");
    const reader = new MessageReader(parse(new TextDecoder().decode(schema.data), { ros2: true }));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return { kind, extract: (data) => readMediaFields(kind, reader.readMessage(data) as any) };
  }

  if (messageEncoding === "ros1" && schema.encoding === "ros1msg") {
    const { parse } = await import("@foxglove/rosmsg");
    const { MessageReader } = await import("@foxglove/rosmsg-serialization");
    const reader = new MessageReader(parse(new TextDecoder().decode(schema.data)));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return { kind, extract: (data) => readMediaFields(kind, reader.readMessage(data) as any) };
  }

  return null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function readMediaFields(kind: MediaKind, msg: any): MediaPayload {
  if (kind === "image-raw") {
    return {
      format: String(msg.encoding ?? ""),
      width: numeric(msg.width),
      height: numeric(msg.height),
      step: numeric(msg.step),
      payload: toU8(msg.data),
    };
  }
  if (kind === "image-safari") {
    return readSafariImageFields(msg);
  }
  // video + image-compressed carry `format` + `data`.
  return { format: String(msg.format ?? ""), payload: toU8(msg.data) };
}

// safari_sdk.protos.Image.PixelType enum values (from the embedded descriptor).
// createMediaExtractor decodes via type.decode(), so enum fields are numbers.
const SAFARI_COMPRESSION = { NO_COMPRESSION: 0, JPEG: 1, PNG: 2 } as const;
const SAFARI_PRIMITIVE = { UCHAR8: 1, UINT16: 2 } as const;
const SAFARI_CHANNEL1 = { MONO: 1, DEPTH: 2 } as const;
const SAFARI_CHANNEL3_RGB = 1;
const SAFARI_CHANNEL4_RGBA = 1;

/**
 * safari_sdk.protos.Image → MediaPayload. JPEG/PNG payloads become compressed
 * frames; NO_COMPRESSION maps to an 8-bit raw encoding the ImageViewer knows
 * (rgb8/rgba8/mono8). 16-bit/depth raw is out of scope — it falls through with
 * an empty format so the viewer reports "unsupported raw encoding".
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function readSafariImageFields(msg: any): MediaPayload {
  const px = msg.pixel_type ?? {};
  const width = numeric(msg.cols);
  const height = numeric(msg.rows);
  const payload = toU8(msg.data);
  const compression = Number(px.compression ?? SAFARI_COMPRESSION.NO_COMPRESSION);
  if (compression === SAFARI_COMPRESSION.JPEG) {
    return { format: "jpeg", width, height, payload };
  }
  if (compression === SAFARI_COMPRESSION.PNG) {
    return { format: "png", width, height, payload };
  }
  // NO_COMPRESSION: derive an 8-bit pixel encoding from the channel type.
  const primitive = Number(px.pixel_primitive ?? 0);
  const ch1 = Number(px.channel_type_1 ?? 0);
  const ch3 = Number(px.channel_type_3 ?? 0);
  const ch4 = Number(px.channel_type_4 ?? 0);
  let format = "";
  if (ch4 === SAFARI_CHANNEL4_RGBA) {
    format = "rgba8";
  } else if (ch3 === SAFARI_CHANNEL3_RGB) {
    format = "rgb8";
  } else if (
    (ch1 === SAFARI_CHANNEL1.MONO || ch1 === SAFARI_CHANNEL1.DEPTH) &&
    primitive === SAFARI_PRIMITIVE.UCHAR8
  ) {
    format = "mono8";
  }
  return { format, width, height, payload };
}

function toU8(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) {
    return value;
  }
  if (ArrayBuffer.isView(value)) {
    const v = value as ArrayBufferView;
    return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
  }
  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value);
  }
  return new Uint8Array(0);
}

function numeric(value: unknown): number | undefined {
  if (typeof value === "number") {
    return value;
  }
  if (typeof value === "bigint") {
    return Number(value);
  }
  if (typeof value === "string" && value !== "") {
    return Number(value);
  }
  return undefined;
}
