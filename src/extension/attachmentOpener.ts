import { mkdir, unlink } from "node:fs/promises";
import * as path from "node:path";

import * as vscode from "vscode";

import { safeAttachmentFileName, streamAttachmentToFile } from "./attachmentIo";
import { McapExplorerError } from "./errors";
import type { McapFileSession } from "./readerService";
import type { OpenAttachmentResultDto } from "../shared/dto";

/**
 * Extracts an attachment to a scratch file and opens it beside the explorer in
 * a VS Code editor, letting VS Code's built-in viewers (image preview, text
 * editor, hex) render it by file type. The payload is streamed straight to
 * disk — never held whole in memory and never sent across the webview bridge.
 * On cancellation the partial file is removed.
 */
export async function openAttachmentInEditor(
  session: McapFileSession,
  attachmentIndex: number,
  scratchDir: vscode.Uri,
  signal: AbortSignal,
): Promise<OpenAttachmentResultDto> {
  const attachment = session.summary().attachments[attachmentIndex];
  const fileName = safeAttachmentFileName(
    attachment?.name ?? "",
    attachmentIndex,
    attachment?.mediaType,
  );
  await mkdir(scratchDir.fsPath, { recursive: true });
  const targetPath = path.join(scratchDir.fsPath, `${attachmentIndex}-${fileName}`);

  try {
    const bytesWritten = await streamAttachmentToFile(
      session,
      attachmentIndex,
      targetPath,
      signal,
    );
    await vscode.commands.executeCommand("vscode.open", vscode.Uri.file(targetPath), {
      viewColumn: vscode.ViewColumn.Beside,
      preview: true,
    });
    return { opened: true, targetPath, bytesWritten };
  } catch (err) {
    if (err instanceof McapExplorerError && err.code === "CANCELLED") {
      await unlink(targetPath).catch(() => {});
    }
    throw err;
  }
}
