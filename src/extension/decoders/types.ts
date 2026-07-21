import type { DecodedValue } from "../../shared/dto";

export interface ChannelInfo {
  id: number;
  topic: string;
  messageEncoding: string;
}

export interface SchemaInfo {
  id: number;
  name: string;
  encoding: string;
  data: Uint8Array;
}

export interface ChannelDecoder {
  /** Factory id that produced this decoder ("json"|"protobuf"|"ros1"|"ros2"|"raw"). */
  id: string;
  decode(data: Uint8Array): DecodedValue;
  dispose?(): void;
}

/**
 * One factory per wire format. Heavy dependencies (protobufjs, rosmsg parsers)
 * must be loaded via dynamic import inside create(), never at module load.
 */
export interface DecoderFactory {
  id: string;
  /** Support score for the channel; 0 = unsupported. The raw fallback returns 1. */
  score(messageEncoding: string, schema?: { name: string; encoding: string }): number;
  /** Called once per channel; may pre-compile the schema. */
  create(channel: ChannelInfo, schema?: SchemaInfo): Promise<ChannelDecoder>;
}
