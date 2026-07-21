import { normalize } from "./normalize";
import type { ChannelDecoder, DecoderFactory } from "./types";

/**
 * Decodes ROS 1 channels: `messageEncoding: "ros1"` with a `ros1msg` schema
 * (concatenated message definition text).
 */
export const ros1DecoderFactory: DecoderFactory = {
  id: "ros1",
  score(messageEncoding, schema) {
    return messageEncoding === "ros1" && schema?.encoding === "ros1msg" ? 10 : 0;
  },
  async create(_channel, schema): Promise<ChannelDecoder> {
    if (!schema) {
      throw new Error("ros1 channel has no schema");
    }
    const { parse } = await import("@foxglove/rosmsg");
    const { MessageReader } = await import("@foxglove/rosmsg-serialization");
    const definitions = parse(new TextDecoder().decode(schema.data));
    const reader = new MessageReader(definitions);
    return {
      id: "ros1",
      decode(data) {
        return normalize(reader.readMessage(data));
      },
    };
  },
};
