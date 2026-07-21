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
