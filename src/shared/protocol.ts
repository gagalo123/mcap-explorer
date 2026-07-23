import type {
  AttachmentSourceDto,
  EditSpec,
  ExportResultDto,
  ImageFrameDto,
  MessagePageDto,
  MetadataDto,
  SaveAttachmentResultDto,
  SchemaSourceDto,
  SummaryDto,
  TimeSeriesDto,
  VideoFramesDto,
} from "./dto";
import type { TimeNs } from "./time";

export type ErrCode =
  | "NOT_MCAP"
  | "TRUNCATED"
  | "NO_INDEX"
  | "CHUNK_TOO_LARGE"
  | "CANCELLED"
  | "IO_ERROR"
  | "UNSUPPORTED_SCHEME"
  | "UNSUPPORTED_OP"
  | "NO_KEYFRAME_IN_RANGE"
  | "FRAME_TOO_LARGE"
  | "NOT_PREVIEWABLE";

export interface ErrorDto {
  code: ErrCode;
  message: string;
}

// ---- webview → host ----

export type RequestOp =
  | { op: "getSummary" }
  | { op: "getSchemaSource"; schemaId: number }
  | { op: "getMetadata"; name: string }
  | { op: "saveAttachment"; attachmentIndex: number }
  | { op: "scanUnindexed" }
  // Phase 2+ (declared so the contract is stable; host answers UNSUPPORTED_OP until implemented):
  | {
      op: "queryMessages";
      topics: string[];
      start?: TimeNs;
      end?: TimeNs;
      reverse?: boolean;
      cursor?: string;
      limitCount: number;
      limitBytes: number;
    }
  | { op: "getAttachmentPreview"; attachmentIndex: number }
  // Phase 3 — image/video preview (frame bytes cross as base64, on demand):
  | {
      op: "getFrameWindow";
      channelId: number;
      anchor: { logTime: TimeNs; sequence: number };
      /** Number of frames to return (from the keyframe when needKeyframe). */
      count: number;
      /** Seek: find the preceding keyframe first. False: continue playback forward. */
      needKeyframe: boolean;
    }
  | { op: "getImageFrame"; channelId: number; target: { logTime: TimeNs; sequence: number } }
  // Phase 4 — numeric time-series plotting (downsampled server-side):
  | {
      op: "queryTimeSeries";
      channelId: number;
      fields: string[];
      start?: TimeNs;
      end?: TimeNs;
      maxPoints: number;
    }
  // Phase 5 — manual editing (rewrite to a new file; source is never mutated):
  | { op: "pickAttachmentFile" }
  | { op: "exportEdited"; spec: EditSpec };

export type WebviewToHost =
  | { kind: "request"; id: number; op: RequestOp }
  | { kind: "cancel"; id: number }
  | { kind: "ready" };

// ---- host → webview ----

export type ResponseBody =
  | { type: "summary"; summary: SummaryDto }
  | { type: "schemaSource"; source: SchemaSourceDto }
  | { type: "metadata"; records: MetadataDto[] }
  | { type: "saveAttachment"; result: SaveAttachmentResultDto }
  | { type: "messages"; page: MessagePageDto }
  | { type: "videoFrames"; data: VideoFramesDto }
  | { type: "imageFrame"; data: ImageFrameDto }
  | { type: "timeSeries"; data: TimeSeriesDto }
  | { type: "attachmentSource"; source?: AttachmentSourceDto }
  | { type: "exportResult"; result: ExportResultDto };

export type HostToWebview =
  | { kind: "init"; summary?: SummaryDto; error?: ErrorDto }
  | { kind: "response"; id: number; ok: true; body: ResponseBody }
  | { kind: "response"; id: number; ok: false; error: ErrorDto }
  | { kind: "progress"; id: number; loadedBytes: number; totalBytes?: number; note?: string }
  | {
      kind: "batch";
      id: number;
      seq: number;
      done: boolean;
      items: unknown[];
      nextCursor?: string;
    };
