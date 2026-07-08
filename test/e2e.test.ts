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
