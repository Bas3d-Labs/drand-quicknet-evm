import { describe, expect, it } from "vitest";
import { 
  QUICKNET_GENESIS_TIMESTAMP, 
  QUICKNET_PERIOD_SECONDS 
} from "../src/index";

describe("quicknet", () => {
  it("has the expected schedule constants", () => {
    expect(QUICKNET_GENESIS_TIMESTAMP).toBe(1692803367n);
    expect(QUICKNET_PERIOD_SECONDS).toBe(3n);
  });
});
