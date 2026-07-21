import { ImageViewer } from "./ImageViewer";
import { VideoPlayer } from "./VideoPlayer";
import type { ChannelDto, TimeRangeDto } from "../../shared/dto";
import type { RpcClient } from "../rpcClient";

/** Media preview for a channel: routes to the video player or image viewer. */
export function PreviewView({
  channel,
  rpc,
  anchor,
  timeRange,
  onBack,
}: {
  channel: ChannelDto;
  rpc: RpcClient;
  anchor?: { logTime: string; sequence: number };
  timeRange?: TimeRangeDto;
  onBack: () => void;
}) {
  return (
    <main class="preview-view">
      <div class="browser-header">
        <button onClick={onBack}>← Back to messages</button>
        <span class="mono browser-topic">{channel.topic}</span>
        <span class="dim">
          {channel.schemaName} · {channel.preview}
        </span>
      </div>
      {channel.preview === "video" ? (
        <VideoPlayer channel={channel} rpc={rpc} anchor={anchor} timeRange={timeRange} />
      ) : (
        <ImageViewer channel={channel} rpc={rpc} anchor={anchor} />
      )}
    </main>
  );
}
