import { open } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { basename } from "node:path";

import { FileHandleReadable } from "@mcap/nodejs";
import { loadDecompressHandlers } from "@mcap/support";
import * as vscode from "vscode";

import { McapExplorerError, toErrorDto } from "./errors";
import { MeteredReadable } from "./meteredReadable";
import { McapFileSession } from "./readerService";
import type { ErrorDto } from "../shared/protocol";

const DEFAULT_MAX_CHUNK_UNCOMPRESSED = 256 * 1024 * 1024;

/**
 * One open .mcap file. VSCode shares a single CustomDocument across editors
 * for the same resource, so the FileHandle and summary cache are shared too.
 */
export class McapDocument implements vscode.CustomDocument {
  private constructor(
    readonly uri: vscode.Uri,
    private readonly handle: FileHandle | undefined,
    readonly metered: MeteredReadable | undefined,
    readonly session: McapFileSession | undefined,
    readonly openError: ErrorDto | undefined,
  ) {}

  static async create(uri: vscode.Uri): Promise<McapDocument> {
    if (uri.scheme !== "file") {
      return new McapDocument(
        uri,
        undefined,
        undefined,
        undefined,
        toErrorDto(
          new McapExplorerError(
            "UNSUPPORTED_SCHEME",
            `Only local files are supported (got scheme "${uri.scheme}").`,
          ),
        ),
      );
    }

    let handle: FileHandle | undefined;
    try {
      handle = await open(uri.fsPath, "r");
      const stat = await handle.stat();
      const metered = new MeteredReadable(new FileHandleReadable(handle));
      const session = await McapFileSession.open(metered, {
        fileName: basename(uri.fsPath),
        fileSize: stat.size,
        decompressHandlers: await loadDecompressHandlers(),
        maxChunkUncompressedSize: vscode.workspace
          .getConfiguration("mcapExplorer")
          .get<number>("maxChunkUncompressedSize", DEFAULT_MAX_CHUNK_UNCOMPRESSED),
      });
      return new McapDocument(uri, handle, metered, session, undefined);
    } catch (err) {
      await handle?.close().catch(() => {});
      return new McapDocument(uri, undefined, undefined, undefined, toErrorDto(err));
    }
  }

  dispose(): void {
    void this.handle?.close().catch(() => {});
  }
}
