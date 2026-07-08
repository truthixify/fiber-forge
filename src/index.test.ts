import { describe, expect, it } from "vitest";
import { version } from "./index";

describe("fiber-forge", () => {
  it("reports a version", () => {
    expect(version).toBeTruthy();
  });
});
