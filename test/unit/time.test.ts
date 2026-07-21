import { describe, expect, it } from "vitest";

import {
  durationBetween,
  formatBytes,
  formatDuration,
  formatTimestamp,
  frequencyHz,
  fromTimeNs,
  toTimeNs,
} from "../../src/shared/time";

describe("time", () => {
  it("round-trips bigint through TimeNs strings losslessly", () => {
    const values = [0n, 1n, 1_700_000_000_000_000_000n, 2n ** 63n - 1n];
    for (const value of values) {
      expect(fromTimeNs(toTimeNs(value))).toBe(value);
    }
  });

  it("formats timestamps as UTC ISO strings", () => {
    expect(formatTimestamp(toTimeNs(1_700_000_000_000_000_000n))).toBe("2023-11-14T22:13:20.000Z");
    expect(formatTimestamp("0")).toBe("n/a");
  });

  it("formats durations", () => {
    expect(formatDuration(0n)).toBe("0.000s");
    expect(formatDuration(90_500_000_000n)).toBe("1m 30.500s");
    expect(formatDuration(3_723_000_000_000n)).toBe("1h 2m 3.000s");
  });

  it("computes duration between timestamps, clamped at zero", () => {
    expect(durationBetween("100", "350")).toBe(250n);
    expect(durationBetween("350", "100")).toBe(0n);
  });

  it("computes frequency in Hz", () => {
    expect(frequencyHz(100n, 10_000_000_000n)).toBeCloseTo(10);
    expect(frequencyHz(0n, 10_000_000_000n)).toBeUndefined();
    expect(frequencyHz(5n, 0n)).toBeUndefined();
  });

  it("formats byte sizes", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2.0 KiB");
    expect(formatBytes(2_900_000_000)).toBe("2.7 GiB");
  });
});
