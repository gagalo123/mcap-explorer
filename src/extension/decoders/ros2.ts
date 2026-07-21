import { normalize } from "./normalize";
import type { ChannelDecoder, DecoderFactory } from "./types";

/**
 * Decodes ROS 2 channels: `messageEncoding: "cdr"` with a `ros2msg`/`ros2idl`
 * schema (text). Parses the definition and deserializes each CDR payload.
 */
export const ros2DecoderFactory: DecoderFactory = {
  id: "ros2",
  score(messageEncoding, schema) {
    if (messageEncoding !== "cdr") {
      return 0;
    }
    return schema?.encoding === "ros2msg" || schema?.encoding === "ros2idl" ? 10 : 0;
  },
  async create(_channel, schema): Promise<ChannelDecoder> {
    if (!schema) {
      throw new Error("ros2 channel has no schema");
    }
    const { parse } = await import("@foxglove/rosmsg");
    const { MessageReader } = await import("@foxglove/rosmsg2-serialization");
    const definitions = parse(new TextDecoder().decode(schema.data), { ros2: true });
    const reader = new MessageReader(definitions);
    return {
      id: "ros2",
      decode(data) {
        return normalize(reader.readMessage(data));
      },
    };
  },
};
