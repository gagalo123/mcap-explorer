import { open, stat, unlink } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";

import { FileHandleWritable } from "@mcap/nodejs";
import * as vscode from "vscode";

import { McapExplorerError } from "./errors";
import type { McapFileSession } from "./readerService";
import type { AttachmentSourceDto, EditSpec, ExportResultDto } from "../shared/dto";

/**
 * Prompts for a destination and rewrites the (read-only) source MCAP into a new
 * file with `spec` applied. The source is never mutated; on error or cancel the
 * partially-written output is removed.
 */
export async function exportEditedInteractive(
  session: McapFileSession,
  spec: EditSpec,
  source: vscode.Uri,
  onProgress: (written: number, total: number) => void,
  signal: AbortSignal,
): Promise<ExportResultDto> {
  const base = basename(source.fsPath, extname(source.fsPath));
  const defaultUri = vscode.Uri.file(join(dirname(source.fsPath), `${base}-edited.mcap`));
  const target = await vscode.window.showSaveDialog({
    defaultUri,
    saveLabel: "Export edited MCAP",
    filters: { MCAP: ["mcap"] },
  });
  if (!target) {
    return { saved: false };
  }
  if (resolve(target.fsPath) === resolve(source.fsPath)) {
    throw new McapExplorerError(
      "IO_ERROR",
      "Choose a different destination — the edited file cannot overwrite the file being edited.",
    );
  }

  const handle = await open(target.fsPath, "w");
  const writable = new FileHandleWritable(handle);
  try {
    await session.exportEdited(spec, writable, onProgress, signal);
    const bytesWritten = Number(writable.position());
    await handle.close();
    return { saved: true, targetPath: target.fsPath, bytesWritten };
  } catch (err) {
    await handle.close().catch(() => {});
    // We created this file; a partial rewrite is unusable, so remove it.
    await unlink(target.fsPath).catch(() => {});
    throw err;
  }
}

/**
 * Lets the user pick a local file to attach. Returns its path, a default name,
 * a guessed media type and size; undefined when the dialog is cancelled.
 */
export async function pickAttachmentSource(): Promise<AttachmentSourceDto | undefined> {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri;
  const picked = await vscode.window.showOpenDialog({
    canSelectMany: false,
    openLabel: "Add as attachment",
    defaultUri: workspaceRoot,
  });
  const file = picked?.[0];
  if (!file) {
    return undefined;
  }
  const info = await stat(file.fsPath);
  const name = basename(file.fsPath);
  return {
    path: file.fsPath,
    name,
    mediaType: guessMediaType(name),
    dataSize: info.size.toString(10),
  };
}

const MEDIA_TYPES: Record<string, string> = {
  ".json": "application/json",
  ".txt": "text/plain",
  ".csv": "text/csv",
  ".yaml": "application/yaml",
  ".yml": "application/yaml",
  ".xml": "application/xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".pdf": "application/pdf",
  ".bin": "application/octet-stream",
};

function guessMediaType(name: string): string {
  return MEDIA_TYPES[extname(name).toLowerCase()] ?? "application/octet-stream";
}
