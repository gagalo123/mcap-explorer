import type { TimeNs } from "./time";

/**
 * Every type in this file must survive JSON.stringify unchanged: no bigint, no
 * Map, no Uint8Array. Counts that may exceed 2^53 (uint64 in the MCAP spec)
 * are decimal strings.
 */

export interface ChannelDto {
  id: number;
  topic: string;
  schemaId: number;
  schemaName: string;
  schemaEncoding: string;
  messageEncoding: string;
  /** uint64 as decimal string; undefined when statistics are absent. */
  messageCount?: string;
  freqHz?: number;
  /** Set when the channel's schema is a known image/video type (Phase 3). */
  preview?: "video" | "image";
}

export interface SchemaDto {
  id: number;
  name: string;
  encoding: string;
  dataLength: number;
}

export interface SchemaSourceDto {
  schemaId: number;
  kind: "text" | "hex";
  content: string;
  truncated: boolean;
  totalLength: number;
}

export interface AttachmentIndexDto {
  /**
   * Position in the file's attachment list — the stable identity used to
   * save/preview an attachment. name + logTime need not be unique.
   */
  index: number;
  name: string;
  mediaType: string;
  /** uint64 as decimal string. */
  dataSize: string;
  logTime: TimeNs;
  createTime: TimeNs;
}

export interface MetadataIndexDto {
  name: string;
}

export interface MetadataDto {
  name: string;
  entries: Record<string, string>;
}

export interface StatsDto {
  messageCount: string;
  schemaCount: number;
  channelCount: number;
  attachmentCount: number;
  metadataCount: number;
  chunkCount: number;
}

export interface TimeRangeDto {
  start: TimeNs;
  end: TimeNs;
}

export interface ChunksDto {
  count: number;
  /** compression name ("" = uncompressed) → number of chunks. */
  compressions: Record<string, number>;
  /** Largest uncompressed chunk size, uint64 as decimal string. */
  maxUncompressedSize: string;
}

export interface SummaryDto {
  fileName: string;
  fileSize: number;
  profile: string;
  library: string;
  /** False when the file lacks a summary section; UI offers a full scan. */
  indexed: boolean;
  /** True when the summary was produced by a full scan of an unindexed file. */
  scanned?: boolean;
  /** True when a scan hit a parse error and results cover only a file prefix. */
  partial?: boolean;
  stats?: StatsDto;
  timeRange?: TimeRangeDto;
  channels: ChannelDto[];
  schemas: SchemaDto[];
  attachments: AttachmentIndexDto[];
  metadata: MetadataIndexDto[];
  chunks: ChunksDto;
}

export interface SaveAttachmentResultDto {
  saved: boolean;
  targetPath?: string;
  bytesWritten?: number;
}

export interface OpenAttachmentResultDto {
  opened: boolean;
  /** Path of the scratch file opened in the editor. */
  targetPath?: string;
  bytesWritten?: number;
}

/**
 * JSON-safe decoded message tree (Phase 2+). Binary leaves are replaced by a
 * bytes node so raw payloads never cross the bridge.
 */
export type DecodedValue =
  | null
  | boolean
  | number
  | string
  | { type: "bytes"; length: number; previewHex: string }
  | DecodedValue[]
  | { [key: string]: DecodedValue };

/** One message from a channel, decoded (Phase 2). */
export interface MessageDto {
  channelId: number;
  topic: string;
  sequence: number;
  logTime: TimeNs;
  publishTime: TimeNs;
  sizeBytes: number;
  /** Which decoder produced `value`: "json" | "protobuf" | "ros1" | "ros2" | "raw". */
  decoder: string;
  /** Decoded tree; absent when decoding failed (see decodeError). */
  value?: DecodedValue;
  /** Set when this single message failed to decode; the page still returns. */
  decodeError?: string;
}

export interface MessagePageDto {
  messages: MessageDto[];
  /** Opaque cursor to fetch the next page; absent when reachedEnd. */
  nextCursor?: string;
  reachedEnd: boolean;
}

/**
 * One compressed video frame (Phase 3). The compressed bitstream crosses the
 * bridge as base64 — a bounded, user-initiated relaxation of the "raw bytes
 * never cross" rule: only frames the user chose to preview, never bulk data.
 */
export interface VideoFrameDto {
  sequence: number;
  logTime: TimeNs;
  /** True for an IDR/IRAP frame the decoder can start from. */
  keyframe: boolean;
  /** Base64 of this frame's compressed bitstream (Annex-B for h264/h265). */
  dataBase64: string;
}

export interface VideoFramesDto {
  codec: "h264" | "h265" | "vp9" | "av1";
  /** WebCodecs codec string, e.g. "hev1.1.6.L93.B0" / "avc1.640028". */
  codecString: string;
  frames: VideoFrameDto[];
  /** Index within `frames` of the keyframe to start decoding from; -1 if none. */
  keyframeIndex: number;
  reachedEnd: boolean;
  /** Anchor to continue from (first frame not included) when reachedEnd is false. */
  nextAnchor?: { logTime: TimeNs; sequence: number };
  /** Total compressed bytes carried in this window (pre-base64). */
  totalBytes: number;
}

/**
 * Downsampled numeric time series for one channel (Phase 4). `t` is relative
 * seconds from `startNs` (absolute nanoseconds exceed 2^53, so they can't be a
 * JS number); each `values[fieldIndex]` aligns with `t`, using null for a
 * missing / non-numeric sample so the plot shows a gap.
 */
export interface TimeSeriesDto {
  startNs: TimeNs;
  fields: string[];
  t: number[];
  values: (number | null)[][];
  /** Number of points returned (after time-bucket sampling). */
  sampled: number;
  /** True when a hard scan cap was hit before the range end. */
  reachedCap: boolean;
}

// ---- Editing / export (Phase 5) ------------------------------------------

/**
 * A declarative description of the edits to apply while rewriting an MCAP to a
 * new file. Everything here is JSON-safe (times are decimal-string ns). The
 * host reads the source and re-emits it through McapWriter honoring this spec;
 * the source file is never mutated.
 */
export interface EditSpec {
  /** Channel topics to remove entirely (all their messages are dropped). */
  dropTopics: string[];
  /** old topic → new topic; applied to surviving channels. */
  renameTopics: Record<string, string>;
  /** Inclusive time crop; omit to keep the full range. */
  timeRange?: { start: TimeNs; end: TimeNs };
  metadata: {
    /** Metadata record names to drop (removes every record with that name). */
    remove: string[];
    /** Add, or replace by name, these metadata records. */
    upsert: { name: string; entries: Record<string, string> }[];
  };
  attachments: {
    /** Source attachment-list indexes to drop (see AttachmentIndexDto.index). */
    removeIndexes: number[];
    /** Rename an existing attachment identified by its source index. */
    rename: { index: number; name: string }[];
    /** New attachments read from local files on the host. */
    add: { sourcePath: string; name: string; mediaType: string }[];
  };
}

/** A local file the user picked to add as an attachment (resolved host-side). */
export interface AttachmentSourceDto {
  path: string;
  name: string;
  mediaType: string;
  /** uint64 as decimal string. */
  dataSize: string;
}

export interface ExportResultDto {
  saved: boolean;
  targetPath?: string;
  bytesWritten?: number;
}

/** One image message decoded to a renderable form (Phase 3). */
export interface ImageFrameDto {
  kind: "compressed" | "raw";
  /** compressed: "jpeg"|"png"|"webp"…; raw: pixel encoding "rgb8"|"bgr8"|"mono8"… */
  format: string;
  width?: number;
  height?: number;
  /** Raw image row stride in bytes (raw only); 0/undefined = tightly packed. */
  step?: number;
  sequence: number;
  logTime: TimeNs;
  /** Base64 of the compressed image or raw pixel bytes. */
  dataBase64: string;
}

/**
 * A forward run of image frames for one channel, read in a single pass and
 * shipped in one response, so playback fetches a window at a time instead of a
 * round-trip per frame. Bounded by a frame count and a total-bytes cap;
 * `nextAnchor` continues the next window.
 */
export interface ImageFramesDto {
  frames: ImageFrameDto[];
  reachedEnd: boolean;
  nextAnchor?: { logTime: TimeNs; sequence: number };
}
