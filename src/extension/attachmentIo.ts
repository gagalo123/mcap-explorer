import { open } from "node:fs/promises";
import * as path from "node:path";

import type { McapFileSession } from "./readerService";

/**
 * Streams an attachment's bytes to `fsPath` in fixed windows — the payload is
 * never materialized whole in memory. Returns the number of bytes written. The
 * file handle is always closed; callers own any partial-file cleanup (e.g. on
 * cancellation).
 */
export async function streamAttachmentToFile(
  session: McapFileSession,
  attachmentIndex: number,
  fsPath: string,
  signal: AbortSignal,
): Promise<number> {
  const out = await open(fsPath, "w");
  try {
    return await session.extractAttachment(
      attachmentIndex,
      async (chunk) => {
        // FileHandle.write can report a short write; loop until the whole
        // chunk is flushed.
        let offset = 0;
        while (offset < chunk.byteLength) {
          offset += (await out.write(chunk, offset)).bytesWritten;
        }
      },
      signal,
    );
  } finally {
    await out.close().catch(() => {});
  }
}

/**
 * Derives a safe, single-component file name for an attachment. Directory
 * components and traversal segments (`.`/`..`) are stripped; when the name
 * carries no extension, one is inferred from the media type so editors that
 * dispatch on extension (e.g. VS Code's image/text viewers) open it correctly.
 */
export function safeAttachmentFileName(
  name: string,
  index: number,
  mediaType?: string,
): string {
  const normalized = (name ?? "").replace(/\\/g, "/");
  const base = path.posix.basename(normalized).trim();
  let fileName = base && base !== "." && base !== ".." ? base : `attachment-${index}`;
  if (!path.posix.extname(fileName)) {
    fileName += extensionForMediaType(mediaType) ?? "";
  }
  return fileName;
}

function extensionForMediaType(mediaType?: string): string | undefined {
  if (!mediaType) {
    return undefined;
  }
  const type = (mediaType.split(";")[0] ?? "").trim().toLowerCase();
  return MEDIA_TYPE_EXTENSIONS[type];
}

const MEDIA_TYPE_EXTENSIONS: Record<string, string> = {
  "application/json": ".json",
  "application/pdf": ".pdf",
  "application/xml": ".xml",
  "application/yaml": ".yaml",
  "application/x-yaml": ".yaml",
  "application/octet-stream": ".bin",
  "text/plain": ".txt",
  "text/csv": ".csv",
  "text/markdown": ".md",
  "text/html": ".html",
  "text/xml": ".xml",
  "text/yaml": ".yaml",
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/bmp": ".bmp",
  "image/svg+xml": ".svg",
  "image/tiff": ".tiff",
};
