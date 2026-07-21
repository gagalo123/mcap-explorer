import * as vscode from "vscode";

import { McapDocument } from "./mcapDocument";
import { RpcHost } from "./rpcHost";

export class McapEditorProvider implements vscode.CustomReadonlyEditorProvider<McapDocument> {
  static readonly viewType = "mcapExplorer.viewer";

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly output: vscode.OutputChannel,
  ) {}

  static register(
    context: vscode.ExtensionContext,
    output: vscode.OutputChannel,
  ): vscode.Disposable {
    return vscode.window.registerCustomEditorProvider(
      McapEditorProvider.viewType,
      new McapEditorProvider(context.extensionUri, output),
      {
        webviewOptions: { retainContextWhenHidden: false },
        supportsMultipleEditorsPerDocument: true,
      },
    );
  }

  async openCustomDocument(uri: vscode.Uri): Promise<McapDocument> {
    return await McapDocument.create(uri);
  }

  async resolveCustomEditor(
    document: McapDocument,
    panel: vscode.WebviewPanel,
  ): Promise<void> {
    panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "dist")],
    };
    panel.webview.html = this.#renderHtml(panel.webview);

    const host = new RpcHost(panel.webview, document, (message) =>
      this.output.appendLine(message),
    );
    panel.onDidDispose(() => host.dispose());
  }

  #renderHtml(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "dist", "webview.js"),
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "dist", "webview.css"),
    );
    const nonce = makeNonce();
    const csp = [
      "default-src 'none'",
      `style-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}'`,
      `img-src ${webview.cspSource} data:`,
      `font-src ${webview.cspSource}`,
    ].join("; ");

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link href="${styleUri.toString()}" rel="stylesheet">
  <title>MCAP Explorer</title>
</head>
<body>
  <div id="root"></div>
  <script nonce="${nonce}" src="${scriptUri.toString()}"></script>
</body>
</html>`;
  }
}

function makeNonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let nonce = "";
  for (let i = 0; i < 32; i++) {
    nonce += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return nonce;
}
