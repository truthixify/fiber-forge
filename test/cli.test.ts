import { describe, expect, it } from "vitest";
import { resolveTopology } from "../src/cli";

describe("resolveTopology", () => {
  it("resolves a preset name to its topology", async () => {
    const topology = await resolveTopology("trio");
    expect(topology.name).toBe("trio");
    expect(topology.nodes).toHaveLength(3);
  });

  it("rejects an unknown target that is not a file", async () => {
    await expect(
      resolveTopology("does-not-exist-preset-or-file"),
    ).rejects.toThrow();
  });
});
