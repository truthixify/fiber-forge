import { describe, expect, it } from "vitest";
import {
  MAX_NODES,
  MIN_CHANNEL_CAPACITY_CKB,
  TopologyError,
  parseTopology,
  validateTopology,
} from "./topology";

const VALID = `
name: my-net
nodes:
  - name: alice
  - name: bob
  - name: carol
channels:
  - { from: alice, to: bob, capacity_ckb: 500 }
  - { from: bob, to: carol, capacity_ckb: 500 }
funding:
  per_node_ckb: 10000
`;

/** Collect the issue list from a topology that is expected to be invalid. */
function issuesOf(fn: () => unknown): string[] {
  try {
    fn();
  } catch (error) {
    if (error instanceof TopologyError) {
      return error.issues;
    }
    throw error;
  }
  throw new Error("expected TopologyError, but validation passed");
}

describe("parseTopology (valid)", () => {
  it("parses a well-formed topology and maps snake_case to camelCase", () => {
    const t = parseTopology(VALID);
    expect(t.name).toBe("my-net");
    expect(t.nodes.map((n) => n.name)).toEqual(["alice", "bob", "carol"]);
    expect(t.channels).toEqual([
      { from: "alice", to: "bob", capacityCkb: 500 },
      { from: "bob", to: "carol", capacityCkb: 500 },
    ]);
    expect(t.funding.perNodeCkb).toBe(10000);
  });

  it("allows a network with no channels", () => {
    const t = parseTopology(
      "name: solo\nnodes:\n  - name: a\n  - name: b\nfunding:\n  per_node_ckb: 500\n",
    );
    expect(t.channels).toEqual([]);
  });
});

describe("validateTopology (FR-8 error classes)", () => {
  it("rejects a channel referencing an unknown node", () => {
    const issues = issuesOf(() =>
      validateTopology({
        name: "n",
        nodes: [{ name: "alice" }, { name: "bob" }],
        channels: [{ from: "alice", to: "ghost", capacity_ckb: 500 }],
        funding: { per_node_ckb: 10000 },
      }),
    );
    expect(issues.some((i) => i.includes('unknown node "ghost"'))).toBe(true);
  });

  it("rejects duplicate node names", () => {
    const issues = issuesOf(() =>
      validateTopology({
        name: "n",
        nodes: [{ name: "alice" }, { name: "alice" }],
        funding: { per_node_ckb: 500 },
      }),
    );
    expect(issues.some((i) => i.includes('duplicate node name "alice"'))).toBe(
      true,
    );
  });

  it("rejects a channel capacity below the reserve", () => {
    const issues = issuesOf(() =>
      validateTopology({
        name: "n",
        nodes: [{ name: "a" }, { name: "b" }],
        channels: [
          { from: "a", to: "b", capacity_ckb: MIN_CHANNEL_CAPACITY_CKB - 1 },
        ],
        funding: { per_node_ckb: 10000 },
      }),
    );
    expect(issues.some((i) => i.includes("below the"))).toBe(true);
  });

  it("rejects too few and too many nodes", () => {
    expect(
      issuesOf(() =>
        validateTopology({
          name: "n",
          nodes: [{ name: "a" }],
          funding: { per_node_ckb: 1 },
        }),
      ),
    ).toEqual(expect.arrayContaining([expect.stringContaining("entries")]));
    const many = Array.from({ length: MAX_NODES + 1 }, (_, i) => ({
      name: `n${i}`,
    }));
    expect(
      issuesOf(() =>
        validateTopology({
          name: "n",
          nodes: many,
          funding: { per_node_ckb: 1 },
        }),
      ),
    ).toEqual(expect.arrayContaining([expect.stringContaining("entries")]));
  });

  it("rejects a channel from a node to itself", () => {
    const issues = issuesOf(() =>
      validateTopology({
        name: "n",
        nodes: [{ name: "a" }, { name: "b" }],
        channels: [{ from: "a", to: "a", capacity_ckb: 500 }],
        funding: { per_node_ckb: 10000 },
      }),
    );
    expect(issues.some((i) => i.includes("to itself"))).toBe(true);
  });

  it("rejects funding too small to open the declared channels", () => {
    const issues = issuesOf(() =>
      validateTopology({
        name: "n",
        nodes: [{ name: "a" }, { name: "b" }],
        channels: [{ from: "a", to: "b", capacity_ckb: 500 }],
        funding: { per_node_ckb: 300 },
      }),
    );
    expect(
      issues.some((i) => i.includes("below the") && i.includes('"a"')),
    ).toBe(true);
  });

  it("rejects an invalid network name", () => {
    expect(
      issuesOf(() =>
        validateTopology({
          name: "Not Valid!",
          nodes: [{ name: "a" }, { name: "b" }],
          funding: { per_node_ckb: 1 },
        }),
      ),
    ).toEqual(
      expect.arrayContaining([expect.stringContaining("must be lowercase")]),
    );
  });

  it("reports multiple issues at once", () => {
    const issues = issuesOf(() =>
      validateTopology({ nodes: [], channels: "no", funding: {} }),
    );
    expect(issues.length).toBeGreaterThan(1);
  });

  it("rejects non-YAML input with a clear message", () => {
    const issues = issuesOf(() => parseTopology("name: [unclosed"));
    expect(issues[0]).toContain("not valid YAML");
  });
});
