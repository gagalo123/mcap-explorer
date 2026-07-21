import protobuf from "protobufjs";
import descriptor from "protobufjs/ext/descriptor";
import { parse } from "@foxglove/rosmsg";
import { MessageWriter as Ros1Writer } from "@foxglove/rosmsg-serialization";
import { MessageWriter as Ros2Writer } from "@foxglove/rosmsg2-serialization";
import { describe, expect, it } from "vitest";

import { DecoderRegistry } from "../../src/extension/decoders/registry";
import { normalize } from "../../src/extension/decoders/normalize";
import type { ChannelInfo, SchemaInfo } from "../../src/extension/decoders/types";

const enc = (s: string) => new TextEncoder().encode(s);

describe("normalize", () => {
  it("stringifies bigint and keeps finite numbers", () => {
    expect(normalize(10n)).toBe("10");
    expect(normalize(42)).toBe(42);
    expect(normalize(NaN)).toBe("NaN");
    expect(normalize(Infinity)).toBe("Infinity");
  });

  it("turns byte buffers into bytes nodes", () => {
    const out = normalize(new Uint8Array([0xde, 0xad, 0xbe, 0xef]));
    expect(out).toEqual({ type: "bytes", length: 4, previewHex: "de ad be ef" });
  });

  it("expands numeric typed arrays into truncated scalar arrays", () => {
    expect(normalize(new Float64Array([1.5, 2.5]))).toEqual([1.5, 2.5]);
    expect(normalize(new BigInt64Array([7n]))).toEqual(["7"]);
    const big = normalize(new Float64Array(1500)) as unknown[];
    expect(big.length).toBe(1001); // 1000 values + 1 truncation note
    expect(String(big[1000])).toContain("more of 1500");
  });

  it("stringifies protobufjs Long-like objects", () => {
    expect(normalize({ low: 1, high: 0, unsigned: false, toString: () => "1" })).toBe("1");
  });

  it("recurses nested objects and arrays, and is JSON-serializable", () => {
    const out = normalize({ a: [1, { b: 2n }], c: new Uint8Array([1]) });
    expect(() => JSON.stringify(out)).not.toThrow();
    expect(out).toEqual({
      a: [1, { b: "2" }],
      c: { type: "bytes", length: 1, previewHex: "01" },
    });
  });
});

const channel = (messageEncoding: string): ChannelInfo => ({
  id: 1,
  topic: "/t",
  messageEncoding,
});

describe("json decoder", () => {
  it("decodes JSON messages", async () => {
    const reg = new DecoderRegistry();
    const decoder = await reg.resolve(channel("json"));
    const out = decoder.decode(enc(JSON.stringify({ value: 5, label: "hi" })));
    expect(out).toEqual({ value: 5, label: "hi" });
  });
});

describe("protobuf decoder", () => {
  function buildProtobufFixture() {
    const root = protobuf.Root.fromJSON({
      nested: {
        test: {
          nested: {
            Foo: {
              fields: {
                name: { type: "string", id: 1 },
                count: { type: "int64", id: 2 },
                blob: { type: "bytes", id: 3 },
              },
            },
          },
        },
      },
    });
    const Foo = root.lookupType("test.Foo");
    const fds = root.toDescriptor("proto3");
    const schemaData = descriptor.FileDescriptorSet.encode(fds).finish();
    const payload = Foo.encode(
      Foo.create({ name: "hi", count: 4294967297, blob: new Uint8Array([1, 2, 3]) }),
    ).finish();
    return { schemaData: new Uint8Array(schemaData), payload: new Uint8Array(payload) };
  }

  it("decodes protobuf, stringifies int64, and makes bytes a node", async () => {
    const { schemaData, payload } = buildProtobufFixture();
    const schema: SchemaInfo = { id: 1, name: "test.Foo", encoding: "protobuf", data: schemaData };
    const reg = new DecoderRegistry();
    const decoder = await reg.resolve(channel("protobuf"), schema);
    const out = decoder.decode(payload) as Record<string, unknown>;
    expect(out.name).toBe("hi");
    expect(out.count).toBe("4294967297"); // int64 → string, no precision loss
    expect(out.blob).toEqual({ type: "bytes", length: 3, previewHex: "01 02 03" });
    expect(() => JSON.stringify(out)).not.toThrow();
  });
});

describe("ros2 decoder", () => {
  it("decodes ROS 2 CDR messages", async () => {
    const def = "int32 x\nstring label";
    const schema: SchemaInfo = { id: 1, name: "test_msgs/Foo", encoding: "ros2msg", data: enc(def) };
    const writer = new Ros2Writer(parse(def, { ros2: true }));
    const cdr = writer.writeMessage({ x: 42, label: "hi" });
    const reg = new DecoderRegistry();
    const decoder = await reg.resolve(channel("cdr"), schema);
    const out = decoder.decode(cdr) as Record<string, unknown>;
    expect(out.x).toBe(42);
    expect(out.label).toBe("hi");
  });
});

describe("ros1 decoder", () => {
  it("decodes ROS 1 messages", async () => {
    const def = "int32 x\nstring label";
    const schema: SchemaInfo = { id: 1, name: "test_msgs/Foo", encoding: "ros1msg", data: enc(def) };
    const writer = new Ros1Writer(parse(def));
    const bytes = writer.writeMessage({ x: 7, label: "ros1" });
    const reg = new DecoderRegistry();
    const decoder = await reg.resolve(channel("ros1"), schema);
    const out = decoder.decode(bytes) as Record<string, unknown>;
    expect(out.x).toBe(7);
    expect(out.label).toBe("ros1");
  });
});

describe("registry fallback", () => {
  it("falls back to raw hex for unknown encodings", async () => {
    const reg = new DecoderRegistry();
    const decoder = await reg.resolve(channel("weird-encoding"));
    const out = decoder.decode(new Uint8Array([0x01, 0xff]));
    expect(out).toEqual({ type: "bytes", length: 2, previewHex: "01 ff" });
  });

  it("falls back to raw when a matching decoder fails to build", async () => {
    // protobuf encoding but a schema that is not a valid FileDescriptorSet.
    const schema: SchemaInfo = {
      id: 1,
      name: "nope.Nope",
      encoding: "protobuf",
      data: new Uint8Array([0xff, 0xff, 0xff]),
    };
    const reg = new DecoderRegistry();
    const decoder = await reg.resolve(channel("protobuf"), schema);
    const out = decoder.decode(new Uint8Array([0xaa]));
    expect(out).toEqual({ type: "bytes", length: 1, previewHex: "aa" });
  });
});
