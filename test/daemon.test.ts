import { type AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { type NetworkLayout } from "../src/config";
import { type Backend, serveGui } from "../src/daemon";
import {
  type ChannelSettlementReport,
  type NetworkView,
  type NodeLifecycleAction,
  type NodeLifecycleReport,
} from "../src/orchestrator";

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

function lifecycleReport(action: NodeLifecycleAction): NodeLifecycleReport {
  return {
    net: "duo",
    node: "alice",
    action,
    previousStatus: action === "start" ? "stopped" : "running",
    status: action === "stop" ? "stopped" : "running",
    changed: action !== "inspect",
    rpcReady: action !== "stop",
    identityMatches: action === "stop" ? null : true,
    channels: [],
    recovery: action === "stop" ? "not-applicable" : "ready",
    nextAction: null,
  };
}

const settlementReport: ChannelSettlementReport = {
  net: "duo",
  node: "alice",
  channelId: "0xchan",
  operation: "inspect",
  closeMode: "force",
  rpcAccepted: null,
  phase: "settled",
  settled: true,
  timedOut: false,
  channelState: "Closed",
  channelFlags: ["UNCOOPERATIVE_LOCAL"],
  commitmentTransactionHash: "0xcommitment",
  closingTransaction: {
    hash: "0xclosing",
    status: "committed",
    blockHash: "0xblock",
    blockNumber: 48,
    reason: null,
  },
  finalState: { state: "Closed", flags: ["UNCOOPERATIVE_LOCAL"] },
  elapsedMs: 0,
  nextAction: null,
};

const backend: Backend = {
  inspect: async () => view,
  inspectNode: async () => lifecycleReport("inspect"),
  stopNode: async () => lifecycleReport("stop"),
  startNode: async () => lifecycleReport("start"),
  restartNode: async () => lifecycleReport("restart"),
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
  forceCloseChannel: async () => ({
    ...settlementReport,
    operation: "force-close",
    rpcAccepted: true,
  }),
  inspectChannelSettlement: async () => settlementReport,
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

async function post(
  port: number,
  path: string,
  body: Record<string, unknown>,
): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("daemon", () => {
  it("serves the GUI, network list, and per-network state", async () => {
    const server = await serveGui(backend, 0);
    const address = server.address() as AddressInfo;
    const port = address.port;
    try {
      expect(address.address).toBe("127.0.0.1");
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

  it("exposes typed node lifecycle operations and rejects unknown actions", async () => {
    const server = await serveGui(backend, 0);
    const port = (server.address() as AddressInfo).port;
    try {
      for (const action of ["inspect", "stop", "start", "restart"] as const) {
        const response = await post(port, "/api/node/lifecycle", {
          net: "duo",
          node: "alice",
          action,
        });
        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toMatchObject({
          net: "duo",
          node: "alice",
          action,
        });
      }

      const invalid = await post(port, "/api/node/lifecycle", {
        net: "duo",
        node: "alice",
        action: "delete",
      });
      expect(invalid.status).toBe(400);
      await expect(invalid.json()).resolves.toEqual({
        error: "action must be inspect, stop, start, or restart",
      });
    } finally {
      server.close();
    }
  });

  it("exposes force-close and restart-safe settlement inspection", async () => {
    const server = await serveGui(backend, 0);
    const port = (server.address() as AddressInfo).port;
    try {
      const forced = await post(port, "/api/channel/force-close", {
        net: "duo",
        node: "alice",
        channelId: "0xchan",
        confirmChannelId: "0xchan",
      });
      expect(forced.status).toBe(200);
      await expect(forced.json()).resolves.toMatchObject({
        operation: "force-close",
        rpcAccepted: true,
        phase: "settled",
      });

      const inspected = await get(
        port,
        "/api/channel/settlement?net=duo&node=alice&channelId=0xchan",
      );
      expect(inspected.status).toBe(200);
      await expect(inspected.json()).resolves.toMatchObject({
        operation: "inspect",
        phase: "settled",
      });
    } finally {
      server.close();
    }
  });
});
