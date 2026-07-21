# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning follows
[SemVer](https://semver.org) with the Marketplace odd/even-minor convention
described in [RELEASING.md](RELEASING.md).

## [Unreleased]

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
