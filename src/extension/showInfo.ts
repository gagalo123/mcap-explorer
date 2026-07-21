import * as vscode from "vscode";

import { McapDocument } from "./mcapDocument";
import { textSummary } from "./textSummary";

/** "MCAP: Show Info" — plain-text summary in an output channel, no editor. */
export async function showInfo(
  uri: vscode.Uri | undefined,
  output: vscode.OutputChannel,
): Promise<void> {
  let target = uri;
  if (!target) {
    const picked = await vscode.window.showOpenDialog({
      canSelectMany: false,
      filters: { MCAP: ["mcap"] },
    });
    target = picked?.[0];
  }
  if (!target) {
    return;
  }

  const document = await McapDocument.create(target);
  try {
    if (!document.session) {
      output.appendLine(`\n=== ${target.fsPath} ===`);
      output.appendLine(
        `ERROR ${document.openError?.code ?? "IO_ERROR"}: ${document.openError?.message ?? "open failed"}`,
      );
      output.show(true);
      return;
    }
    output.appendLine(textSummary(target.fsPath, document.session.summary()));
    output.show(true);
  } finally {
    document.dispose();
  }
}
