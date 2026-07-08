import { describe, expect, it } from "vitest";
import { NAME_POOL } from "../src/names";
import { line, preset, presetNames, ring, star } from "../src/presets";
import {
  MAX_NODES,
  MIN_CHANNEL_CAPACITY_CKB,
  type Topology,
} from "../src/topology";

const pool = new Set<string>(NAME_POOL);

function assertNames(topology: Topology): void {
  const names = topology.nodes.map((n) => n.name);
  expect(new Set(names).size).toBe(names.length);
  for (const name of names) {
    expect(pool.has(name) || /^node\d+$/.test(name)).toBe(true);
  }
}

function assertSound(topology: Topology): void {
  expect(topology.nodes.length).toBeGreaterThanOrEqual(2);
  const names = new Set(topology.nodes.map((n) => n.name));
  for (const channel of topology.channels) {
    expect(names.has(channel.from)).toBe(true);
    expect(names.has(channel.to)).toBe(true);
    expect(channel.capacityCkb).toBeGreaterThanOrEqual(
      MIN_CHANNEL_CAPACITY_CKB,
    );
  }
}

describe("named presets", () => {
  it("exposes duo, trio, and hub", () => {
    expect(presetNames()).toEqual(["duo", "trio", "hub"]);
  });

  it("every named preset is sound and uses fun names", () => {
    for (const name of presetNames()) {
      const topology = preset(name)!;
      assertSound(topology);
      assertNames(topology);
    }
  });
});

describe("parametric presets", () => {
  it("line:N is a chain of N nodes with N-1 channels", () => {
    const topology = line(5);
    expect(topology.name).toBe("line5");
    expect(topology.nodes).toHaveLength(5);
    expect(topology.channels).toHaveLength(4);
    const names = topology.nodes.map((n) => n.name);
    topology.channels.forEach((c, i) => {
      expect(c.from).toBe(names[i]);
      expect(c.to).toBe(names[i + 1]);
    });
    assertNames(topology);
    assertSound(topology);
  });

  it("ring:N closes the loop back to the first node", () => {
    const topology = ring(4);
    expect(topology.channels).toHaveLength(4);
    const names = topology.nodes.map((n) => n.name);
    expect(topology.channels.at(-1)).toEqual({
      from: names[3],
      to: names[0],
      capacityCkb: 1000,
    });
    assertSound(topology);
  });

  it("star:N is a hub with N-1 spokes", () => {
    const topology = star(5);
    expect(topology.nodes).toHaveLength(5);
    expect(topology.channels).toHaveLength(4);
    const hub = topology.nodes[0].name;
    expect(topology.channels.every((c) => c.from === hub)).toBe(true);
    assertNames(topology);
    assertSound(topology);
  });

  it("resolves shape:N through preset()", () => {
    expect(preset("line:6")!.nodes).toHaveLength(6);
    expect(preset("ring:3")!.name).toBe("ring3");
    expect(preset("star:4")!.name).toBe("star4");
  });

  it("rejects counts outside the supported range", () => {
    expect(() => line(1)).toThrow();
    expect(() => star(MAX_NODES + 1)).toThrow();
    expect(() => preset(`line:${MAX_NODES + 1}`)).toThrow();
  });

  it("returns undefined for unknown names and shapes", () => {
    expect(preset("nope")).toBeUndefined();
    expect(preset("blob:3")).toBeUndefined();
  });
});
