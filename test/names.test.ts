import { describe, expect, it } from "vitest";
import { NAME_POOL, pickNames } from "../src/names";

describe("pickNames", () => {
  it("returns the requested count of distinct names from the pool", () => {
    const names = pickNames(6);
    expect(names).toHaveLength(6);
    expect(new Set(names).size).toBe(6);
    for (const name of names) expect(NAME_POOL).toContain(name);
  });

  it("has a large, unique pool", () => {
    expect(new Set(NAME_POOL).size).toBe(NAME_POOL.length);
    expect(NAME_POOL.length).toBeGreaterThan(30);
  });
});
