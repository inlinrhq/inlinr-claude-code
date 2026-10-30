import { describe, expect, test } from "bun:test";
import { cloudSetupLine } from "./cloud";

describe("cloudSetupLine", () => {
  test("pipes inlinr.com's setup script to sh with the token", () => {
    expect(cloudSetupLine("https://inlinr.com", "in_d_abc")).toBe(
      "curl -fsSL https://inlinr.com/cloud-setup.sh | sh -s -- in_d_abc",
    );
  });
});
