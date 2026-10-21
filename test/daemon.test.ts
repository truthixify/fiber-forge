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
import {
  type FiberRouteTrace,
  type RoutingGraphSnapshot,
} from "../src/routing";

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

const routeTrace: FiberRouteTrace = {
  source: "fiber.build_router",
  pathSource: "explicit",
  requestedPath: [
    { name: "alice", pubkey: "0xalice" },
    { name: "bob", pubkey: "0xbob" },
  ],
  amountBaseUnits: "100000000",
  totalFeeBaseUnits: "0",
  hops: [
    {
      targetPubkey: "0xbob",
      targetName: "bob",
      channelOutpoint: "0xoutpoint",
      amountReceivedBaseUnits: "100000000",
      incomingTlcExpiryMs: "86400000",
    },
  ],
};

const routingGraph: RoutingGraphSnapshot = {
  schemaVersion: 1,
  kind: "fiber-routing-graph",
  net: "duo",
  source: "fiber.graph_nodes+fiber.graph_channels",
  observer: { name: "alice", pubkey: "0xalice" },
  observedAt: "2026-10-20T12:00:00.000Z",
  limits: {
    requested: 100,
    maximum: 250,
    nodesReturned: 0,
    channelsReturned: 0,
    nodesTruncated: false,
    channelsTruncated: false,
  },
  nodes: [],
  channels: [],
  summary: {
    components: 0,
    isolatedNodes: 0,
    unreachableNodes: 0,
    incompleteDirections: 0,
    staleDirections: 0,
    disabledDirections: 0,
  },
  warnings: [],
};

const backend: Backend = {
  inspect: async () => view,
  inspectRoutingGraph: async () => routingGraph,
  inspectRoute: async () => ({
    schemaVersion: 1,
    kind: "fiber-route-inspection",
    net: "duo",
    observer: { name: "alice", pubkey: "0xalice" },
    asset: "ckb",
    requestedAmount: 1,
    attemptedRoute: routeTrace,
    finalSuccessfulRoute: null,
    warnings: [],
  }),
  payWithRoute: async () => ({
    schemaVersion: 1,
    kind: "fiber-routed-payment",
    net: "duo",
    from: "alice",
    to: "bob",
    asset: "ckb",
    amount: 1,
    paymentHash: "0xpayment",
    status: "Success",
    attemptedRoute: routeTrace,
    finalSuccessfulRoute: routeTrace,
    warnings: [],
  }),
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

  it("keeps live routing inspection separate from ordinary state polling", async () => {
    const server = await serveGui(backend, 0);
    const port = (server.address() as AddressInfo).port;
    try {
      const graph = await get(port, "/api/routing?net=duo&node=alice&limit=25");
      expect(graph.status).toBe(200);
      await expect(graph.json()).resolves.toMatchObject({
        kind: "fiber-routing-graph",
        observer: { name: "alice" },
      });

      const inspected = await post(port, "/api/route/inspect", {
        net: "duo",
        from: "alice",
        to: "bob",
        amount: 1,
        via: [],
      });
      await expect(inspected.json()).resolves.toMatchObject({
        kind: "fiber-route-inspection",
        attemptedRoute: { source: "fiber.build_router" },
        finalSuccessfulRoute: null,
      });

      const paid = await post(port, "/api/route/pay", {
        net: "duo",
        from: "alice",
        to: "bob",
        amount: 1,
        via: [],
      });
      await expect(paid.json()).resolves.toMatchObject({
        kind: "fiber-routed-payment",
        status: "Success",
        attemptedRoute: { source: "fiber.build_router" },
        finalSuccessfulRoute: { source: "fiber.build_router" },
      });

      const ordinary = await get(port, "/api/state?net=duo");
      expect(ordinary.status).toBe(200);
      await expect(ordinary.json()).resolves.toMatchObject({ net: "duo" });
    } finally {
      server.close();
    }
  });

  it("rejects malformed route options instead of executing a changed path", async () => {
    let paymentCalled = false;
    const server = await serveGui(
      {
        ...backend,
        payWithRoute: async (...args) => {
          paymentCalled = true;
          return backend.payWithRoute(...args);
        },
      },
      0,
    );
    const port = (server.address() as AddressInfo).port;
    try {
      const response = await post(port, "/api/route/pay", {
        net: "duo",
        from: "alice",
        to: "bob",
        amount: 1,
        via: [42],
      });
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        error: "via must be an array of non-empty managed node names",
      });
      expect(paymentCalled).toBe(false);

      const whitespace = await post(port, "/api/route/pay", {
        net: "duo",
        from: "alice",
        to: "bob",
        amount: 1,
        via: ["   "],
      });
      expect(whitespace.status).toBe(400);
      expect(paymentCalled).toBe(false);
    } finally {
      server.close();
    }
  });
});
