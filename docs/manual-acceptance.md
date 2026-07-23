# Manual acceptance checklist

Run before each release, against a real multi-GB production MCAP file.
Reference file used for v0.1: 2.7 GB CyberCap recording (h265 CompressedVideo ×3 cameras + JSON timestamp_map/IMU + audio, 450k messages, zstd-free chunks).

## Automated metrics (`npm run smoke -- <file>`)

- [ ] `open+summary time` < 2000 ms local (< 4000 ms over Remote SSH). v0.1 measured: **20 ms**.
- [ ] `bytes read` < 5 MB — expected KB-range. v0.1 measured: **408 KiB in 5 reads**.
- [ ] `rss delta` < 100 MB. v0.1 measured: **19.3 MiB**.
- [ ] Summary content matches `mcap info` output for the same file (topics, counts, duration).

## Editor (F5 extension development host)

- [ ] Double-click a `.mcap` file → summary renders completely; no white screen.
- [ ] Channels table sorts by each column; frequencies plausible.
- [ ] Schema rows expand: text schema readable, binary schema shows hex dump.
- [ ] Metadata rows expand and show key/value pairs (duplicate names → multiple tables).
- [ ] Attachment Save As writes a file whose size matches the listed dataSize.
- [ ] Open the same file in two editor tabs → no second summary read in the output channel log.
- [ ] Switch tab away and back → summary repaints instantly (no re-read).
- [ ] Light/dark theme both legible.
- [ ] `MCAP: Show Info` from explorer context menu prints the text summary.

## Degraded inputs

- [ ] Non-MCAP file renamed to `.mcap` → clear NOT_MCAP error page.
- [ ] Truncated file (e.g. `head -c 100M big.mcap > cut.mcap`) → opens unindexed with scan banner; scan completes with "partial" badge.
- [ ] Unindexed file scan: progress advances, Cancel stops it promptly.
- [ ] File currently being recorded (footer not yet written) → no crash; unindexed fallback.
- [ ] Three different files open simultaneously → each shows its own data; closing releases file handles (`lsof | grep mcap`).

## Message browsing (Phase 2)

Automated portions verified via `npm run smoke -- <file> <topic>` against the 2.7 GB reference file:

- [x] `/imu/front` (json) → decoded `sensor_msgs/Imu` tree (header / angular_velocity / linear_acceleration); `json` decoder.
- [x] `/camera/front/image_raw/compressed` (protobuf `foxglove.CompressedVideo`) → timestamp (int64 → string) and frame_id decoded; `data` is a bytes node (length + hex preview, Annex-B `00 00 00 01` start code), **raw video bytes never cross to the webview**.
- [x] Each query reads ~1 MiB (index-based random access, not a full scan of the 2.7 GB file).

Editor (F5) checks:

- [ ] Click a channel row → message list opens; scrolling loads further pages (cursor pagination).
- [ ] Selecting a row shows its decoded JSON tree; objects/arrays collapse; bytes show length + hex.
- [ ] Back button returns to the summary; reopening the tab restores the view.
- [ ] A small ROS 2 (`cdr`) file decodes via the `ros2` decoder.
- [ ] Light/dark theme legible in the list and tree.

## Image & video preview (Phase 3)

Automated portions verified via `npm run smoke -- <file> <topic>` against the 2.7 GB reference file:

- [x] `/camera/front/image_raw/compressed` (protobuf `foxglove.CompressedVideo`, H.265) →
  `getFrameWindow` at a keyframe returns `codec=h265`, `codecString` parsed from the real SPS
  (**`hev1.1.6.L150.80`**), `keyframeIndex=0`, 30 frames, ~1 MB of frame bytes — reading ~5 MB
  from the 2.7 GB file (index-based, not a scan). Keyframe detection flags the VPS/SPS/IDR frame
  and treats following `TRAIL` frames as deltas.
- [x] Frame bytes round-trip through base64 unchanged (`frameWindow.test.ts`).

Editor (F5) checks — **video decode needs a host that supports the codec in hardware**
(macOS, Windows, or Linux with an Intel VAAPI GPU). On headless/NVIDIA Linux the video path is
expected to show the "can't decode" degrade panel until Phase 3.5 (WASM) lands.

- [ ] Select a video message → **Preview frame** → the frame renders on the canvas.
- [ ] Play / pause advances frames; Step ◀ / ▶ moves one frame; the scrub bar seeks by time.
- [ ] On an unsupported host, the degrade panel appears with the codec string and the
      "download this frame's bitstream" button works.
- [ ] Only preview-window bytes are read (watch the output channel / `MeteredReadable`), never
      the whole file.
- [ ] A `CompressedImage` (JPEG/PNG) channel renders via **Preview image**; Prev/Next navigate.
- [ ] A `RawImage` (`rgb8`) channel renders with correct colors and dimensions.
- [ ] Light/dark theme legible in the preview controls and degrade panel.
