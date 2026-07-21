import { normalize } from "./normalize";
import type { ChannelDecoder, DecoderFactory } from "./types";

/**
 * Decodes Protobuf channels. Foxglove's convention: `messageEncoding` and
 * `schema.encoding` are both "protobuf", and `schema.data` is a binary
 * FileDescriptorSet. protobufjs + its descriptor extension are imported lazily.
 */
export const protobufDecoderFactory: DecoderFactory = {
  id: "protobuf",
  score(messageEncoding, schema) {
    return messageEncoding === "protobuf" && schema?.encoding === "protobuf" ? 10 : 0;
  },
  async create(_channel, schema): Promise<ChannelDecoder> {
    if (!schema) {
      throw new Error("protobuf channel has no schema");
    }
    /* eslint-disable @typescript-eslint/no-explicit-any */
    const protobuf: any = await import("protobufjs");
    const descriptor: any = await import("protobufjs/ext/descriptor");
    const Root = protobuf.Root ?? protobuf.default?.Root;
    const FileDescriptorSet = descriptor.FileDescriptorSet ?? descriptor.default?.FileDescriptorSet;
    /* eslint-enable @typescript-eslint/no-explicit-any */

    const fileDescriptorSet = FileDescriptorSet.decode(schema.data);
    const root = Root.fromDescriptor(fileDescriptorSet);
    root.resolveAll();
    const type = root.lookupType(schema.name);

    return {
      id: "protobuf",
      decode(data) {
        const message = type.decode(data);
        // longs → strings and enums → names keeps the tree JSON-safe and readable;
        // bytes stay as Uint8Array so normalize() turns them into bytes nodes.
        const object = type.toObject(message, {
          longs: String,
          enums: String,
          defaults: false,
          arrays: true,
          objects: true,
        });
        return normalize(object);
      },
    };
  },
};
