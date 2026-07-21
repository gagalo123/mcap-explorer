import type { ChannelDecoder, DecoderFactory } from "./types";

const PREVIEW_BYTES = 1024;

/** Fallback decoder: a hex preview of the payload. Supports everything, score 1. */
export const rawDecoderFactory: DecoderFactory = {
  id: "raw",
  score(): number {
    return 1;
  },
  async create(): Promise<ChannelDecoder> {
    return {
      id: "raw",
      decode(data: Uint8Array) {
        const preview = data.subarray(0, PREVIEW_BYTES);
        return {
          type: "bytes",
          length: data.byteLength,
          previewHex: [...preview].map((b) => b.toString(16).padStart(2, "0")).join(" "),
        };
      },
    };
  },
};
