import { useState } from "preact/hooks";

import type { ChannelDto } from "../../shared/dto";

type SortKey = "topic" | "schemaName" | "messageEncoding" | "messageCount" | "freqHz";

const COLUMNS: Array<{ key: SortKey; label: string }> = [
  { key: "topic", label: "Topic" },
  { key: "schemaName", label: "Schema" },
  { key: "messageEncoding", label: "Encoding" },
  { key: "messageCount", label: "Messages" },
  { key: "freqHz", label: "Frequency" },
];

export function ChannelTable({ channels }: { channels: ChannelDto[] }) {
  const [sortKey, setSortKey] = useState<SortKey>("topic");
  const [ascending, setAscending] = useState(true);

  if (channels.length === 0) {
    return (
      <section>
        <h2>Channels</h2>
        <p class="empty">No channels.</p>
      </section>
    );
  }

  const sorted = [...channels].sort((a, b) => {
    const cmp = compare(a, b, sortKey);
    return ascending ? cmp : -cmp;
  });

  const onHeaderClick = (key: SortKey) => {
    if (key === sortKey) {
      setAscending(!ascending);
    } else {
      setSortKey(key);
      setAscending(true);
    }
  };

  return (
    <section>
      <h2>
        Channels <span class="count">({channels.length})</span>
      </h2>
      <table>
        <thead>
          <tr>
            {COLUMNS.map((col) => (
              <th key={col.key} onClick={() => onHeaderClick(col.key)} class="sortable">
                {col.label}
                {sortKey === col.key ? (ascending ? " ▲" : " ▼") : ""}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sorted.map((channel) => (
            <tr key={channel.id}>
              <td class="mono">{channel.topic}</td>
              <td>
                {channel.schemaName}
                {channel.schemaEncoding && <span class="dim"> ({channel.schemaEncoding})</span>}
              </td>
              <td>{channel.messageEncoding}</td>
              <td class="num">{channel.messageCount ?? "?"}</td>
              <td class="num">
                {channel.freqHz !== undefined ? `${channel.freqHz.toFixed(1)} Hz` : ""}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function compare(a: ChannelDto, b: ChannelDto, key: SortKey): number {
  switch (key) {
    case "messageCount": {
      const av = a.messageCount !== undefined ? BigInt(a.messageCount) : -1n;
      const bv = b.messageCount !== undefined ? BigInt(b.messageCount) : -1n;
      return av < bv ? -1 : av > bv ? 1 : 0;
    }
    case "freqHz":
      return (a.freqHz ?? -1) - (b.freqHz ?? -1);
    default:
      return String(a[key]).localeCompare(String(b[key]));
  }
}
