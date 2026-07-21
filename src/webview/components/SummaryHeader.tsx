import type { SummaryDto } from "../../shared/dto";
import { durationBetween, formatBytes, formatDuration, formatTimestamp } from "../../shared/time";

export function SummaryHeader({ summary }: { summary: SummaryDto }) {
  const facts: Array<[string, string]> = [
    ["File size", formatBytes(summary.fileSize)],
    ["Profile", summary.profile || "(none)"],
    ["Library", summary.library || "(none)"],
    [
      "Indexed",
      summary.indexed ? "yes" : summary.scanned ? "no (scanned)" : "no",
    ],
  ];
  if (summary.stats) {
    facts.push(["Messages", summary.stats.messageCount]);
    facts.push(["Chunks", String(summary.stats.chunkCount)]);
  }
  if (summary.timeRange) {
    facts.push(["Start", formatTimestamp(summary.timeRange.start)]);
    facts.push(["End", formatTimestamp(summary.timeRange.end)]);
    facts.push([
      "Duration",
      formatDuration(durationBetween(summary.timeRange.start, summary.timeRange.end)),
    ]);
  }
  const compressionEntries = Object.entries(summary.chunks.compressions);
  if (compressionEntries.length > 0) {
    facts.push([
      "Compression",
      compressionEntries.map(([name, count]) => `${name || "none"} ×${count}`).join(", "),
    ]);
  }

  return (
    <header class="summary-header">
      <h1>
        {summary.fileName}
        {summary.partial && <span class="badge badge-warn">partial</span>}
      </h1>
      <dl class="facts">
        {facts.map(([label, value]) => (
          <div class="fact" key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
    </header>
  );
}
