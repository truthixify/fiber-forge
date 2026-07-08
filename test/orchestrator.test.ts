import { describe, expect, it } from "vitest";
import { planLayout } from "../src/config";
import { FakeEngine } from "../src/engine";
import {
  FORGE_LABEL,
  Orchestrator,
  ckbContainerSpec,
  nodeContainerSpec,
} from "../src/orchestrator";
import { type Topology } from "../src/topology";

const duo: Topology = {
  name: "duo",
  nodes: [{ name: "alice" }, { name: "bob" }],
  channels: [{ from: "alice", to: "bob", capacityCkb: 1000 }],
  funding: { perNodeCkb: 100000 },
};

describe("container specs", () => {
  const layout = planLayout(duo, { subnetBase: "10.5.7" });

  it("builds the ckb spec with the entrypoint, static ip, and mounted assets", () => {
    const spec = ckbContainerSpec(layout, "/abs/assets");
    expect(spec.name).toBe("forge-duo-ckb");
    expect(spec.ip).toBe("10.5.7.2");
    expect(spec.user).toBe("0");
    expect(spec.entrypoint).toEqual(["bash", "/assets/ckb-entrypoint.sh"]);
    expect(spec.volumes).toContainEqual({
      source: "/abs/assets",
      target: "/assets",
      readOnly: true,
    });
    expect(spec.labels).toEqual({ [FORGE_LABEL]: "duo" });
  });

  it("builds a node spec with the announce env, private-ip RPC, and mapped port", () => {
    const spec = nodeContainerSpec(layout, layout.nodes[0], "/state/node-1");
    expect(spec.name).toBe("forge-duo-node-1");
    expect(spec.ip).toBe("10.5.7.11");
    expect(spec.env?.FIBER_SECRET_KEY_PASSWORD).toBe("forge-duo-alice");
    expect(spec.env?.FIBER_ANNOUNCE_PRIVATE_ADDR).toBe("true");
    expect(spec.env?.FIBER_LISTENING_ADDR).toBe("/ip4/0.0.0.0/tcp/8228");
    expect(spec.ports).toEqual([{ host: 8300, container: 8227 }]);
    expect(spec.volumes).toEqual([
      { source: "/state/node-1", target: "/fiber" },
    ]);
  });
});

describe("Orchestrator.down", () => {
  it("stops and removes every labeled container and the network", async () => {
    const engine = new FakeEngine();
    await engine.run({
      name: "forge-duo-ckb",
      image: "i",
      network: "forge-duo",
      labels: { [FORGE_LABEL]: "duo" },
    });
    await engine.run({
      name: "forge-duo-node-1",
      image: "i",
      network: "forge-duo",
      labels: { [FORGE_LABEL]: "duo" },
    });
    await engine.ensureNetwork("forge-duo", "172.30.0.0/16");

    await new Orchestrator(engine, "/assets").down("duo");

    expect(await engine.status("forge-duo-ckb")).toBe("absent");
    expect(await engine.status("forge-duo-node-1")).toBe("absent");
    expect(engine.networks.has("forge-duo")).toBe(false);
  });
});
