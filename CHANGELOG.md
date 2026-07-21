# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning follows
[SemVer](https://semver.org) with the Marketplace odd/even-minor convention
described in [RELEASING.md](RELEASING.md).

## [Unreleased]

### Added

- Message browsing: click a channel in the summary to page through its messages
  in a virtualized list and inspect each decoded message as a collapsible JSON
  tree.
- Message decoders for JSON, Protobuf (binary FileDescriptorSet schemas), ROS 1
  (`ros1msg`) and ROS 2 (`cdr` / `ros2msg`); unsupported encodings fall back to a
  raw hex view. int64/uint64 render as strings and binary fields as bytes nodes
  (length + hex preview), so raw payloads never reach the webview.

## [0.2.0]

Initial public release.

### Added

- Custom read-only editor for `.mcap` files: file facts, sortable channels
  table, lazy schema source view, metadata records, and attachments with
  streaming Save As.
- Index-only reads: multi-GB files open instantly; message payloads are never
  scanned for the summary.
- Unindexed-file fallback: explicit, cancellable full scan with progress;
  truncated files are handled gracefully.
- `MCAP: Show Info` command (explorer context menu + command palette).
- zstd / lz4 / bz2 chunk compression support.
- Extension icon.
