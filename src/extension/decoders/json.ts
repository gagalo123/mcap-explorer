import { normalize } from "./normalize";
import type { ChannelDecoder, DecoderFactory } from "./types";

/** Decodes `messageEncoding: "json"` channels via TextDecoder + JSON.parse. */
export const jsonDecoderFactory: DecoderFactory = {
  id: "json",
  score(messageEncoding) {
    return messageEncoding === "json" ? 10 : 0;
  },
  async create(): Promise<ChannelDecoder> {
    const textDecoder = new TextDecoder("utf-8", { fatal: false });
    return {
      id: "json",
      decode(data) {
        return normalize(JSON.parse(textDecoder.decode(data)));
      },
    };
  },
};
