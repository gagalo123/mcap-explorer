import { open, unlink } from "node:fs/promises";

import * as vscode from "vscode";

import { McapExplorerError } from "./errors";
import type { McapFileSession } from "./readerService";
import type { SaveAttachmentResultDto } from "../shared/dto";

/**
 * Prompts for a destination and streams the attachment to disk in fixed
 * windows — the payload is never held in memory as a whole. On cancellation
 * the partial file is removed.
 */
export async function saveAttachmentInteractive(
  session: McapFileSession,
  attachmentIndex: number,
  signal: AbortSignal,
): Promise<SaveAttachmentResultDto> {
  const attachment = session.summary().attachments[attachmentIndex];
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri;
  const defaultName = attachment?.name ?? `attachment-${attachmentIndex}`;
  const target = await vscode.window.showSaveDialog({
    defaultUri: workspaceRoot ? vscode.Uri.joinPath(workspaceRoot, defaultName) : undefined,
    saveLabel: "Save attachment",
  });
  if (!target) {
    return { saved: false };
  }

  const out = await open(target.fsPath, "w");
  try {
    const bytesWritten = await session.extractAttachment(
      attachmentIndex,
      async (chunk) => {
        // FileHandle.write can report a short write; loop until done.
        let offset = 0;
        while (offset < chunk.byteLength) {
          const { bytesWritten: n } = await out.write(chunk, offset);
          offset += n;
        }
      },
      signal,
    );
    return { saved: true, targetPath: target.fsPath, bytesWritten };
  } catch (err) {
    await out.close().catch(() => {});
    if (err instanceof McapExplorerError && err.code === "CANCELLED") {
      await unlink(target.fsPath).catch(() => {});
    }
    throw err;
  } finally {
    await out.close().catch(() => {});
  }
}
