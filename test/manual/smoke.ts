/**
 * Manual acceptance smoke test against a real (multi-GB) MCAP file. Bundled
 * with the same esbuild settings as the extension (cjs + wasm binary loader)
 * so it also validates wasm packaging:
 *   npm run smoke -- /path/to/file.mcap
 */
import { open } from "node:fs/promises";
import { basename } from "node:path";

import { FileHandleReadable } from "@mcap/nodejs";
import { loadDecompressHandlers } from "@mcap/support";

import { MeteredReadable } from "../../src/extension/meteredReadable";
import { McapFileSession } from "../../src/extension/readerService";
import { textSummary } from "../../src/extension/textSummary";

async function main(): Promise<void> {
  const path = process.argv[2];
  if (!path) {
    console.error("usage: smoke <file.mcap>");
    process.exit(1);
  }

  const startRss = process.memoryUsage().rss;
  const t0 = performance.now();

  const handle = await open(path, "r");
  const stat = await handle.stat();
  const metered = new MeteredReadable(new FileHandleReadable(handle));
  const session = await McapFileSession.open(metered, {
    fileName: basename(path),
    fileSize: stat.size,
    decompressHandlers: await loadDecompressHandlers(),
    maxChunkUncompressedSize: 256 * 1024 * 1024,
  });

  const elapsedMs = performance.now() - t0;
  const summary = session.summary();

  console.log(textSummary(path, summary));
  console.log("\n--- acceptance metrics ---");
  console.log(`open+summary time : ${elapsedMs.toFixed(0)} ms`);
  console.log(
    `bytes read        : ${metered.bytesRead} (${(metered.bytesRead / 1024).toFixed(1)} KiB)`,
  );
  console.log(`read calls        : ${metered.readCalls}`);
  console.log(
    `rss delta         : ${((process.memoryUsage().rss - startRss) / 1024 / 1024).toFixed(1)} MiB`,
  );
  console.log(`json serializable : ${JSON.stringify(summary).length} chars`);

  // Optional: browse the first messages of a topic to validate decoding.
  const topic = process.argv[3];
  if (topic) {
    const before = metered.bytesRead;
    const page = await session.queryMessages({
      topics: [topic],
      limitCount: 5,
      limitBytes: 1_000_000,
    });
    console.log(`\n--- first ${page.messages.length} message(s) of ${topic} ---`);
    for (const m of page.messages) {
      const summ = m.decodeError
        ? `DECODE ERROR: ${m.decodeError}`
        : JSON.stringify(m.value).slice(0, 240);
      console.log(`#${m.sequence} [${m.decoder}] ${m.sizeBytes}B  ${summ}`);
    }
    console.log(`reachedEnd=${page.reachedEnd} nextCursor=${page.nextCursor ?? "(none)"}`);
    console.log(
      `bytes read for this query: +${((metered.bytesRead - before) / 1024).toFixed(1)} KiB`,
    );
  }

  await handle.close();
}

void main();
