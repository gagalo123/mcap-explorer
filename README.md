# MCAP Explorer

Explore [MCAP](https://mcap.dev) robotics log files directly in VS Code: open a `.mcap` file and instantly see its topics, schemas, statistics, metadata records and attachments — even for multi-GB files, local or over Remote SSH.

> Status: v0.1 — summary explorer. Message browsing, image/video preview and time-series plots are on the roadmap below.

## Features

- **Instant summary** — opens the index (footer + summary section) only, never scanning message data. A 2.7 GB production recording opens in ~20 ms reading ~400 KiB.
- **Channels table** — topic, schema, encoding, message count, average frequency; sortable.
- **Schemas** — lazy-loaded schema source (text schemas rendered as-is, binary schemas as a hex dump).
- **Metadata records** — browse key/value metadata by name.
- **Attachments** — list and save to disk (streamed in 4 MB windows, never held in memory).
- **Unindexed files** — graceful fallback with an explicit, cancellable full scan with progress; truncated files (e.g. still being recorded) are handled without crashing.
- **`MCAP: Show Info`** — right-click a `.mcap` file in the explorer for a plain-text summary in the output channel.
- **Message browsing** — click a channel to page through its messages in a virtualized list and inspect each one as a collapsible JSON tree, decoded from JSON, Protobuf, ROS 1 or ROS 2 (CDR). Binary fields are shown as bytes previews (length + hex), never shipped whole to the UI.

## Large files & Remote SSH

MCAP Explorer runs entirely on the machine where the file lives (`extensionKind: workspace`). Over Remote SSH only compact, JSON-safe summaries cross the wire — raw file bytes never do. Opening a huge recording on a training server is as fast as opening it locally.

Safety rails:

- Summary, schema, metadata and attachment reads are always index-based random access.
- Chunks that would inflate beyond `mcapExplorer.maxChunkUncompressedSize` (default 256 MB) are refused rather than risking OOM.
- Full scans of unindexed files above `mcapExplorer.unindexedScanConfirmSize` require explicit confirmation, report progress, and can be cancelled.

## Install

- From source: `npm ci && npm run build && npx @vscode/vsce package --no-dependencies`, then install the generated `.vsix` via *Extensions: Install from VSIX…*
- Marketplace / Open VSX: coming with the first tagged release.

## Roadmap

| Phase | Scope | Status |
| ----- | ----- | ------ |
| 1 | Summary explorer (topics/schemas/stats/metadata/attachments) | ✅ |
| 2 | Message browsing with decoders (json, protobuf, ros1/ros2, cdr) | ✅ |
| 3 | Image / video frame preview (WebCodecs) | planned |
| 4 | Time-series plots for numeric topics | planned |

## Contributing

```bash
npm ci          # install
npm run watch   # rebuild on change (launch with F5 in VS Code)
npm test        # unit tests (vitest, in-memory MCAP fixtures)
npm run smoke -- /path/to/file.mcap   # acceptance metrics against a real file
```

The core reader (`src/extension/readerService.ts`) has no dependency on the VS Code API and is fully covered by unit tests against generated fixtures — including unindexed, truncated, zstd-compressed and oversized-chunk files.

## License

[MIT](LICENSE)
