import { describe, expect, it } from "vitest";

import {
  QUICKNET_GENESIS_TIMESTAMP,
  QUICKNET_PERIOD_SECONDS,
  roundAt,
  roundScheduledTime,
} from "../src/index.js";

describe("Quicknet round schedule", () => {
  it("uses the expected Quicknet constants", () => {
    expect(QUICKNET_GENESIS_TIMESTAMP).toBe(1692803367n);
    expect(QUICKNET_PERIOD_SECONDS).toBe(3n);
  });

  it("returns round zero before genesis", () => {
    expect(roundAt(QUICKNET_GENESIS_TIMESTAMP - 1n)).toBe(0n);
  });

  it("starts round one at genesis", () => {
    expect(roundAt(QUICKNET_GENESIS_TIMESTAMP)).toBe(1n);
  });

  it("keeps timestamps within the same 3 second round", () => {
    expect(roundAt(QUICKNET_GENESIS_TIMESTAMP + 1n)).toBe(1n);
    expect(roundAt(QUICKNET_GENESIS_TIMESTAMP + 2n)).toBe(1n);
  });

  it("starts round two after one period", () => {
    expect(
      roundAt(
        QUICKNET_GENESIS_TIMESTAMP +
          QUICKNET_PERIOD_SECONDS,
      ),
    ).toBe(2n);
  });

  it("returns genesis for round one", () => {
    expect(roundScheduledTime(1n)).toBe(
      QUICKNET_GENESIS_TIMESTAMP,
    );
  });

  it("rejects round zero", () => {
    expect(() => roundScheduledTime(0n)).toThrow(
      RangeError,
    );
  });

  it("round trips scheduled times", () => {
    const rounds = [
      1n,
      2n,
      100n,
      20_791_007n,
      31_089_008n,
    ];

    for (const round of rounds) {
      expect(
        roundAt(roundScheduledTime(round)),
      ).toBe(round);
    }
  });

  it("spaces consecutive rounds exactly three seconds apart", () => {
    const round = 31_089_008n;

    expect(
      roundScheduledTime(round + 1n) -
        roundScheduledTime(round),
    ).toBe(QUICKNET_PERIOD_SECONDS);
  });
});