import { rawDecoderFactory } from "./raw";
import type { ChannelDecoder, ChannelInfo, DecoderFactory, SchemaInfo } from "./types";

/**
 * Picks the highest-scoring factory for a channel. Phase 1 registers only the
 * raw fallback; protobuf/ros1/cdr/json factories plug in here in Phase 2
 * without touching callers.
 */
export class DecoderRegistry {
  #factories: DecoderFactory[] = [rawDecoderFactory];

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
