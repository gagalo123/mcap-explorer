# Changelog

## 0.1.0 (unreleased)

Initial release.

- Custom read-only editor for `.mcap` files: file facts, channels table (sortable), schemas with lazy source view, metadata records, attachments with streaming Save As.
- Index-only reads: multi-GB files open instantly; message payloads are never scanned for the summary.
- Unindexed-file fallback: explicit cancellable full scan with progress; truncated files handled gracefully.
- `MCAP: Show Info` command (explorer context menu + command palette).
- zstd / lz4 / bz2 chunk compression supported.
