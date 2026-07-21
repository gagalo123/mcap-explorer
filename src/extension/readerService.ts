import { hasMcapPrefix, McapIndexedReader, McapStreamReader, Opcode } from "@mcap/core";
import type { DecompressHandlers, IReadable, TypedMcapRecords } from "@mcap/core";

import { DecoderRegistry } from "./decoders/registry";
import type { ChannelDecoder } from "./decoders/types";
import { McapExplorerError } from "./errors";
import type {
  AttachmentIndexDto,
  ChannelDto,
  ChunksDto,
  MessageDto,
  MessagePageDto,
  MetadataDto,
  SchemaDto,
  SchemaSourceDto,
  StatsDto,
  SummaryDto,
  TimeRangeDto,
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

const SCAN_WINDOW_BYTES = 4 * 1024 * 1024;
const SCAN_PROGRESS_INTERVAL_BYTES = 64 * 1024 * 1024;
const SCHEMA_TEXT_LIMIT = 256 * 1024;
const SCHEMA_HEX_LIMIT = 4 * 1024;
const SCAN_METADATA_LIMIT = 10_000;
const ATTACHMENT_WINDOW_BYTES = 4 * 1024 * 1024;

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

    let decoder = this.#decoderCache.get(channelId);
    if (!decoder) {
      const channelInfo = {
        id: channelId,
        topic: base.topic,
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
      decoder = await this.#registry.resolve(channelInfo, schemaInfo);
      this.#decoderCache.set(channelId, decoder);
    }

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
}

/** Rough JSON-size estimate for pagination (avoids full stringify per field). */
function estimateDtoBytes(dto: MessageDto): number {
  const valueSize = dto.value !== undefined ? JSON.stringify(dto.value).length : 0;
  return valueSize + 128;
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
