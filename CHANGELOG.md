# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning follows
[SemVer](https://semver.org) with the Marketplace odd/even-minor convention
described in [RELEASING.md](RELEASING.md).

## [Unreleased]

## [0.6.0] — 2026-07-23

### Changed

- Preview / plot / 3D now render **inline in a bounded panel** at the top of the
  message detail pane instead of taking over the whole editor. A **⤢** button
  expands any of them to the previous full-screen view.
- The panel now **auto-detects each channel's capabilities** and shows only the
  relevant options: image/video from the schema; 3D from the schema; and
  **Plot only when the channel is actually a numeric time series** (decided from
  the first decoded message, so non-time-series channels no longer offer a plot).
  The default view is auto-selected — image for media, else the plot for a
  numeric channel — so the right visualization appears without a click; 3D stays
  a manual toggle.
- Image channels get **video-style playback**: a Play/Pause button auto-advances
  through frames (Prev/Next still step manually). Playback fetches frames a
  **window at a time** (one round-trip per ~window, next window prefetched) and
  plays from memory, instead of a round-trip per frame — much smoother, and the
  Prev/Next buttons no longer flicker while playing.

### Added

- Google Safari SDK support: `safari_sdk.protos.Image` channels now get the
  image **Preview** action (JPEG/PNG decode directly; uncompressed `rgb8`/
  `rgba8`/`mono8` render as raw), with the codec and dimensions read from the
  message's `pixel_type`/`cols`/`rows`.
- **3D View**: channels carrying named poses (`safari_sdk.protos.logging.Trackers`,
  e.g. hand/upper-body tracking) get a 3D scene view that renders each pose as a
  point with an optional orientation triad, plus playback and orbit controls. The
  renderer is schema-agnostic (see `src/shared/pose.ts`); it draws points/frames,
  not skeleton bones.

## [0.4.0] — 2026-07-23

Everything since 0.2.0: message browsing, image/video preview, and time-series
plots.

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
    clear message and a "download this frame" fallback are shown. (A WASM
    software HEVC decoder was investigated for those hosts but isn't feasible in
    a VS Code webview — it has no SharedArrayBuffer for the decoder's threads.)
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
- A bundled `examples/demo.mcap` sample and README demo screenshots, generated
  reproducibly by `npm run gen-demo`.

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
