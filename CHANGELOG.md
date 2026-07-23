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
- Image & video preview: image/video channels get a **Preview** action on a
  selected message.
  - Video (`foxglove.CompressedVideo`, H.264/H.265/VP9/AV1) decodes with the
    browser's WebCodecs API. Seeking finds the preceding keyframe and decodes
    the GOP forward; play/pause/step and a coarse time scrub are provided.
    Keyframe detection and the WebCodecs codec string are parsed host-side from
    the Annex-B bitstream. On hosts that can't decode the codec (notably HEVC on
    headless or NVIDIA-only Linux, where Chromium has no software HEVC decoder) a
    clear message and a "download this frame" fallback are shown; a WASM software
    decoder for those hosts is planned (Phase 3.5).
  - Images: `foxglove.CompressedImage` / `sensor_msgs/CompressedImage`
    (JPEG/PNG via `createImageBitmap`) and `foxglove.RawImage` /
    `sensor_msgs/Image` (`rgb8`/`bgr8`/`mono8` → canvas, honoring row stride).
  - Selected frame bytes cross the bridge on demand as base64 — a bounded,
    user-initiated relaxation of the no-raw-bytes rule; bulk/file data still
    never crosses.
- Time-series plots: numeric channels get a **📈 Plot** action. Numeric field
  paths are auto-discovered from a sample message; selected fields are drawn over
  time in a [uPlot](https://github.com/leeoniya/uPlot) line chart. Drag across
  the plot to zoom into a range, which re-queries the server for finer detail.
  Sampling is downsampled server-side (one decode per time bucket) and the bytes
  decompressed per query are bounded by striding over chunks on very large
  ranges, so plotting a multi-GB recording stays responsive.

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
