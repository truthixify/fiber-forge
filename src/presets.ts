/**
 * Topology presets. Two kinds:
 *  - named: `duo`, `trio`, `hub` — fixed, friendly starting points.
 *  - parametric `shape:N` — any node count: `line:N` (chain), `ring:N` (closed chain),
 *    `star:N` (one hub + N-1 spokes). N is bounded by the topology's node limits.
 */

import { pickNames } from "./names";
import { MAX_NODES, MIN_NODES, type Topology } from "./topology";

const FUNDING = { perNodeCkb: 100_000 };
const CAP = 1000;

function chainChannels(
  names: string[],
): { from: string; to: string; capacityCkb: number }[] {
  const channels = [];
  for (let i = 0; i < names.length - 1; i += 1) {
    channels.push({ from: names[i], to: names[i + 1], capacityCkb: CAP });
  }
  return channels;
}

function requireInRange(shape: string, n: number): void {
  if (!Number.isInteger(n) || n < MIN_NODES || n > MAX_NODES) {
    throw new Error(
      `${shape}:${n} — a network needs ${MIN_NODES}..${MAX_NODES} nodes`,
    );
  }
}

/** A line of N nodes with fun names: a—b—…— (N-1 channels). */
export function line(n: number): Topology {
  requireInRange("line", n);
  const names = pickNames(n);
  return {
    name: `line${n}`,
    nodes: names.map((name) => ({ name })),
    channels: chainChannels(names),
    funding: FUNDING,
  };
}

/** A ring of N nodes: the line plus a closing nN—n1 channel. */
export function ring(n: number): Topology {
  requireInRange("ring", n);
  const base = line(n);
  const names = base.nodes.map((node) => node.name);
  return {
    ...base,
    name: `ring${n}`,
    channels: [
      ...base.channels,
      { from: names[n - 1], to: names[0], capacityCkb: CAP },
    ],
  };
}

/** A star of N nodes: one hub with a channel to each of the N-1 spokes. */
export function star(n: number): Topology {
  requireInRange("star", n);
  const [hub, ...spokes] = pickNames(n);
  return {
    name: `star${n}`,
    nodes: [{ name: hub }, ...spokes.map((name) => ({ name }))],
    channels: spokes.map((name) => ({
      from: hub,
      to: name,
      capacityCkb: CAP,
    })),
    funding: FUNDING,
  };
}

const NAMED: Record<string, () => Topology> = {
  duo: () => ({ ...line(2), name: "duo" }),
  trio: () => ({ ...line(3), name: "trio" }),
  hub: () => ({ ...star(5), name: "hub" }),
};

const SHAPES: Record<string, (n: number) => Topology> = { line, ring, star };

/**
 * Resolve a preset target to a topology: a named preset, or a parametric `shape:N`. Returns
 * undefined when the name is neither (so a caller can fall back to treating it as a file path).
 * Throws when a known shape is given an out-of-range count.
 */
export function preset(name: string): Topology | undefined {
  const named = NAMED[name];
  if (named) {
    return named();
  }
  const match = /^([a-z]+):(\d+)$/.exec(name);
  if (match) {
    const shape = SHAPES[match[1]];
    if (shape) {
      return shape(Number.parseInt(match[2], 10));
    }
  }
  return undefined;
}

/** The named presets. */
export function presetNames(): string[] {
  return Object.keys(NAMED);
}

/** A one-line description of every accepted preset form, for CLI help. */
export function presetHelp(): string {
  return `${presetNames().join(", ")}, or shape:N — ${Object.keys(SHAPES).join(":N, ")}:N (${MIN_NODES}..${MAX_NODES})`;
}
