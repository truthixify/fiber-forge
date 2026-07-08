import { describe, expect, it } from "vitest";
import { preset, presetNames } from "../src/presets";
import { MIN_CHANNEL_CAPACITY_CKB } from "../src/topology";

describe("presets", () => {
  it("exposes duo, trio, and hub", () => {
    expect(presetNames()).toEqual(["duo", "trio", "hub"]);
  });

  it("every preset is structurally sound", () => {
    for (const name of presetNames()) {
      const topology = preset(name)!;
      expect(topology.nodes.length).toBeGreaterThanOrEqual(2);
      const nodeNames = new Set(topology.nodes.map((n) => n.name));
      for (const channel of topology.channels) {
        expect(nodeNames.has(channel.from)).toBe(true);
        expect(nodeNames.has(channel.to)).toBe(true);
        expect(channel.capacityCkb).toBeGreaterThanOrEqual(
          MIN_CHANNEL_CAPACITY_CKB,
        );
      }
    }
  });

  it("returns undefined for an unknown preset", () => {
    expect(preset("nope")).toBeUndefined();
  });
});
