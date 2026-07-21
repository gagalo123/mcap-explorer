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
