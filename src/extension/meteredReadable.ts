import type { IReadable } from "@mcap/core";

/**
 * Counts bytes and calls going through an IReadable. Used to verify the
 * no-read-amplification guarantee: opening a multi-GB file must stay in the
 * KB range because only the footer/summary section is touched.
 */
export class MeteredReadable implements IReadable {
  bytesRead = 0;
  readCalls = 0;

  constructor(private readonly inner: IReadable) {}

  async size(): Promise<bigint> {
    return await this.inner.size();
  }

  async read(offset: bigint, length: bigint): Promise<Uint8Array> {
    this.readCalls += 1;
    this.bytesRead += Number(length);
    return await this.inner.read(offset, length);
  }
}
