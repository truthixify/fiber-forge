/** Built-in topology presets. `duo` and `trio` cover the common flows; `hub` is 1×4 star. */

import { type Topology } from "./topology";

const FUNDING = { perNodeCkb: 100_000 };
const CAP = 1000;

export const PRESETS: Record<string, () => Topology> = {
  duo: () => ({
    name: "duo",
    nodes: [{ name: "alice" }, { name: "bob" }],
    channels: [{ from: "alice", to: "bob", capacityCkb: CAP }],
    funding: FUNDING,
  }),
  trio: () => ({
    name: "trio",
    nodes: [{ name: "alice" }, { name: "bob" }, { name: "carol" }],
    channels: [
      { from: "alice", to: "bob", capacityCkb: CAP },
      { from: "bob", to: "carol", capacityCkb: CAP },
    ],
    funding: FUNDING,
  }),
  hub: () => ({
    name: "hub",
    nodes: [
      { name: "hub" },
      { name: "a" },
      { name: "b" },
      { name: "c" },
      { name: "d" },
    ],
    channels: [
      { from: "hub", to: "a", capacityCkb: CAP },
      { from: "hub", to: "b", capacityCkb: CAP },
      { from: "hub", to: "c", capacityCkb: CAP },
      { from: "hub", to: "d", capacityCkb: CAP },
    ],
    funding: { perNodeCkb: 500_000 },
  }),
};

/** The preset topology for `name`, or undefined if there is no such preset. */
export function preset(name: string): Topology | undefined {
  return PRESETS[name]?.();
}

/** The available preset names. */
export function presetNames(): string[] {
  return Object.keys(PRESETS);
}
