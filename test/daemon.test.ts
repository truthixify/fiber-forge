import { type AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { createDaemon } from "../src/daemon";
import { type NetworkView } from "../src/orchestrator";

const view: NetworkView = {
  net: "duo",
  nodes: [
    {
      name: "alice",
      container: "forge-duo-node-1",
      rpcHostPort: 8300,
      pubkey: "0xabcd",
      status: "running",
    },
  ],
  channels: [
    {
      from: "alice",
      to: "bob",
      capacityCkb: 1000,
      state: "ChannelReady",
      localCkb: 600,
      remoteCkb: 400,
    },
  ],
};

describe("daemon", () => {
  it("serves the GUI and the state API", async () => {
    const server = createDaemon({ inspect: async () => view }, "duo");
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const port = (server.address() as AddressInfo).port;
    try {
      const html = await (await fetch(`http://127.0.0.1:${port}/`)).text();
      expect(html).toContain('window.__FORGE__={"net":"duo"}');
      const state = (await (
        await fetch(`http://127.0.0.1:${port}/api/state`)
      ).json()) as NetworkView;
      expect(state.nodes[0].name).toBe("alice");
      expect(state.channels[0].state).toBe("ChannelReady");
    } finally {
      server.close();
    }
  });
});
