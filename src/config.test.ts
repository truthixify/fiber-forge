import { describe, expect, it } from "vitest";
import { fnnConfigYaml, planLayout } from "./config";
import { type Topology } from "./topology";

const trio: Topology = {
  name: "trio",
  nodes: [{ name: "alice" }, { name: "bob" }, { name: "carol" }],
  channels: [{ from: "alice", to: "bob", capacityCkb: 500 }],
  funding: { perNodeCkb: 10000 },
};

describe("planLayout", () => {
  it("assigns deterministic names, IPs, ports and passwords", () => {
    const layout = planLayout(trio);
    expect(layout.network).toBe("forge-trio");
    expect(layout.ckbContainer).toBe("forge-trio-ckb");
    expect(layout.ckbIp).toBe("172.30.0.2");
    expect(layout.nodes).toHaveLength(3);
    expect(layout.nodes[0]).toEqual({
      index: 1,
      name: "alice",
      container: "forge-trio-node-1",
      ip: "172.30.0.11",
      rpcHostPort: 8300,
      password: "forge-trio-alice",
    });
    expect(layout.nodes[2].ip).toBe("172.30.0.13");
    expect(layout.nodes[2].rpcHostPort).toBe(8302);
  });

  it("honors custom ports and subnet", () => {
    const layout = planLayout(trio, {
      subnetPrefix: "10.9",
      rpcHostPortBase: 9000,
    });
    expect(layout.subnet).toBe("10.9.0.0/16");
    expect(layout.nodes[0].ip).toBe("10.9.0.11");
    expect(layout.nodes[1].rpcHostPort).toBe(9001);
  });
});

describe("fnnConfigYaml", () => {
  it("points the node at its private RPC IP and the ckb container", () => {
    const layout = planLayout(trio);
    const yaml = fnnConfigYaml(layout, layout.nodes[0]);
    expect(yaml).toContain("listening_addr: 172.30.0.11:8227");
    expect(yaml).toContain("rpc_url: http://forge-trio-ckb:8114");
    expect(yaml).toContain("chain: dev.toml");
    expect(yaml).toContain("- ckb");
  });
});
