import { jsonDecoderFactory } from "./json";
import { protobufDecoderFactory } from "./protobuf";
import { rawDecoderFactory } from "./raw";
import { ros1DecoderFactory } from "./ros1";
import { ros2DecoderFactory } from "./ros2";
import type { ChannelDecoder, ChannelInfo, DecoderFactory, SchemaInfo } from "./types";

/**
 * Picks the highest-scoring factory for a channel. The raw hex fallback wins at
 * score 1; json/protobuf/ros1/ros2 score 10 when they match. Each factory's
 * heavy dependencies load lazily inside its create(), so importing the factory
 * objects here does not pull protobufjs/rosmsg into extension activation.
 */
export class DecoderRegistry {
  #factories: DecoderFactory[] = [
    rawDecoderFactory,
    jsonDecoderFactory,
    protobufDecoderFactory,
    ros1DecoderFactory,
    ros2DecoderFactory,
  ];

  register(factory: DecoderFactory): void {
    this.#factories.push(factory);
  }

  async resolve(channel: ChannelInfo, schema?: SchemaInfo): Promise<ChannelDecoder> {
    let best: DecoderFactory | undefined;
    let bestScore = 0;
    for (const factory of this.#factories) {
      const score = factory.score(channel.messageEncoding, schema);
      if (score > bestScore) {
        best = factory;
        bestScore = score;
      }
    }
    const chosen = best ?? rawDecoderFactory;
    try {
      return await chosen.create(channel, schema);
    } catch {
      return await rawDecoderFactory.create(channel, schema);
    }
  }
}
