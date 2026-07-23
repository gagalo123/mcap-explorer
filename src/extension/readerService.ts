import { readFile } from "node:fs/promises";

import { hasMcapPrefix, McapIndexedReader, McapStreamReader, McapWriter, Opcode } from "@mcap/core";
import type { DecompressHandlers, IReadable, IWritable, TypedMcapRecords } from "@mcap/core";

import { DecoderRegistry } from "./decoders/registry";
import type { ChannelDecoder } from "./decoders/types";
import { McapExplorerError } from "./errors";
import { classifyFrame, codecStringFor, normalizeCodec } from "./media/annexb";
import type { VideoCodec } from "./media/annexb";
import { createMediaExtractor, mediaKindForSchema } from "./media/extract";
import type { MediaExtractor } from "./media/extract";
import type {
  AttachmentIndexDto,
  ChannelDto,
  ChunksDto,
  DecodedValue,
  EditSpec,
  ImageFrameDto,
  MessageDto,
  MessagePageDto,
  MetadataDto,
  SchemaDto,
  SchemaSourceDto,
  StatsDto,
  SummaryDto,
  TimeRangeDto,
  TimeSeriesDto,
  VideoFrameDto,
  VideoFramesDto,
} from "../shared/dto";
import { durationBetween, frequencyHz, fromTimeNs, toTimeNs } from "../shared/time";
import type { TimeNs } from "../shared/time";

type Schema = TypedMcapRecords["Schema"];
type Channel = TypedMcapRecords["Channel"];

export interface SessionOptions {
  fileName: string;
  fileSize: number;
  decompressHandlers: DecompressHandlers;
  /** OOM guard: refuse to process chunks that inflate beyond this. */
  maxChunkUncompressedSize: number;
}

export interface ScanProgress {
  loadedBytes: number;
  totalBytes: number;
}

export interface QueryMessagesOptions {
  topics: string[];
  start?: TimeNs;
  end?: TimeNs;
  reverse?: boolean;
  cursor?: string;
  limitCount: number;
  limitBytes: number;
}

export interface FrameWindowOptions {
  channelId: number;
  anchor: { logTime: TimeNs; sequence: number };
  count: number;
  needKeyframe: boolean;
}

export interface ImageFrameOptions {
  channelId: number;
  target: { logTime: TimeNs; sequence: number };
}

export interface TimeSeriesOptions {
  channelId: number;
  fields: string[];
  start?: TimeNs;
  end?: TimeNs;
  maxPoints: number;
  /** Byte budget before chunk-striding kicks in; defaults to MAX_PLOT_SCAN_BYTES. */
  maxScanBytes?: number;
}

const SCAN_WINDOW_BYTES = 4 * 1024 * 1024;
const SCAN_PROGRESS_INTERVAL_BYTES = 64 * 1024 * 1024;
const SCHEMA_TEXT_LIMIT = 256 * 1024;
const SCHEMA_HEX_LIMIT = 4 * 1024;
const SCAN_METADATA_LIMIT = 10_000;
const ATTACHMENT_WINDOW_BYTES = 4 * 1024 * 1024;
/** Chunk target size when rewriting (exporting) an edited file. */
const EXPORT_CHUNK_SIZE = 4 * 1024 * 1024;
/** Emit export progress after every N messages written. */
const EXPORT_PROGRESS_INTERVAL = 2000;
/** Video preview bounds (Phase 3). */
const DEFAULT_MAX_FRAME_COUNT = 600;
const DEFAULT_MAX_KEYFRAME_LOOKBACK = 600;
const DEFAULT_MAX_FRAME_WINDOW_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_FRAME_BYTES = 32 * 1024 * 1024;
/** Time-series sampling bounds (Phase 4). */
const MAX_TIMESERIES_POINTS = 20000;
const TIMESERIES_HARD_CAP = 50000;
/** Max bytes to decompress for one plot query before striding over chunks. */
const MAX_PLOT_SCAN_BYTES = 256 * 1024 * 1024;

/** Minimum valid MCAP: magic + footer record + trailing magic. */
const MIN_FILE_SIZE = 8 + 1 + 8 + 20 + 8;

/**
 * One open MCAP file. Pure Node logic — no vscode imports — so everything here
 * is unit-testable against in-memory buffers.
 */
export class McapFileSession {
  #readable: IReadable;
  #opts: SessionOptions;
  #reader: McapIndexedReader | undefined;
  #summary: SummaryDto;
  #schemasById: Map<number, Schema>;
  /** Full metadata records captured during a scan (unindexed files only). */
  #scannedMetadata: MetadataDto[] | undefined;
  /** In-flight scan shared across panels so a file is never scanned twice. */
  #scanPromise: Promise<SummaryDto> | undefined;
  #scanProgressListeners = new Set<(progress: ScanProgress) => void>();
  #registry = new DecoderRegistry();
  /** Per-channel decoder cache (built lazily on first message of a channel). */
  #decoderCache = new Map<number, ChannelDecoder>();
  /** Per-channel media extractor cache; null = channel is not previewable. */
  #mediaExtractorCache = new Map<number, MediaExtractor | null>();

  private constructor(
    readable: IReadable,
    opts: SessionOptions,
    reader: McapIndexedReader | undefined,
    summary: SummaryDto,
    schemasById: Map<number, Schema>,
  ) {
    this.#readable = readable;
    this.#opts = opts;
    this.#reader = reader;
    this.#summary = summary;
    this.#schemasById = schemasById;
  }

  static async open(readable: IReadable, opts: SessionOptions): Promise<McapFileSession> {
    if (opts.fileSize < MIN_FILE_SIZE) {
      throw new McapExplorerError(
        "NOT_MCAP",
        `File is too small (${opts.fileSize} bytes) to be a valid MCAP file.`,
      );
    }
    const prefix = await readable.read(0n, 8n);
    if (!hasMcapPrefix(new DataView(prefix.buffer, prefix.byteOffset, prefix.byteLength))) {
      throw new McapExplorerError(
        "NOT_MCAP",
        "File does not start with the MCAP magic bytes (\\x89MCAP0\\r\\n).",
      );
    }

    try {
      const reader = await McapIndexedReader.Initialize({
        readable,
        decompressHandlers: opts.decompressHandlers,
      });
      const summary = buildIndexedSummary(reader, opts);
      return new McapFileSession(readable, opts, reader, summary, new Map(reader.schemasById));
    } catch {
      // No summary section, no indexes, or a truncated file: fall back to a
      // minimal summary. The UI offers an explicit full scan.
      const header = await tryReadHeader(readable, opts);
      const summary: SummaryDto = {
        fileName: opts.fileName,
        fileSize: opts.fileSize,
        profile: header?.profile ?? "",
        library: header?.library ?? "",
        indexed: false,
        channels: [],
        schemas: [],
        attachments: [],
        metadata: [],
        chunks: { count: 0, compressions: {}, maxUncompressedSize: "0" },
      };
      return new McapFileSession(readable, opts, undefined, summary, new Map());
    }
  }

  get indexed(): boolean {
    return this.#reader !== undefined;
  }

  summary(): SummaryDto {
    return this.#summary;
  }

  getSchemaSource(schemaId: number): SchemaSourceDto {
    const schema = this.#schemasById.get(schemaId);
    if (!schema) {
      throw new McapExplorerError("IO_ERROR", `Schema id ${schemaId} not found.`);
    }
    return formatSchemaSource(schema);
  }

  async getMetadata(name: string): Promise<MetadataDto[]> {
    if (this.#reader) {
      const records: MetadataDto[] = [];
      for await (const record of this.#reader.readMetadata({ name })) {
        records.push({ name: record.name, entries: Object.fromEntries(record.metadata) });
      }
      return records;
    }
    if (this.#scannedMetadata) {
      return this.#scannedMetadata.filter((m) => m.name === name);
    }
    throw new McapExplorerError(
      "NO_INDEX",
      "Metadata is unavailable until the file has been scanned.",
    );
  }

  /**
   * Full sequential scan for files without a summary section. Only aggregates
   * (counts, time bounds, channel/schema/metadata records) are retained;
   * message payloads are discarded as they stream through.
   */
  async scanUnindexed(
    onProgress: (progress: ScanProgress) => void,
    signal: AbortSignal,
  ): Promise<SummaryDto> {
    if (this.#reader) {
      return this.#summary;
    }
    // A second caller (another editor panel, a double click) joins the scan
    // already in flight instead of re-reading the whole file.
    this.#scanProgressListeners.add(onProgress);
    if (!this.#scanPromise) {
      this.#scanPromise = this.#runScan(
        (progress) => {
          for (const listener of this.#scanProgressListeners) {
            listener(progress);
          }
        },
        signal,
      ).finally(() => {
        this.#scanPromise = undefined;
        this.#scanProgressListeners.clear();
      });
    }
    return await this.#scanPromise;
  }

  async #runScan(
    onProgress: (progress: ScanProgress) => void,
    signal: AbortSignal,
  ): Promise<SummaryDto> {
    const streamReader = new McapStreamReader({
      includeChunks: true,
      decompressHandlers: this.#opts.decompressHandlers,
      validateCrcs: false,
    });

    let header: TypedMcapRecords["Header"] | undefined;
    const channels = new Map<number, Channel>();
    const schemas = new Map<number, Schema>();
    const messageCounts = new Map<number, bigint>();
    const metadataRecords: MetadataDto[] = [];
    const attachments: AttachmentIndexDto[] = [];
    const compressions: Record<string, number> = {};
    let chunkCount = 0;
    let maxChunkUncompressed = 0n;
    let totalMessages = 0n;
    let minLogTime: bigint | undefined;
    let maxLogTime: bigint | undefined;
    let partial = false;

    const totalBytes = this.#opts.fileSize;
    let offset = 0;
    let lastReported = 0;

    scanLoop: while (offset < totalBytes) {
      if (signal.aborted) {
        throw new McapExplorerError("CANCELLED", "Scan cancelled.");
      }
      const length = Math.min(SCAN_WINDOW_BYTES, totalBytes - offset);
      const bytes = await this.#readable.read(BigInt(offset), BigInt(length));
      offset += length;

      try {
        streamReader.append(bytes);
        for (let record; (record = streamReader.nextRecord()); ) {
          switch (record.type) {
            case "Header":
              header = record;
              break;
            case "Schema":
              schemas.set(record.id, record);
              break;
            case "Channel":
              channels.set(record.id, record);
              break;
            case "Message": {
              totalMessages += 1n;
              messageCounts.set(record.channelId, (messageCounts.get(record.channelId) ?? 0n) + 1n);
              if (minLogTime === undefined || record.logTime < minLogTime) {
                minLogTime = record.logTime;
              }
              if (maxLogTime === undefined || record.logTime > maxLogTime) {
                maxLogTime = record.logTime;
              }
              break;
            }
            case "Chunk": {
              chunkCount += 1;
              compressions[record.compression] = (compressions[record.compression] ?? 0) + 1;
              if (record.uncompressedSize > maxChunkUncompressed) {
                maxChunkUncompressed = record.uncompressedSize;
              }
              if (record.uncompressedSize > BigInt(this.#opts.maxChunkUncompressedSize)) {
                throw new McapExplorerError(
                  "CHUNK_TOO_LARGE",
                  `Chunk inflates to ${record.uncompressedSize} bytes, above the configured limit ` +
                    `of ${this.#opts.maxChunkUncompressedSize}. Aborting scan to avoid OOM.`,
                );
              }
              break;
            }
            case "Metadata":
              if (metadataRecords.length < SCAN_METADATA_LIMIT) {
                metadataRecords.push({
                  name: record.name,
                  entries: Object.fromEntries(record.metadata),
                });
              }
              break;
            case "Attachment":
              attachments.push({
                index: attachments.length,
                name: record.name,
                mediaType: record.mediaType,
                dataSize: String(record.data.byteLength),
                logTime: toTimeNs(record.logTime),
                createTime: toTimeNs(record.createTime),
              });
              break;
            default:
              break;
          }
        }
      } catch (err) {
        if (err instanceof McapExplorerError) {
          throw err;
        }
        // Parse error mid-file (e.g. truncated tail while recording): keep
        // whatever was aggregated so far and mark the result partial.
        partial = true;
        break scanLoop;
      }

      if (offset - lastReported >= SCAN_PROGRESS_INTERVAL_BYTES || offset >= totalBytes) {
        lastReported = offset;
        onProgress({ loadedBytes: offset, totalBytes });
      }
    }

    // A truncated file does not make the stream reader throw — it simply
    // never completes (trailing bytes of an unfinished record, no footer).
    if (!streamReader.done()) {
      partial = true;
    }

    const timeRange: TimeRangeDto | undefined =
      minLogTime !== undefined && maxLogTime !== undefined
        ? { start: toTimeNs(minLogTime), end: toTimeNs(maxLogTime) }
        : undefined;

    const stats: StatsDto = {
      messageCount: totalMessages.toString(),
      schemaCount: schemas.size,
      channelCount: channels.size,
      attachmentCount: attachments.length,
      metadataCount: metadataRecords.length,
      chunkCount,
    };

    this.#schemasById = schemas;
    this.#scannedMetadata = metadataRecords;
    this.#summary = {
      fileName: this.#opts.fileName,
      fileSize: this.#opts.fileSize,
      profile: header?.profile ?? this.#summary.profile,
      library: header?.library ?? this.#summary.library,
      indexed: false,
      scanned: true,
      partial: partial || undefined,
      stats,
      timeRange,
      channels: buildChannelDtos(channels, schemas, messageCounts, timeRange),
      schemas: [...schemas.values()].map(toSchemaDto),
      attachments,
      metadata: metadataRecords.map((m) => ({ name: m.name })),
      chunks: {
        count: chunkCount,
        compressions,
        maxUncompressedSize: maxChunkUncompressed.toString(),
      },
    };
    return this.#summary;
  }

  /**
   * Stream an attachment's data to `write` in fixed windows without ever
   * materializing the whole payload. Requires an indexed file: the record is
   * located via its AttachmentIndex offset and its header parsed in place.
   * Attachments are identified by their position in the attachment list
   * (name + logTime need not be unique per the MCAP spec).
   */
  async extractAttachment(
    attachmentIndex: number,
    write: (chunk: Uint8Array) => Promise<void>,
    signal?: AbortSignal,
    windowBytes: number = ATTACHMENT_WINDOW_BYTES,
  ): Promise<number> {
    if (!this.#reader) {
      throw new McapExplorerError(
        "NO_INDEX",
        "Saving attachments from unindexed files is not supported yet.",
      );
    }
    const index = this.#reader.attachmentIndexes[attachmentIndex];
    if (!index) {
      throw new McapExplorerError("IO_ERROR", `Attachment #${attachmentIndex} not found in index.`);
    }

    // Attachment record layout (MCAP spec):
    //   opcode(1) + recordLength(8) + logTime(8) + createTime(8)
    //   + nameLength(4) + name + mediaTypeLength(4) + mediaType
    //   + dataSize(8) + data + crc(4)
    // AttachmentIndex.length covers the whole record including the 9-byte
    // opcode+recordLength prefix (verified empirically against McapWriter).
    const recordStart = index.offset;
    const recordEnd = index.offset + index.length;
    const fileSize = BigInt(this.#opts.fileSize);
    if (recordEnd > fileSize) {
      throw new McapExplorerError("TRUNCATED", "Attachment record extends past end of file.");
    }

    const fixedHead = await this.#readable.read(recordStart, 29n);
    const headView = new DataView(fixedHead.buffer, fixedHead.byteOffset, fixedHead.byteLength);
    if (headView.getUint8(0) !== Opcode.ATTACHMENT) {
      throw new McapExplorerError("IO_ERROR", "Attachment index points at a non-attachment record.");
    }
    const nameLength = headView.getUint32(25, true);

    const mediaTypeLenOffset = recordStart + 29n + BigInt(nameLength);
    const mediaTypeLenBytes = await this.#readable.read(mediaTypeLenOffset, 4n);
    const mediaTypeLength = new DataView(
      mediaTypeLenBytes.buffer,
      mediaTypeLenBytes.byteOffset,
      mediaTypeLenBytes.byteLength,
    ).getUint32(0, true);

    const dataSizeOffset = mediaTypeLenOffset + 4n + BigInt(mediaTypeLength);
    const dataSizeBytes = await this.#readable.read(dataSizeOffset, 8n);
    const dataSize = new DataView(
      dataSizeBytes.buffer,
      dataSizeBytes.byteOffset,
      dataSizeBytes.byteLength,
    ).getBigUint64(0, true);

    const dataStart = dataSizeOffset + 8n;
    if (dataStart + dataSize + 4n > recordEnd) {
      throw new McapExplorerError("TRUNCATED", "Attachment data extends past its record bounds.");
    }
    if (dataSize !== index.dataSize) {
      throw new McapExplorerError(
        "IO_ERROR",
        `Attachment data size mismatch: record says ${dataSize}, index says ${index.dataSize}.`,
      );
    }

    let written = 0n;
    while (written < dataSize) {
      if (signal?.aborted) {
        throw new McapExplorerError("CANCELLED", "Attachment extraction cancelled.");
      }
      const chunkLen = dataSize - written < BigInt(windowBytes) ? dataSize - written : BigInt(windowBytes);
      const chunk = await this.#readable.read(dataStart + written, chunkLen);
      await write(chunk);
      written += chunkLen;
    }
    return Number(written);
  }

  /**
   * Rewrites the file to `writable`, applying `spec` (drop/rename topics, time
   * crop, metadata and attachment edits), producing a fresh, fully-indexed
   * MCAP. The source is read-only and never mutated. Requires an indexed source
   * — the rewrite iterates the summary indexes rather than scanning.
   *
   * Copied and newly-added attachments are held in memory one at a time (the
   * writer takes whole payloads); very large attachments cost that much RAM.
   */
  async exportEdited(
    spec: EditSpec,
    writable: IWritable,
    onProgress?: (written: number, total: number) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    const reader = this.#reader;
    if (!reader) {
      throw new McapExplorerError(
        "NO_INDEX",
        "Editing requires an indexed file. Run a full scan first, then reopen it.",
      );
    }

    const dropTopics = new Set(spec.dropTopics);
    const startTime = spec.timeRange ? fromTimeNs(spec.timeRange.start) : undefined;
    const endTime = spec.timeRange ? fromTimeNs(spec.timeRange.end) : undefined;

    const writer = new McapWriter({
      writable,
      useChunks: true,
      useStatistics: true,
      useChunkIndex: true,
      useMessageIndex: true,
      useSummaryOffsets: true,
      useAttachmentIndex: true,
      useMetadataIndex: true,
      repeatSchemas: true,
      repeatChannels: true,
      chunkSize: EXPORT_CHUNK_SIZE,
    });
    await writer.start({ profile: this.#summary.profile, library: this.#summary.library });

    // Mirror schemas/channels lazily as their first message appears, applying
    // topic renames. schemaId 0 means "no schema".
    const schemaMap = new Map<number, number>();
    const channelMap = new Map<number, number>();
    const mapChannel = async (channelId: number): Promise<number | undefined> => {
      const existing = channelMap.get(channelId);
      if (existing !== undefined) {
        return existing;
      }
      const channel = reader.channelsById.get(channelId);
      if (!channel) {
        return undefined;
      }
      let dstSchemaId = 0;
      if (channel.schemaId !== 0) {
        const mapped = schemaMap.get(channel.schemaId);
        if (mapped !== undefined) {
          dstSchemaId = mapped;
        } else {
          const schema = reader.schemasById.get(channel.schemaId);
          if (schema) {
            dstSchemaId = await writer.registerSchema({
              name: schema.name,
              encoding: schema.encoding,
              data: schema.data,
            });
            schemaMap.set(channel.schemaId, dstSchemaId);
          }
        }
      }
      const topic = spec.renameTopics[channel.topic] ?? channel.topic;
      const dstChannelId = await writer.registerChannel({
        schemaId: dstSchemaId,
        topic,
        messageEncoding: channel.messageEncoding,
        metadata: new Map(channel.metadata),
      });
      channelMap.set(channelId, dstChannelId);
      return dstChannelId;
    };

    const total = Number(this.#summary.stats?.messageCount ?? "0");
    let seen = 0;
    for await (const msg of reader.readMessages({ startTime, endTime })) {
      if (signal?.aborted) {
        throw new McapExplorerError("CANCELLED", "Export cancelled.");
      }
      const channel = reader.channelsById.get(msg.channelId);
      if (channel && dropTopics.has(channel.topic)) {
        continue;
      }
      const dstChannelId = await mapChannel(msg.channelId);
      if (dstChannelId === undefined) {
        continue;
      }
      await writer.addMessage({
        channelId: dstChannelId,
        sequence: msg.sequence,
        logTime: msg.logTime,
        publishTime: msg.publishTime,
        data: msg.data,
      });
      seen++;
      if (onProgress && seen % EXPORT_PROGRESS_INTERVAL === 0) {
        onProgress(seen, total);
      }
    }

    // Metadata: copy survivors, then apply upserts (add-or-replace by name).
    const removeMetadata = new Set(spec.metadata.remove);
    const upsertNames = new Set(spec.metadata.upsert.map((m) => m.name));
    for await (const record of reader.readMetadata()) {
      if (signal?.aborted) {
        throw new McapExplorerError("CANCELLED", "Export cancelled.");
      }
      if (removeMetadata.has(record.name) || upsertNames.has(record.name)) {
        continue;
      }
      await writer.addMetadata({ name: record.name, metadata: new Map(record.metadata) });
    }
    for (const record of spec.metadata.upsert) {
      await writer.addMetadata({
        name: record.name,
        metadata: new Map(Object.entries(record.entries)),
      });
    }

    // Attachments: copy survivors (streamed into memory), then add local files.
    const removeAttachments = new Set(spec.attachments.removeIndexes);
    const renameByIndex = new Map(spec.attachments.rename.map((r) => [r.index, r.name] as const));
    for (let i = 0; i < reader.attachmentIndexes.length; i++) {
      if (signal?.aborted) {
        throw new McapExplorerError("CANCELLED", "Export cancelled.");
      }
      if (removeAttachments.has(i)) {
        continue;
      }
      const index = reader.attachmentIndexes[i];
      if (!index) {
        continue;
      }
      const parts: Uint8Array[] = [];
      await this.extractAttachment(
        i,
        async (chunk) => {
          // The readable may reuse its buffer between reads — copy each window.
          parts.push(chunk.slice());
        },
        signal,
      );
      await writer.addAttachment({
        name: renameByIndex.get(i) ?? index.name,
        logTime: index.logTime,
        createTime: index.createTime,
        mediaType: index.mediaType,
        data: concatBytes(parts),
      });
    }
    for (const add of spec.attachments.add) {
      if (signal?.aborted) {
        throw new McapExplorerError("CANCELLED", "Export cancelled.");
      }
      const data = await readFile(add.sourcePath);
      await writer.addAttachment({
        name: add.name,
        logTime: 0n,
        createTime: 0n,
        mediaType: add.mediaType,
        data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
      });
    }

    await writer.end();
    onProgress?.(seen, total);
  }

  /**
   * Reads one page of decoded messages for the given topics via index-based
   * random access (only chunks containing those topics are decompressed).
   * Paginates by count or approximate DTO byte size, whichever comes first,
   * and returns an opaque cursor to continue. Requires an indexed file.
   */
  async queryMessages(
    opts: QueryMessagesOptions,
    signal?: AbortSignal,
  ): Promise<MessagePageDto> {
    const reader = this.#reader;
    if (!reader) {
      throw new McapExplorerError("NO_INDEX", "Message browsing requires an indexed file.");
    }

    const channelIds = new Set<number>();
    for (const channel of reader.channelsById.values()) {
      if (opts.topics.length === 0 || opts.topics.includes(channel.topic)) {
        channelIds.add(channel.id);
      }
    }

    const reverse = opts.reverse ?? false;
    let startTime = opts.start !== undefined ? fromTimeNs(opts.start) : undefined;
    let endTime = opts.end !== undefined ? fromTimeNs(opts.end) : undefined;

    // Cursor continuation: resume from the last message of the previous page.
    let cursorTime: bigint | undefined;
    let cursorSeq: number | undefined;
    if (opts.cursor) {
      const sep = opts.cursor.lastIndexOf(":");
      cursorTime = BigInt(opts.cursor.slice(0, sep));
      cursorSeq = Number(opts.cursor.slice(sep + 1));
      if (reverse) {
        endTime = cursorTime;
      } else {
        startTime = cursorTime;
      }
    }

    // OOM guard: refuse if any chunk we would decompress inflates past the limit.
    this.#guardChunkRange(channelIds, startTime, endTime);

    const messages: MessageDto[] = [];
    let approxBytes = 0;
    let nextCursor: string | undefined;
    let reachedEnd = true;

    const iterator = reader.readMessages({
      topics: opts.topics.length > 0 ? opts.topics : undefined,
      startTime,
      endTime,
      reverse,
    });

    for await (const msg of iterator) {
      if (signal?.aborted) {
        throw new McapExplorerError("CANCELLED", "Message query cancelled.");
      }
      // Skip the boundary message(s) already delivered on the previous page.
      if (cursorTime !== undefined && cursorSeq !== undefined && msg.logTime === cursorTime) {
        if (!reverse && msg.sequence <= cursorSeq) {
          continue;
        }
        if (reverse && msg.sequence >= cursorSeq) {
          continue;
        }
      }

      if (messages.length >= opts.limitCount || approxBytes >= opts.limitBytes) {
        reachedEnd = false; // at least one more message exists beyond this page
        break;
      }

      const dto = await this.#decodeMessage(
        msg.channelId,
        msg.sequence,
        msg.logTime,
        msg.publishTime,
        msg.data,
      );
      messages.push(dto);
      approxBytes += estimateDtoBytes(dto);
      nextCursor = `${dto.logTime}:${dto.sequence}`;
    }

    return { messages, nextCursor: reachedEnd ? undefined : nextCursor, reachedEnd };
  }

  async #decodeMessage(
    channelId: number,
    sequence: number,
    logTime: bigint,
    publishTime: bigint,
    data: Uint8Array,
  ): Promise<MessageDto> {
    const reader = this.#reader!;
    const channel = reader.channelsById.get(channelId);
    const base = {
      channelId,
      topic: channel?.topic ?? `(channel ${channelId})`,
      sequence,
      logTime: toTimeNs(logTime),
      publishTime: toTimeNs(publishTime),
      sizeBytes: data.byteLength,
    };

    const decoder = await this.#getDecoder(channelId);

    try {
      return { ...base, decoder: decoder.id, value: decoder.decode(data) };
    } catch (err) {
      return {
        ...base,
        decoder: decoder.id,
        decodeError: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /** Resolves (and caches) the decoder for a channel via the registry. */
  async #getDecoder(channelId: number): Promise<ChannelDecoder> {
    const cached = this.#decoderCache.get(channelId);
    if (cached) {
      return cached;
    }
    const reader = this.#reader!;
    const channel = reader.channelsById.get(channelId);
    const channelInfo = {
      id: channelId,
      topic: channel?.topic ?? `(channel ${channelId})`,
      messageEncoding: channel?.messageEncoding ?? "",
    };
    const schemaRecord = channel ? reader.schemasById.get(channel.schemaId) : undefined;
    const schemaInfo = schemaRecord
      ? {
          id: schemaRecord.id,
          name: schemaRecord.name,
          encoding: schemaRecord.encoding,
          data: schemaRecord.data,
        }
      : undefined;
    const decoder = await this.#registry.resolve(channelInfo, schemaInfo);
    this.#decoderCache.set(channelId, decoder);
    return decoder;
  }

  /**
   * Downsampled numeric series for a channel. To stay cheap regardless of a
   * topic's frequency, only ~maxPoints messages are decoded: the reader
   * iterates the range but a message is decoded only when its logTime crosses
   * the next time-bucket edge. Requires an indexed file.
   */
  async queryTimeSeries(opts: TimeSeriesOptions, signal?: AbortSignal): Promise<TimeSeriesDto> {
    const reader = this.#reader;
    if (!reader) {
      throw new McapExplorerError("NO_INDEX", "Time-series plotting requires an indexed file.");
    }
    const channel = reader.channelsById.get(opts.channelId);
    if (!channel) {
      throw new McapExplorerError("IO_ERROR", `Channel ${opts.channelId} not found.`);
    }

    const bounds = this.#channelTimeBounds(channel.id);
    let startNs = opts.start !== undefined ? fromTimeNs(opts.start) : (bounds?.min ?? 0n);
    let endNs = opts.end !== undefined ? fromTimeNs(opts.end) : (bounds?.max ?? startNs);
    if (endNs < startNs) {
      endNs = startNs;
    }

    this.#guardChunkRange(new Set([channel.id]), startNs, endNs);

    const maxPoints = Math.max(1, Math.min(opts.maxPoints, MAX_TIMESERIES_POINTS));
    const span = endNs - startNs;
    const bucketNs = span > 0n ? span / BigInt(maxPoints) : 0n;
    const decoder = await this.#getDecoder(channel.id);

    const fields = opts.fields;
    const t: number[] = [];
    const values: (number | null)[][] = fields.map(() => []);
    let sampled = 0;
    let nextEdge = startNs;

    // Decode one representative message per time bucket (bounds decode cost).
    const take = (msg: TypedMcapRecords["Message"]): void => {
      let decoded: DecodedValue | undefined;
      try {
        decoded = decoder.decode(msg.data);
      } catch {
        decoded = undefined; // decode failure → null sample (gap)
      }
      t.push(Number(msg.logTime - startNs) / 1e9);
      for (let fi = 0; fi < fields.length; fi++) {
        values[fi]!.push(decoded === undefined ? null : extractNumericAtPath(decoded, fields[fi]!));
      }
      sampled += 1;
      if (bucketNs > 0n) {
        nextEdge = startNs + ((msg.logTime - startNs) / bucketNs + 1n) * bucketNs;
      }
    };

    // Bound bytes decompressed: if the range's chunks exceed the budget, stride
    // over them so coverage still spans the whole range (gaps between sampled
    // chunks) while reading ≤ budget — zoom in re-queries a narrower, denser
    // range. Chunks are shared across topics, so a full-range read of one topic
    // would otherwise decompress essentially the whole file.
    const relevant = reader.chunkIndexes
      .filter(
        (c) =>
          c.messageIndexOffsets.has(channel.id) &&
          c.messageEndTime >= startNs &&
          c.messageStartTime <= endNs,
      )
      .sort((a, b) => (a.messageStartTime < b.messageStartTime ? -1 : 1));
    let totalBytes = 0n;
    for (const c of relevant) {
      totalBytes += c.uncompressedSize;
    }
    const budget = BigInt(opts.maxScanBytes ?? MAX_PLOT_SCAN_BYTES);
    const stride =
      totalBytes > budget && relevant.length > 0 ? Number((totalBytes + budget - 1n) / budget) : 1;
    let reachedCap = stride > 1;

    const readRange = async (from: bigint, to: bigint): Promise<boolean> => {
      for await (const msg of reader.readMessages({ topics: [channel.topic], startTime: from, endTime: to })) {
        if (signal?.aborted) {
          throw new McapExplorerError("CANCELLED", "Time-series query cancelled.");
        }
        if (bucketNs > 0n && msg.logTime < nextEdge) {
          continue; // skip within-bucket messages without decoding
        }
        take(msg);
        if (sampled >= TIMESERIES_HARD_CAP) {
          reachedCap = true;
          return false;
        }
      }
      return true;
    };

    if (stride <= 1) {
      await readRange(startNs, endNs);
    } else {
      for (let i = 0; i < relevant.length; i += stride) {
        const chunk = relevant[i]!;
        const from = chunk.messageStartTime > startNs ? chunk.messageStartTime : startNs;
        const to = chunk.messageEndTime < endNs ? chunk.messageEndTime : endNs;
        if (!(await readRange(from, to))) {
          break;
        }
      }
    }

    return { startNs: toTimeNs(startNs), fields, t, values, sampled, reachedCap };
  }

  /** Min/max logTime across chunks that contain a channel (default plot range). */
  #channelTimeBounds(channelId: number): { min: bigint; max: bigint } | undefined {
    const reader = this.#reader;
    if (!reader) {
      return undefined;
    }
    let min: bigint | undefined;
    let max: bigint | undefined;
    for (const chunk of reader.chunkIndexes) {
      if (!chunk.messageIndexOffsets.has(channelId)) {
        continue;
      }
      if (min === undefined || chunk.messageStartTime < min) {
        min = chunk.messageStartTime;
      }
      if (max === undefined || chunk.messageEndTime > max) {
        max = chunk.messageEndTime;
      }
    }
    if (min !== undefined && max !== undefined) {
      return { min, max };
    }
    // Fallback to the file-wide range.
    const range = this.#summary.timeRange;
    return range ? { min: fromTimeNs(range.start), max: fromTimeNs(range.end) } : undefined;
  }

  /**
   * OOM guard shared by message and frame reads: refuses to proceed if any
   * chunk we might decompress in [startTime, endTime] for the given channels
   * inflates beyond the configured limit.
   */
  #guardChunkRange(
    channelIds: Set<number>,
    startTime: bigint | undefined,
    endTime: bigint | undefined,
  ): void {
    const reader = this.#reader;
    if (!reader) {
      return;
    }
    const chunkLimit = BigInt(this.#opts.maxChunkUncompressedSize);
    for (const chunk of reader.chunkIndexes) {
      if (startTime !== undefined && chunk.messageEndTime < startTime) {
        continue;
      }
      if (endTime !== undefined && chunk.messageStartTime > endTime) {
        continue;
      }
      let relevant = channelIds.size === 0;
      for (const id of channelIds) {
        if (chunk.messageIndexOffsets.has(id)) {
          relevant = true;
          break;
        }
      }
      if (relevant && chunk.uncompressedSize > chunkLimit) {
        throw new McapExplorerError(
          "CHUNK_TOO_LARGE",
          `A chunk in this range inflates to ${chunk.uncompressedSize} bytes, above the ` +
            `configured limit of ${this.#opts.maxChunkUncompressedSize}.`,
        );
      }
    }
  }

  /**
   * Returns a window of compressed video frames for a channel. When
   * `needKeyframe` is set (a seek), it first walks backward to the nearest
   * keyframe so the returned window is self-decodable from index 0; otherwise
   * it continues forward from the anchor (playback). Frames cross as base64 —
   * a bounded, user-initiated relaxation of the no-bytes-across-bridge rule.
   */
  async getFrameWindow(opts: FrameWindowOptions, signal?: AbortSignal): Promise<VideoFramesDto> {
    const reader = this.#reader;
    if (!reader) {
      throw new McapExplorerError("NO_INDEX", "Video preview requires an indexed file.");
    }
    const channel = reader.channelsById.get(opts.channelId);
    if (!channel) {
      throw new McapExplorerError("IO_ERROR", `Channel ${opts.channelId} not found.`);
    }
    const extractor = await this.#getMediaExtractor(opts.channelId, channel);
    if (extractor.kind !== "video") {
      throw new McapExplorerError("NOT_PREVIEWABLE", `Channel ${channel.topic} is not a video channel.`);
    }

    const channelIds = new Set([channel.id]);
    const anchorTime = fromTimeNs(opts.anchor.logTime);
    const count = Math.max(1, Math.min(opts.count, DEFAULT_MAX_FRAME_COUNT));

    // Resolve the read start (inclusive): the preceding keyframe on a seek, or
    // the anchor itself on a continuation/pagination step.
    let startTime: bigint;
    let startSeq: number;
    if (opts.needKeyframe) {
      this.#guardChunkRange(channelIds, undefined, anchorTime);
      const kf = await this.#findKeyframeBefore(channel.topic, extractor, anchorTime, opts.anchor.sequence, signal);
      startTime = kf.logTime;
      startSeq = kf.sequence;
    } else {
      this.#guardChunkRange(channelIds, anchorTime, anchorTime);
      startTime = anchorTime;
      startSeq = opts.anchor.sequence;
    }

    const frames: VideoFrameDto[] = [];
    let codec: VideoCodec | undefined;
    let keyframePayload: Uint8Array | undefined;
    let totalBytes = 0;
    let reachedEnd = true;
    let nextAnchor: { logTime: TimeNs; sequence: number } | undefined;
    let reachedAnchor = !opts.needKeyframe; // a seek must span up to its anchor frame

    for await (const msg of reader.readMessages({ topics: [channel.topic], startTime })) {
      if (signal?.aborted) {
        throw new McapExplorerError("CANCELLED", "Frame query cancelled.");
      }
      // Skip only frames before the (inclusive) start at the start timestamp.
      if (msg.logTime === startTime && msg.sequence < startSeq) {
        continue;
      }

      const media = extractor.extract(msg.data);
      codec ??= normalizeCodec(media.format);
      if (!codec) {
        throw new McapExplorerError("NOT_PREVIEWABLE", `Unsupported video format "${media.format}".`);
      }
      const len = media.payload.byteLength;
      if (len > DEFAULT_MAX_FRAME_BYTES) {
        throw new McapExplorerError("FRAME_TOO_LARGE", `A single frame is ${len} bytes, above the preview limit.`);
      }

      // Stop only once the anchor is covered, so a seek always reaches its frame.
      if (
        reachedAnchor &&
        (frames.length >= count ||
          (frames.length > 0 && totalBytes + len > DEFAULT_MAX_FRAME_WINDOW_BYTES))
      ) {
        reachedEnd = false;
        nextAnchor = { logTime: toTimeNs(msg.logTime), sequence: msg.sequence };
        break;
      }

      const keyframe = classifyFrame(media.payload, codec).keyframe;
      if (keyframe && !keyframePayload) {
        keyframePayload = media.payload.slice();
      }
      frames.push({
        sequence: msg.sequence,
        logTime: toTimeNs(msg.logTime),
        keyframe,
        dataBase64: toBase64(media.payload),
      });
      totalBytes += len;
      if (
        !reachedAnchor &&
        (msg.logTime > anchorTime || (msg.logTime === anchorTime && msg.sequence >= opts.anchor.sequence))
      ) {
        reachedAnchor = true;
      }
    }

    return {
      codec: codec ?? "h264",
      codecString: codec ? codecStringFor(codec, keyframePayload) : "",
      frames,
      keyframeIndex: frames.findIndex((f) => f.keyframe),
      reachedEnd,
      nextAnchor,
      totalBytes,
    };
  }

  /** Returns one image message decoded to renderable form (compressed or raw). */
  async getImageFrame(opts: ImageFrameOptions, signal?: AbortSignal): Promise<ImageFrameDto> {
    const reader = this.#reader;
    if (!reader) {
      throw new McapExplorerError("NO_INDEX", "Image preview requires an indexed file.");
    }
    const channel = reader.channelsById.get(opts.channelId);
    if (!channel) {
      throw new McapExplorerError("IO_ERROR", `Channel ${opts.channelId} not found.`);
    }
    const extractor = await this.#getMediaExtractor(opts.channelId, channel);
    if (extractor.kind === "video") {
      throw new McapExplorerError("NOT_PREVIEWABLE", `Channel ${channel.topic} is video; use the video player.`);
    }
    const targetTime = fromTimeNs(opts.target.logTime);
    this.#guardChunkRange(new Set([channel.id]), targetTime, targetTime);

    const msg = await this.#findMessage(channel.topic, targetTime, opts.target.sequence, signal);
    if (!msg) {
      throw new McapExplorerError("IO_ERROR", "Message not found for image preview.");
    }
    if (msg.data.byteLength > DEFAULT_MAX_FRAME_BYTES) {
      throw new McapExplorerError("FRAME_TOO_LARGE", `Image is ${msg.data.byteLength} bytes, above the preview limit.`);
    }
    const media = extractor.extract(msg.data);
    return {
      kind: extractor.kind === "image-raw" ? "raw" : "compressed",
      format: media.format,
      width: media.width,
      height: media.height,
      step: media.step,
      sequence: msg.sequence,
      logTime: toTimeNs(msg.logTime),
      dataBase64: toBase64(media.payload),
    };
  }

  async #findKeyframeBefore(
    topic: string,
    extractor: MediaExtractor,
    anchorTime: bigint,
    anchorSeq: number,
    signal?: AbortSignal,
  ): Promise<{ logTime: bigint; sequence: number }> {
    const reader = this.#reader!;
    let scanned = 0;
    for await (const msg of reader.readMessages({ topics: [topic], endTime: anchorTime, reverse: true })) {
      if (signal?.aborted) {
        throw new McapExplorerError("CANCELLED", "Frame query cancelled.");
      }
      // Ignore frames after the anchor that share its timestamp.
      if (msg.logTime === anchorTime && msg.sequence > anchorSeq) {
        continue;
      }
      const media = extractor.extract(msg.data);
      const codec = normalizeCodec(media.format);
      if (!codec) {
        throw new McapExplorerError("NOT_PREVIEWABLE", `Unsupported video format "${media.format}".`);
      }
      if (classifyFrame(media.payload, codec).keyframe) {
        return { logTime: msg.logTime, sequence: msg.sequence };
      }
      if (++scanned >= DEFAULT_MAX_KEYFRAME_LOOKBACK) {
        break;
      }
    }
    throw new McapExplorerError(
      "NO_KEYFRAME_IN_RANGE",
      `No keyframe within ${DEFAULT_MAX_KEYFRAME_LOOKBACK} frames before the selected frame.`,
    );
  }

  async #findMessage(
    topic: string,
    time: bigint,
    sequence: number,
    signal?: AbortSignal,
  ): Promise<TypedMcapRecords["Message"] | undefined> {
    const reader = this.#reader!;
    let firstAtTime: TypedMcapRecords["Message"] | undefined;
    for await (const msg of reader.readMessages({ topics: [topic], startTime: time, endTime: time })) {
      if (signal?.aborted) {
        throw new McapExplorerError("CANCELLED", "Image query cancelled.");
      }
      if (msg.sequence === sequence) {
        return msg;
      }
      if (!firstAtTime) {
        firstAtTime = msg;
      }
    }
    return firstAtTime;
  }

  async #getMediaExtractor(
    channelId: number,
    channel: Channel,
  ): Promise<MediaExtractor> {
    if (this.#mediaExtractorCache.has(channelId)) {
      const cached = this.#mediaExtractorCache.get(channelId) ?? null;
      if (!cached) {
        throw new McapExplorerError("NOT_PREVIEWABLE", `Channel ${channel.topic} has no image/video preview.`);
      }
      return cached;
    }
    const schemaRecord = this.#reader!.schemasById.get(channel.schemaId);
    const schemaInfo = schemaRecord
      ? { name: schemaRecord.name, encoding: schemaRecord.encoding, data: schemaRecord.data }
      : undefined;
    let extractor: MediaExtractor | null = null;
    try {
      extractor = await createMediaExtractor(channel.messageEncoding, schemaInfo);
    } catch {
      extractor = null;
    }
    this.#mediaExtractorCache.set(channelId, extractor);
    if (!extractor) {
      throw new McapExplorerError(
        "NOT_PREVIEWABLE",
        `Channel ${channel.topic} (${schemaRecord?.name ?? "no schema"}) has no image/video preview.`,
      );
    }
    return extractor;
  }
}

/** Rough JSON-size estimate for pagination (avoids full stringify per field). */
function estimateDtoBytes(dto: MessageDto): number {
  const valueSize = dto.value !== undefined ? JSON.stringify(dto.value).length : 0;
  return valueSize + 128;
}

/** Base64-encode a byte view (Node Buffer; respects offset/length). */
function toBase64(data: Uint8Array): string {
  return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("base64");
}

/** Concatenate byte chunks into one contiguous Uint8Array. */
function concatBytes(parts: Uint8Array[]): Uint8Array {
  if (parts.length === 1) {
    return parts[0]!;
  }
  const total = parts.reduce((n, p) => n + p.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

/**
 * Walks a dotted path (e.g. "angular_velocity.x", "data.3") into a decoded
 * value and returns a finite number, or null if the path is missing or the
 * leaf is not numeric. Numeric strings (int64/uint64 render as strings) parse.
 */
export function extractNumericAtPath(value: DecodedValue, path: string): number | null {
  let cur: DecodedValue = value;
  const parts = path === "" ? [] : path.split(".");
  for (const part of parts) {
    if (cur === null || typeof cur !== "object") {
      return null;
    }
    if (Array.isArray(cur)) {
      const idx = Number(part);
      if (!Number.isInteger(idx) || idx < 0 || idx >= cur.length) {
        return null;
      }
      cur = cur[idx]!;
    } else {
      if ((cur as { type?: unknown }).type === "bytes") {
        return null;
      }
      const next = (cur as { [k: string]: DecodedValue })[part];
      if (next === undefined) {
        return null;
      }
      cur = next;
    }
  }
  if (typeof cur === "number") {
    return Number.isFinite(cur) ? cur : null;
  }
  if (typeof cur === "string") {
    const n = Number(cur);
    return cur.trim() !== "" && Number.isFinite(n) ? n : null;
  }
  return null;
}

function buildIndexedSummary(reader: McapIndexedReader, opts: SessionOptions): SummaryDto {
  const stats = reader.statistics;

  let timeRange: TimeRangeDto | undefined;
  if (stats && stats.messageCount > 0n) {
    timeRange = { start: toTimeNs(stats.messageStartTime), end: toTimeNs(stats.messageEndTime) };
  } else if (reader.chunkIndexes.length > 0) {
    let min: bigint | undefined;
    let max: bigint | undefined;
    for (const chunk of reader.chunkIndexes) {
      if (min === undefined || chunk.messageStartTime < min) {
        min = chunk.messageStartTime;
      }
      if (max === undefined || chunk.messageEndTime > max) {
        max = chunk.messageEndTime;
      }
    }
    if (min !== undefined && max !== undefined) {
      timeRange = { start: toTimeNs(min), end: toTimeNs(max) };
    }
  }

  const compressions: Record<string, number> = {};
  let maxUncompressed = 0n;
  for (const chunk of reader.chunkIndexes) {
    compressions[chunk.compression] = (compressions[chunk.compression] ?? 0) + 1;
    if (chunk.uncompressedSize > maxUncompressed) {
      maxUncompressed = chunk.uncompressedSize;
    }
  }
  const chunks: ChunksDto = {
    count: reader.chunkIndexes.length,
    compressions,
    maxUncompressedSize: maxUncompressed.toString(),
  };

  return {
    fileName: opts.fileName,
    fileSize: opts.fileSize,
    profile: reader.header.profile,
    library: reader.header.library,
    indexed: true,
    stats: stats
      ? {
          messageCount: stats.messageCount.toString(),
          schemaCount: stats.schemaCount,
          channelCount: stats.channelCount,
          attachmentCount: stats.attachmentCount,
          metadataCount: stats.metadataCount,
          chunkCount: stats.chunkCount,
        }
      : undefined,
    timeRange,
    channels: buildChannelDtos(
      reader.channelsById,
      reader.schemasById,
      stats?.channelMessageCounts,
      timeRange,
    ),
    schemas: [...reader.schemasById.values()].map(toSchemaDto),
    attachments: reader.attachmentIndexes.map((idx, position) => ({
      index: position,
      name: idx.name,
      mediaType: idx.mediaType,
      dataSize: idx.dataSize.toString(),
      logTime: toTimeNs(idx.logTime),
      createTime: toTimeNs(idx.createTime),
    })),
    metadata: reader.metadataIndexes.map((idx) => ({ name: idx.name })),
    chunks,
  };
}

function buildChannelDtos(
  channels: ReadonlyMap<number, Channel>,
  schemas: ReadonlyMap<number, Schema>,
  messageCounts: ReadonlyMap<number, bigint> | undefined,
  timeRange: TimeRangeDto | undefined,
): ChannelDto[] {
  const durationNs = timeRange ? durationBetween(timeRange.start, timeRange.end) : 0n;
  const dtos: ChannelDto[] = [];
  for (const channel of channels.values()) {
    const schema = schemas.get(channel.schemaId);
    const count = messageCounts?.get(channel.id);
    dtos.push({
      id: channel.id,
      topic: channel.topic,
      schemaId: channel.schemaId,
      schemaName: schema?.name ?? (channel.schemaId === 0 ? "(no schema)" : `(schema ${channel.schemaId})`),
      schemaEncoding: schema?.encoding ?? "",
      messageEncoding: channel.messageEncoding,
      messageCount: count?.toString(),
      freqHz: count !== undefined ? frequencyHz(count, durationNs) : undefined,
      preview: schema ? mediaKindForSchema(schema.name) : undefined,
    });
  }
  dtos.sort((a, b) => a.topic.localeCompare(b.topic));
  return dtos;
}

function toSchemaDto(schema: Schema): SchemaDto {
  return {
    id: schema.id,
    name: schema.name,
    encoding: schema.encoding,
    dataLength: schema.data.byteLength,
  };
}

const TEXT_SCHEMA_ENCODINGS = new Set(["jsonschema", "ros1msg", "ros2msg", "ros2idl", "omgidl"]);

function formatSchemaSource(schema: Schema): SchemaSourceDto {
  const total = schema.data.byteLength;
  if (TEXT_SCHEMA_ENCODINGS.has(schema.encoding) || looksLikeUtf8Text(schema.data)) {
    const slice = schema.data.subarray(0, SCHEMA_TEXT_LIMIT);
    return {
      schemaId: schema.id,
      kind: "text",
      content: new TextDecoder("utf-8", { fatal: false }).decode(slice),
      truncated: total > SCHEMA_TEXT_LIMIT,
      totalLength: total,
    };
  }
  const slice = schema.data.subarray(0, SCHEMA_HEX_LIMIT);
  return {
    schemaId: schema.id,
    kind: "hex",
    content: formatHexDump(slice),
    truncated: total > SCHEMA_HEX_LIMIT,
    totalLength: total,
  };
}

function looksLikeUtf8Text(data: Uint8Array): boolean {
  const probe = data.subarray(0, 4096);
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(probe);
    // Reject control characters other than common whitespace.
    // eslint-disable-next-line no-control-regex
    return !/[\x00-\x08\x0B\x0C\x0E-\x1F]/.test(text);
  } catch {
    return false;
  }
}

export function formatHexDump(data: Uint8Array): string {
  const lines: string[] = [];
  for (let offset = 0; offset < data.length; offset += 16) {
    const row = data.subarray(offset, offset + 16);
    const hex = [...row].map((b) => b.toString(16).padStart(2, "0")).join(" ");
    const ascii = [...row].map((b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : ".")).join("");
    lines.push(`${offset.toString(16).padStart(8, "0")}  ${hex.padEnd(47)}  ${ascii}`);
  }
  return lines.join("\n");
}

async function tryReadHeader(
  readable: IReadable,
  opts: SessionOptions,
): Promise<TypedMcapRecords["Header"] | undefined> {
  try {
    const length = Math.min(64 * 1024, opts.fileSize);
    const bytes = await readable.read(0n, BigInt(length));
    const reader = new McapStreamReader({ validateCrcs: false });
    reader.append(bytes);
    for (let record; (record = reader.nextRecord()); ) {
      if (record.type === "Header") {
        return record;
      }
    }
  } catch {
    // Header unreadable — the caller falls back to empty profile/library.
  }
  return undefined;
}
