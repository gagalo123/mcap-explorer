import type { SummaryDto } from "../shared/dto";
import { durationBetween, formatBytes, formatDuration, formatTimestamp } from "../shared/time";

/** Plain-text one-file summary used by the "MCAP: Show Info" output channel. */
export function textSummary(path: string, summary: SummaryDto): string {
  const lines: string[] = [];
  lines.push(`\n=== ${path} ===`);
  lines.push(`profile: ${summary.profile || "(none)"}   library: ${summary.library || "(none)"}`);
  lines.push(`size: ${formatBytes(summary.fileSize)}   indexed: ${summary.indexed ? "yes" : "no"}`);
  if (summary.timeRange) {
    const duration = durationBetween(summary.timeRange.start, summary.timeRange.end);
    lines.push(
      `time: ${formatTimestamp(summary.timeRange.start)} → ${formatTimestamp(summary.timeRange.end)}` +
        ` (${formatDuration(duration)})`,
    );
  }
  if (summary.stats) {
    lines.push(
      `messages: ${summary.stats.messageCount}   chunks: ${summary.stats.chunkCount}` +
        `   attachments: ${summary.stats.attachmentCount}   metadata: ${summary.stats.metadataCount}`,
    );
  } else if (!summary.indexed) {
    lines.push("messages: unknown (file has no summary section — open it to run a scan)");
  }
  if (summary.channels.length > 0) {
    lines.push("channels:");
    const topicWidth = Math.min(
      60,
      Math.max(...summary.channels.map((c) => c.topic.length), 5) + 2,
    );
    for (const channel of summary.channels) {
      const freq = channel.freqHz !== undefined ? ` @ ${channel.freqHz.toFixed(1)} Hz` : "";
      const count = channel.messageCount !== undefined ? `${channel.messageCount} msgs` : "";
      lines.push(
        `  ${channel.topic.padEnd(topicWidth)} ${channel.schemaName} [${channel.messageEncoding}] ${count}${freq}`,
      );
    }
  }
  for (const attachment of summary.attachments) {
    lines.push(
      `attachment: ${attachment.name} (${attachment.mediaType}, ${formatBytes(Number(attachment.dataSize))})`,
    );
  }
  for (const metadata of summary.metadata) {
    lines.push(`metadata: ${metadata.name}`);
  }
  return lines.join("\n");
}
