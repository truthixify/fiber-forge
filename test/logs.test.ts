import { describe, expect, it } from "vitest";
import { filterLogsByLevel } from "../src/orchestrator";

const sample = [
  "2026-07-08T21:57:45.7Z  INFO  fnn  starting node",
  "2026-07-08T21:57:46.2Z  WARN  fnn::fiber  slow peer",
  "2026-07-08T21:58:44.7Z  ERROR  fnn::fiber::payment  failed to build route",
  "  at crates/fiber-lib/src/fiber/payment.rs:1290",
].join("\n");

describe("filterLogsByLevel", () => {
  it("keeps only lines at or above the given level", () => {
    const warn = filterLogsByLevel(sample, "warn").split("\n");
    expect(warn).toHaveLength(2);
    expect(warn[0]).toContain("WARN");
    expect(warn[1]).toContain("ERROR");
  });

  it("drops continuation lines that carry no level", () => {
    const errors = filterLogsByLevel(sample, "error");
    expect(errors).toBe(
      "2026-07-08T21:58:44.7Z  ERROR  fnn::fiber::payment  failed to build route",
    );
  });

  it("is case-insensitive on the level name", () => {
    expect(filterLogsByLevel(sample, "INFO").split("\n")).toHaveLength(3);
  });
});
