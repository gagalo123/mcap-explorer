/**
 * Recognizes the well-known image/video message schemas and pulls the raw
 * media bytes (plus format/dimensions) out of a single message. Kept separate
 * from the JsonTree decoders because those normalize binary fields into bytes
 * nodes — here we need the untouched payload to hand to WebCodecs.
 *
 * Heavy parsers (protobufjs, rosmsg) load lazily inside createMediaExtractor().
 */

export type MediaKind = "video" | "image-compressed" | "image-raw";

export interface MediaPayload {
  /** video/compressed: codec/container format; raw: pixel encoding ("rgb8"…). */
  format: string;
  width?: number;
  height?: number;
  step?: number;
  payload: Uint8Array;
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

/** Coarse kind for the summary's per-channel `preview` flag (no decode). */
export function mediaKindForSchema(schemaName: string): "video" | "image" | undefined {
  if (VIDEO_SCHEMAS.has(schemaName)) {
    return "video";
  }
  if (COMPRESSED_IMAGE_SCHEMAS.has(schemaName) || RAW_IMAGE_SCHEMAS.has(schemaName)) {
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
  // video + image-compressed carry `format` + `data`.
  return { format: String(msg.format ?? ""), payload: toU8(msg.data) };
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
