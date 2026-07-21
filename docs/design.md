# Design

## Why

Inspecting MCAP files today means either the plain-text `mcap` CLI or a heavyweight standalone GUI (Foxglove — closed source since 2024, Lichtblick, Rerun). There was no VS Code extension that opens a `.mcap` file in place (verified 2026-07: the only marketplace hit is an unmaintained CLI wrapper). For teams whose recordings live on remote servers, VS Code Remote SSH makes an extension structurally better than any standalone tool: the extension host runs where the data is.

## Architecture

```
[webview (renders locally)] ←— postMessage: JSON-safe DTOs —→ [extension host (runs where the file is)]
                                                                  └─ readerService → FileHandle, index-based reads
```

**Iron rule: raw file bytes never cross the bridge.** The extension host does all reading and (from Phase 2) decoding; the webview only ever receives compact DTOs. Over Remote SSH the bridge is the network, so DTO size is the user experience.

### Modules

- `src/shared/` — the contract between both sides; must not import `vscode`, Node or DOM APIs.
  - `protocol.ts` — request/response/progress/batch RPC envelope.
  - `dto.ts` — all payload types. Everything survives `JSON.stringify`: uint64s are decimal strings, timestamps are `TimeNs` (decimal nanosecond strings — `postMessage` throws on bigint).
  - `time.ts` — the only place bigint↔string conversion happens.
- `src/extension/readerService.ts` — the core. No `vscode` import, fully unit-testable:
  - Indexed path: `McapIndexedReader.Initialize` reads footer + summary section only (KB-range regardless of file size). Verified by `MeteredReadable` byte accounting: 2.7 GB file → 408 KiB in 5 reads, ~20 ms.
  - Unindexed fallback: minimal header-only summary, plus an explicit cancellable full scan (`McapStreamReader`, 4 MB windows, progress every 64 MB, aggregates only — payloads are dropped as they stream). Files that end mid-record (still recording, truncated) are marked `partial`.
  - Attachment extraction parses the attachment record header in place and streams the payload in 4 MB windows — never materialized whole.
  - OOM guard: any chunk that would inflate beyond `mcapExplorer.maxChunkUncompressedSize` (default 256 MB) aborts with `CHUNK_TOO_LARGE` instead of decompressing.
- `src/extension/mcapDocument.ts` — CustomDocument owning the FileHandle and session; VS Code shares one document across editors of the same file, so summaries are computed once.
- `src/extension/rpcHost.ts` — dispatches webview requests, one `AbortController` per in-flight request.
- `src/webview/` — Preact UI. State persists via `getState/setState` so tab switches repaint instantly without re-reading.

### Phase 2+ extension points (already in place)

- `decoders/` registry: `DecoderFactory.score(messageEncoding, schema)` picks a decoder per channel, raw-hex fallback always wins at score 1. Heavy parsers (protobufjs, rosmsg) load via dynamic import only when first needed. `DecodedValue` (JSON-safe tree, bytes leaves become `{type:"bytes", length, previewHex}`) is already the shared render type.
- Protocol ops `queryMessages` / `getAttachmentPreview` are declared; the host answers `UNSUPPORTED_OP` until implemented. Streamed results use the `batch` envelope with cursor continuation.
- Phase 3 video: extract `CompressedVideo` payloads host-side, decode in the webview with WebCodecs after `VideoDecoder.isConfigSupported()` probing (H.265 availability varies by VS Code build; must degrade gracefully).
- Phase 4 plots: host-side min/max bucketing (`querySeries`), uPlot in the webview.

## Build

esbuild, two bundles from one script (`esbuild.mjs`). The wasm decompress modules (zstd/lz4/bz2) locate their `.wasm` next to the bundle via `__dirname`, so they are emitted unhashed with `loader: file` + `assetNames: [name]` — inlining them (`loader: binary`) breaks emscripten's file resolution at runtime. This is covered by `npm run smoke`, which bundles with the exact same settings.

## Testing

- Unit (vitest): fixtures generated in memory with `McapWriter` + `TempBuffer` — indexed, unindexed, truncated, with attachments/metadata, zstd-compressed (doubles as the wasm smoke test), oversized-chunk.
- `npm run smoke -- <file>`: acceptance metrics (open time, bytes read, RSS delta) against a real file.
- `docs/manual-acceptance.md`: per-release manual checklist.
