import * as vscode from "vscode";

import { McapEditorProvider } from "./mcapEditorProvider";
import { showInfo } from "./showInfo";

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel("MCAP Explorer");
  context.subscriptions.push(output);
  context.subscriptions.push(McapEditorProvider.register(context, output));
  context.subscriptions.push(
    vscode.commands.registerCommand("mcapExplorer.showInfo", (uri?: vscode.Uri) =>
      showInfo(uri, output),
    ),
  );
}

export function deactivate(): void {
  // Documents dispose their own file handles.
}
