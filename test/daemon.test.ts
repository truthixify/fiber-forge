import { type AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { type NetworkLayout } from "../src/config";
import { type Backend, createDaemon } from "../src/daemon";
import { type NetworkView } from "../src/orchestrator";

const view: NetworkView = {
  net: "duo",
  block: 47,
  nodes: [
    {
      name: "alice",
      container: "forge-duo-node-1",
      rpcHostPort: 8300,
      pubkey: "0xabcd",
      status: "running",
      onchainCkb: 9800,
      udtBalance: 500,
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
      channelId: "0xchan",
      udt: false,
    },
  ],
};

const backend: Backend = {
  inspect: async () => view,
  list: async () => [{ net: "duo", nodeCount: 2, running: true }],
  channels: async () => [],
  pay: async () => ({
    from: "",
    to: "",
    amountCkb: 0,
    paymentHash: "",
    status: "",
  }),
  openChannelBetween: async () => {},
  closeChannel: async () => {},
  fund: async () => "0x",
  createInvoice: async () => "fibd1invoice",
  issueUdt: async () => "0xudttx",
  logs: async () => "log line",
  down: async () => {},
  up: async () => ({}) as unknown as NetworkLayout,
};

async function get(port: number, path: string): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}${path}`);
}

describe("daemon", () => {
  it("serves the GUI, network list, and per-network state", async () => {
    const server = createDaemon(backend);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const port = (server.address() as AddressInfo).port;
    try {
      const html = await (await get(port, "/")).text();
      expect(html).toContain('window.__FORGE__={"central":true}');

      const networks = (await (await get(port, "/api/networks")).json()) as {
        net: string;
      }[];
      expect(networks[0].net).toBe("duo");

      const state = (await (
        await get(port, "/api/state?net=duo")
      ).json()) as NetworkView;
      expect(state.nodes[0].name).toBe("alice");
      expect(state.channels[0].localCkb).toBe(600);
    } finally {
      server.close();
    }
  });
});
