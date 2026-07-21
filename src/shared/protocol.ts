import type {
  MetadataDto,
  SaveAttachmentResultDto,
  SchemaSourceDto,
  SummaryDto,
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
  | "UNSUPPORTED_OP";

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
  | { op: "getAttachmentPreview"; attachmentIndex: number };

export type WebviewToHost =
  | { kind: "request"; id: number; op: RequestOp }
  | { kind: "cancel"; id: number }
  | { kind: "ready" };

// ---- host → webview ----

export type ResponseBody =
  | { type: "summary"; summary: SummaryDto }
  | { type: "schemaSource"; source: SchemaSourceDto }
  | { type: "metadata"; records: MetadataDto[] }
  | { type: "saveAttachment"; result: SaveAttachmentResultDto };

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
