import { describe, expect, it } from "vitest";
import {
  fnnConfigYaml,
  hashSubnetBase,
  pickSubnetBase,
  planLayout,
} from "../src/config";
import { type Topology } from "../src/topology";

const trio: Topology = {
  name: "trio",
  nodes: [{ name: "alice" }, { name: "bob" }, { name: "carol" }],
  channels: [{ from: "alice", to: "bob", capacityCkb: 500 }],
  funding: { perNodeCkb: 10000 },
};

describe("planLayout", () => {
  it("assigns deterministic names, IPs, ports and passwords", () => {
    const layout = planLayout(trio, { subnetBase: "10.5.7" });
    expect(layout.network).toBe("forge-trio");
    expect(layout.ckbContainer).toBe("forge-trio-ckb");
    expect(layout.subnet).toBe("10.5.7.0/24");
    expect(layout.ckbIp).toBe("10.5.7.2");
    expect(layout.nodes).toHaveLength(3);
    expect(layout.nodes[0]).toEqual({
      index: 1,
      name: "alice",
      container: "forge-trio-node-1",
      ip: "10.5.7.11",
      rpcHostPort: 8300,
      password: "forge-trio-alice",
    });
    expect(layout.nodes[2].ip).toBe("10.5.7.13");
    expect(layout.nodes[2].rpcHostPort).toBe(8302);
  });

  it("derives a stable /24 subnet from the network name when none is given", () => {
    const layout = planLayout(trio);
    expect(layout.subnet).toBe(planLayout(trio).subnet);
    expect(layout.subnet).toMatch(/^10\.\d+\.\d+\.0\/24$/);
  });

  it("honors a custom subnet base and port base", () => {
    const layout = planLayout(trio, {
      subnetBase: "10.9.3",
      rpcHostPortBase: 9000,
    });
    expect(layout.subnet).toBe("10.9.3.0/24");
    expect(layout.nodes[0].ip).toBe("10.9.3.11");
    expect(layout.nodes[1].rpcHostPort).toBe(9001);
  });
});

describe("subnet selection", () => {
  it("hashSubnetBase is deterministic and inside 10.0.0.0/8", () => {
    expect(hashSubnetBase("alpha")).toBe(hashSubnetBase("alpha"));
    expect(hashSubnetBase("alpha")).toMatch(/^10\.\d+\.\d+$/);
  });

  it("pickSubnetBase returns the natural base when nothing overlaps", () => {
    expect(pickSubnetBase("alpha", ["192.168.0.0/16", "172.30.0.0/16"])).toBe(
      hashSubnetBase("alpha"),
    );
  });

  it("pickSubnetBase steps past a taken base", () => {
    const natural = hashSubnetBase("alpha");
    const chosen = pickSubnetBase("alpha", [`${natural}.0/24`]);
    expect(chosen).not.toBe(natural);
    expect(chosen).toMatch(/^10\.\d+\.\d+$/);
  });
});

describe("fnnConfigYaml", () => {
  it("points the node at its private RPC IP and the ckb container", () => {
    const layout = planLayout(trio, { subnetBase: "10.5.7" });
    const yaml = fnnConfigYaml(layout, layout.nodes[0]);
    expect(yaml).toContain("listening_addr: 10.5.7.11:8227");
    expect(yaml).toContain("rpc_url: http://forge-trio-ckb:8114");
    expect(yaml).toContain("chain: dev.toml");
    expect(yaml).toContain("- ckb");
    expect(yaml).not.toContain("udt_whitelist");
  });

  it("emits a UDT whitelist fnn accepts when given a UDT dep", () => {
    const layout = planLayout(trio, { subnetBase: "10.5.7" });
    const yaml = fnnConfigYaml(layout, layout.nodes[0], {
      codeHash: "0xe1e354",
      depTxHash: "0xcfcbbe",
      depIndex: 8,
    });
    expect(yaml).toContain("udt_whitelist:");
    expect(yaml).toContain("code_hash: 0xe1e354");
    expect(yaml).toContain("hash_type: data1");
    // fnn requires the nested `cell_dep`, a hex out-point index, and a numeric auto-accept.
    expect(yaml).toContain("cell_dep:");
    expect(yaml).toContain('index: "0x8"');
    expect(yaml).toMatch(/auto_accept_amount: \d/);
  });
});
