import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DockerEngine } from "../src/engine";
import { Orchestrator } from "../src/orchestrator";
import { FnnRpc, HttpTransport, isChannelReady } from "../src/rpc";
import { type Topology } from "../src/topology";

// The live end-to-end test: brings a real network up on Docker and asserts a CHANNEL_READY
// channel. Gated behind FORGE_E2E=1 because it needs a Docker daemon and pulls images.
const RUN = process.env.FORGE_E2E === "1";

describe.skipIf(!RUN)("live: forge up duo -> CHANNEL_READY", () => {
  const assetsDir = join(import.meta.dirname, "..", "assets");
  const duo: Topology = {
    name: "e2e",
    nodes: [{ name: "alice" }, { name: "bob" }],
    channels: [{ from: "alice", to: "bob", capacityCkb: 1000 }],
    funding: { perNodeCkb: 100000 },
  };

  it("funds both nodes, connects them, and reaches CHANNEL_READY", async () => {
    const engine = new DockerEngine();
    const orchestrator = new Orchestrator(engine, assetsDir);
    try {
      const layout = await orchestrator.up(duo, {
        layout: { ckbHostPort: 8214, rpcHostPortBase: 8300 },
        onProgress: (message) => console.log("  " + message),
      });
      const alice = new FnnRpc(
        new HttpTransport(`http://127.0.0.1:${layout.nodes[0].rpcHostPort}`),
      );
      const channels = await alice.listChannels();
      expect(channels.length).toBeGreaterThan(0);
      expect(channels.some(isChannelReady)).toBe(true);
    } finally {
      await orchestrator.down("e2e", { purge: true });
    }
  }, 300_000);
});

describe.skipIf(!RUN)("live: a killed node surfaces as an error", () => {
  const assetsDir = join(import.meta.dirname, "..", "assets");
  const duo: Topology = {
    name: "e2e-err",
    nodes: [{ name: "alice" }, { name: "bob" }],
    channels: [{ from: "alice", to: "bob", capacityCkb: 1000 }],
    funding: { perNodeCkb: 100000 },
  };

  it("reports the node unhealthy and fails a payment to it", async () => {
    const engine = new DockerEngine();
    const orchestrator = new Orchestrator(engine, assetsDir);
    try {
      const layout = await orchestrator.up(duo, {
        layout: { ckbHostPort: 8215, rpcHostPortBase: 8320 },
        onProgress: (message) => console.log("  " + message),
      });
      await engine.remove(layout.nodes[1].container);

      const view = await orchestrator.inspect("e2e-err");
      const bob = view.nodes.find((n) => n.name === "bob");
      expect(bob?.status).not.toBe("running");

      await expect(
        orchestrator.pay("e2e-err", "alice", "bob", 100),
      ).rejects.toThrow();
    } finally {
      await orchestrator.down("e2e-err", { purge: true });
    }
  }, 300_000);
});

describe.skipIf(!RUN)("live: UDT asset channel + payment", () => {
  const assetsDir = join(import.meta.dirname, "..", "assets");
  const nodesOnly: Topology = {
    name: "e2e-udt",
    nodes: [{ name: "alice" }, { name: "bob" }],
    channels: [],
    funding: { perNodeCkb: 100000 },
  };

  it("issues UDT, opens a UDT channel, and pays a UDT invoice", async () => {
    const engine = new DockerEngine();
    const orchestrator = new Orchestrator(engine, assetsDir);
    try {
      await orchestrator.up(nodesOnly, {
        layout: { ckbHostPort: 8216, rpcHostPortBase: 8340 },
        onProgress: (message) => console.log("  " + message),
      });
      await orchestrator.issueUdt("e2e-udt", "alice", 10000);
      await orchestrator.openChannelBetween(
        "e2e-udt",
        "alice",
        "bob",
        5000,
        undefined,
        true,
      );
      const report = await orchestrator.pay(
        "e2e-udt",
        "alice",
        "bob",
        100,
        undefined,
        true,
      );
      expect(report.status).toBe("Success");
    } finally {
      await orchestrator.down("e2e-udt", { purge: true });
    }
  }, 300_000);
});
