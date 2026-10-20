import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { planLayout } from "../src/config";
import { type ContainerSpec, FakeEngine } from "../src/engine";
import { type FaultCapabilities } from "../src/engine";
import { ForgeError } from "../src/errors";
import {
  FORGE_LABEL,
  type NetworkState,
  Orchestrator,
  ckbContainerSpec,
  nodeContainerSpec,
} from "../src/orchestrator";
import { FnnRpc, type RpcTransport } from "../src/rpc";
import { type DevChain } from "../src/ckb";
import { type Topology } from "../src/topology";

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function occupyFreePort(): Promise<{
  port: number;
  close: () => Promise<void>;
}> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("test server did not allocate a TCP port");
  }
  return {
    port: address.port,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

class FailingRunEngine extends FakeEngine {
  failRuns = false;
  observedPath?: string;
  observedPathPresent?: boolean;

  override async run(spec: ContainerSpec): Promise<void> {
    if (this.failRuns) {
      if (this.observedPath) {
        this.observedPathPresent = await pathExists(this.observedPath);
      }
      throw new ForgeError(
        "CONTAINER_START_FAILED",
        `injected start failure for ${spec.name}`,
        { resource: spec.name, action: "fix the injected failure" },
      );
    }
    await super.run(spec);
  }
}

class RemoveFailureEngine extends FakeEngine {
  override async remove(name: string): Promise<void> {
    if (name === "forge-alpha-ckb") {
      throw new ForgeError(
        "DOCKER_OPERATION_FAILED",
        `injected remove failure for ${name}`,
        { resource: name, action: "test-only injected failure" },
      );
    }
    await super.remove(name);
  }
}

class StopFailureEngine extends FakeEngine {
  override async stop(name: string): Promise<void> {
    throw new ForgeError(
      "DOCKER_OPERATION_FAILED",
      `injected stop failure for ${name}`,
      { resource: name, action: "test-only injected failure" },
    );
  }
}

const duo: Topology = {
  name: "duo",
  nodes: [{ name: "alice" }, { name: "bob" }],
  channels: [{ from: "alice", to: "bob", capacityCkb: 1000 }],
  funding: { perNodeCkb: 100000 },
};

interface SimulatedNode {
  pubkey: string;
  peerPubkey: string;
  ready: boolean;
  connected: boolean;
  channelState: string | { state_name: string; state_flags?: string };
  forceRequested: boolean;
  autoSettle: boolean;
  settlementStep: number;
  commitmentHash: string | null;
  closingHash: string | null;
}

async function lifecycleFixture(engine = new FakeEngine()): Promise<{
  engine: FakeEngine;
  orchestrator: Orchestrator;
  nodes: Map<number, SimulatedNode>;
  chain: { ready: boolean; tip: number };
  makeRpc: (port: number) => FnnRpc;
  makeChain: () => DevChain;
  stateDir: string;
}> {
  const stateDir = await mkdtemp(join(tmpdir(), "forge-lifecycle-test-"));
  const state: NetworkState = {
    net: "duo",
    network: "forge-duo",
    ckbHostPort: 18114,
    ckbContainer: "forge-duo-ckb",
    ckbIp: "10.5.7.2",
    nodes: [
      {
        name: "alice",
        container: "forge-duo-node-1",
        ip: "10.5.7.11",
        rpcHostPort: 18300,
        pubkey: "0xalice",
        ckbAddress: "ckt1alice",
      },
      {
        name: "bob",
        container: "forge-duo-node-2",
        ip: "10.5.7.12",
        rpcHostPort: 18301,
        pubkey: "0xbob",
        ckbAddress: "ckt1bob",
      },
    ],
    channels: [{ from: "alice", to: "bob", capacityCkb: 1000 }],
  };
  await mkdir(join(stateDir, "duo"), { recursive: true });
  await writeFile(join(stateDir, "duo", "layout.json"), JSON.stringify(state));
  await engine.ensureNetwork("forge-duo", "10.5.7.0/24");
  for (const name of [
    "forge-duo-ckb",
    "forge-duo-node-1",
    "forge-duo-node-2",
  ]) {
    await engine.run({
      name,
      image: "test",
      network: "forge-duo",
      labels: { [FORGE_LABEL]: "duo" },
    });
  }

  const nodes = new Map<number, SimulatedNode>([
    [
      18300,
      {
        pubkey: "0xalice",
        peerPubkey: "0xbob",
        ready: true,
        connected: true,
        channelState: "ChannelReady",
        forceRequested: false,
        autoSettle: true,
        settlementStep: 0,
        commitmentHash: null,
        closingHash: null,
      },
    ],
    [
      18301,
      {
        pubkey: "0xbob",
        peerPubkey: "0xalice",
        ready: true,
        connected: true,
        channelState: "ChannelReady",
        forceRequested: false,
        autoSettle: true,
        settlementStep: 0,
        commitmentHash: null,
        closingHash: null,
      },
    ],
  ]);
  const makeRpc = (port: number): FnnRpc => {
    const transport: RpcTransport = {
      async call(method: string, params: unknown[]): Promise<unknown> {
        const simulated = nodes.get(port);
        if (!simulated || !simulated.ready) {
          throw new Error(`${method}: unavailable`);
        }
        if (method === "node_info") {
          return {
            pubkey: simulated.pubkey,
            addresses: [`/ip4/0.0.0.0/tcp/8228/p2p/peer-${port}`],
            chain_hash: "0xchain",
            node_name: null,
          };
        }
        if (method === "list_peers") {
          return {
            peers: simulated.connected
              ? [{ pubkey: simulated.peerPubkey, address: "/ip4/peer" }]
              : [],
          };
        }
        if (method === "list_channels") {
          return {
            channels: [
              {
                channel_id: `0xchannel-${port}`,
                pubkey: simulated.peerPubkey,
                state: simulated.channelState,
                local_balance: "0x174876e800",
                remote_balance: "0x174876e800",
                latest_commitment_transaction_hash: simulated.commitmentHash,
                shutdown_transaction_hash: simulated.closingHash,
              },
            ],
          };
        }
        if (method === "shutdown_channel") {
          const request = params[0] as {
            channel_id?: string;
            force?: boolean;
          };
          if (!request.force) {
            throw new Error("test fixture only supports force shutdown");
          }
          simulated.forceRequested = true;
          simulated.channelState = {
            state_name: "ShuttingDown",
            state_flags: "WAITING_COMMITMENT_CONFIRMATION",
          };
          simulated.commitmentHash = `0xcommitment-${port}`;
          return null;
        }
        throw new Error(`unexpected RPC method ${method}`);
      },
    };
    return new FnnRpc(transport);
  };
  const chain = { ready: true, tip: 40 };
  const makeChain = (): DevChain =>
    ({
      waitReady: async () => {
        if (!chain.ready) throw new Error("CKB unavailable");
      },
      tipBlock: async () => {
        if (!chain.ready) throw new Error("CKB unavailable");
        return chain.tip;
      },
      generateBlocks: async (count = 1) => {
        if (!chain.ready) throw new Error("CKB unavailable");
        chain.tip += count;
        for (const simulated of nodes.values()) {
          if (!simulated.forceRequested) continue;
          simulated.settlementStep += 1;
          simulated.closingHash = `0xclosing-${simulated.pubkey.slice(2)}`;
          if (simulated.settlementStep === 1 || !simulated.autoSettle) {
            simulated.channelState = {
              state_name: "Closed",
              state_flags: "UNCOOPERATIVE_LOCAL|WAITING_ONCHAIN_SETTLEMENT",
            };
          } else {
            simulated.channelState = {
              state_name: "Closed",
              state_flags: "UNCOOPERATIVE_LOCAL",
            };
          }
        }
      },
      transactionStatus: async (txHash: string) => {
        if (!chain.ready) throw new Error("CKB unavailable");
        return {
          status: txHash.startsWith("0xclosing-") ? "committed" : "unknown",
          blockHash: txHash.startsWith("0xclosing-") ? "0xblock" : null,
          blockNumber: txHash.startsWith("0xclosing-") ? chain.tip : null,
          reason: null,
        };
      },
    }) as DevChain;
  return {
    engine,
    orchestrator: new Orchestrator(
      engine,
      "/assets",
      stateDir,
      makeRpc,
      makeChain,
    ),
    nodes,
    chain,
    makeRpc,
    makeChain,
    stateDir,
  };
}

class UnsupportedFaultEngine extends FakeEngine {
  override async faultCapabilities(): Promise<FaultCapabilities> {
    return { abruptKill: false, networkIsolation: false };
  }
}

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
    expect(spec.user).toBe(
      typeof process.getuid === "function" &&
        typeof process.getgid === "function"
        ? `${process.getuid()}:${process.getgid()}`
        : undefined,
    );
    expect(spec.env?.FIBER_SECRET_KEY_PASSWORD).toBe("forge-duo-alice");
    expect(spec.env?.FIBER_ANNOUNCE_PRIVATE_ADDR).toBe("true");
    expect(spec.env?.FIBER_LISTENING_ADDR).toBe("/ip4/0.0.0.0/tcp/8228");
    expect(spec.ports).toEqual([{ host: 8300, container: 8227 }]);
    expect(spec.volumes).toEqual([
      { source: "/state/node-1", target: "/fiber" },
    ]);
  });
});

describe("Orchestrator node lifecycle", () => {
  it("classifies raw Fiber payment failures without exposing invoice data", async () => {
    const { orchestrator, stateDir } = await lifecycleFixture();
    try {
      await expect(
        orchestrator.pay("duo", "alice", "bob", 1),
      ).rejects.toMatchObject({
        code: "PAYMENT_FAILED",
        message: 'payment from "alice" to "bob" failed',
        resource: "duo/alice/bob",
      });
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("stops only the requested node and treats a repeated stop as a no-op", async () => {
    const { engine, orchestrator, stateDir } = await lifecycleFixture();
    try {
      const stopped = await orchestrator.stopNode("duo", "alice");
      expect(stopped).toMatchObject({
        action: "stop",
        previousStatus: "running",
        status: "stopped",
        changed: true,
        rpcReady: false,
        recovery: "not-applicable",
      });
      expect(await engine.status("forge-duo-node-1")).toBe("exited");
      expect(await engine.status("forge-duo-node-2")).toBe("running");
      expect(await engine.status("forge-duo-ckb")).toBe("running");

      const repeated = await orchestrator.stopNode("duo", "alice");
      expect(repeated).toMatchObject({
        previousStatus: "stopped",
        status: "stopped",
        changed: false,
      });
      expect(
        engine.log.filter((line) => line === "stop forge-duo-node-1"),
      ).toHaveLength(1);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("starts a stopped node, verifies identity, and reconciles its channel", async () => {
    const { engine, orchestrator, stateDir } = await lifecycleFixture();
    try {
      await orchestrator.stopNode("duo", "alice");
      const started = await orchestrator.startNode("duo", "alice", {
        timeoutMs: 20,
        reconcileTimeoutMs: 20,
      });
      expect(started).toMatchObject({
        action: "start",
        previousStatus: "stopped",
        status: "running",
        changed: true,
        rpcReady: true,
        identityMatches: true,
        recovery: "ready",
        nextAction: null,
        channels: [
          {
            channelId: "0xchannel-18300",
            peer: "bob",
            state: "ChannelReady",
            connected: true,
          },
        ],
      });

      const repeated = await orchestrator.startNode("duo", "alice", {
        timeoutMs: 20,
        reconcileTimeoutMs: 20,
      });
      expect(repeated.changed).toBe(false);
      expect(
        engine.log.filter((line) => line === "start forge-duo-node-1"),
      ).toHaveLength(1);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("restarts the same container and reports degraded peer recovery", async () => {
    const { engine, orchestrator, nodes, stateDir } = await lifecycleFixture();
    try {
      nodes.get(18300)!.connected = false;
      const restarted = await orchestrator.restartNode("duo", "alice", {
        timeoutMs: 20,
        reconcileTimeoutMs: 5,
      });
      expect(restarted).toMatchObject({
        action: "restart",
        previousStatus: "running",
        status: "running",
        changed: true,
        rpcReady: true,
        identityMatches: true,
        recovery: "action-required",
      });
      expect(restarted.channels[0]).toMatchObject({
        peer: "bob",
        connected: false,
      });
      expect(restarted.nextAction).toContain("fiber-forge node inspect");
      expect(engine.log.slice(-2)).toEqual([
        "stop forge-duo-node-1",
        "start forge-duo-node-1",
      ]);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("inspects stopped and missing recorded containers without mutating them", async () => {
    const { engine, orchestrator, stateDir } = await lifecycleFixture();
    try {
      await engine.stop("forge-duo-node-1");
      const stopped = await orchestrator.inspectNode("duo", "alice");
      expect(stopped).toMatchObject({
        action: "inspect",
        status: "stopped",
        changed: false,
        recovery: "action-required",
      });
      expect(stopped.nextAction).toContain("node start");

      await engine.remove("forge-duo-node-1");
      const missing = await orchestrator.inspectNode("duo", "alice");
      expect(missing.status).toBe("absent");
      expect(missing.nextAction).toContain("recreate network");
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("uses stable errors for unknown nodes, missing containers, RPC timeout, and identity drift", async () => {
    const { engine, orchestrator, nodes, stateDir } = await lifecycleFixture();
    try {
      await expect(orchestrator.stopNode("duo", "carol")).rejects.toMatchObject(
        {
          code: "NODE_NOT_FOUND",
          resource: "duo/carol",
        },
      );

      await engine.remove("forge-duo-node-1");
      await expect(
        orchestrator.startNode("duo", "alice"),
      ).rejects.toMatchObject({
        code: "NODE_CONTAINER_MISSING",
        resource: "duo/alice",
      });

      await engine.run({
        name: "forge-duo-node-1",
        image: "test",
        network: "forge-duo",
        labels: { [FORGE_LABEL]: "duo" },
      });
      await engine.stop("forge-duo-node-1");
      nodes.get(18300)!.ready = false;
      await expect(
        orchestrator.startNode("duo", "alice", {
          timeoutMs: 5,
          reconcileTimeoutMs: 5,
        }),
      ).rejects.toMatchObject({
        code: "NODE_RPC_UNAVAILABLE",
        resource: "duo/alice",
      });

      nodes.get(18300)!.ready = true;
      nodes.get(18300)!.pubkey = "0xunexpected";
      await engine.stop("forge-duo-node-1");
      await expect(
        orchestrator.startNode("duo", "alice", {
          timeoutMs: 20,
          reconcileTimeoutMs: 20,
        }),
      ).rejects.toMatchObject({
        code: "NODE_IDENTITY_MISMATCH",
        resource: "duo/alice",
      });
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("rejects invalid lifecycle timeouts before changing a node", async () => {
    const { engine, orchestrator, stateDir } = await lifecycleFixture();
    try {
      await expect(
        orchestrator.restartNode("duo", "alice", { timeoutMs: 0 }),
      ).rejects.toMatchObject({
        code: "INVALID_TIMEOUT",
        resource: "NodeLifecycleOptions.timeoutMs",
      });
      expect(await engine.status("forge-duo-node-1")).toBe("running");
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });
});

describe("Orchestrator force-close settlement", () => {
  it("requires the exact channel id, sends force=true, and survives reinspection", async () => {
    const { orchestrator, nodes, makeRpc, makeChain, engine, stateDir } =
      await lifecycleFixture();
    const channelId = "0xchannel-18300";
    try {
      await expect(
        orchestrator.forceCloseChannel("duo", "alice", channelId, {
          confirmChannelId: "0xwrong",
        }),
      ).rejects.toMatchObject({
        code: "FORCE_CLOSE_CONFIRMATION_REQUIRED",
      });
      expect(nodes.get(18300)?.forceRequested).toBe(false);

      const report = await orchestrator.forceCloseChannel(
        "duo",
        "alice",
        channelId,
        {
          confirmChannelId: channelId,
          timeoutMs: 100,
          pollIntervalMs: 1,
          mineBlocksPerPoll: 1,
        },
      );
      expect(nodes.get(18300)?.forceRequested).toBe(true);
      expect(report).toMatchObject({
        operation: "force-close",
        rpcAccepted: true,
        closeMode: "force",
        phase: "settled",
        settled: true,
        timedOut: false,
        channelState: "Closed",
        channelFlags: ["UNCOOPERATIVE_LOCAL"],
        commitmentTransactionHash: "0xcommitment-18300",
        closingTransaction: {
          hash: "0xclosing-alice",
          status: "committed",
        },
        finalState: {
          state: "Closed",
          flags: ["UNCOOPERATIVE_LOCAL"],
        },
      });

      const restarted = new Orchestrator(
        engine,
        "/assets",
        stateDir,
        makeRpc,
        makeChain,
      );
      await expect(
        restarted.inspectChannelSettlement("duo", "alice", channelId),
      ).resolves.toMatchObject({
        operation: "inspect",
        rpcAccepted: null,
        phase: "settled",
        settled: true,
        commitmentTransactionHash: "0xcommitment-18300",
        closingTransaction: { hash: "0xclosing-alice" },
      });
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("returns timeout evidence without losing commitment and closing hashes", async () => {
    const { orchestrator, nodes, stateDir } = await lifecycleFixture();
    const channelId = "0xchannel-18300";
    nodes.get(18300)!.autoSettle = false;
    try {
      const report = await orchestrator.forceCloseChannel(
        "duo",
        "alice",
        channelId,
        {
          confirmChannelId: channelId,
          timeoutMs: 10,
          pollIntervalMs: 1,
          mineBlocksPerPoll: 1,
        },
      );
      expect(report).toMatchObject({
        phase: "settlement-pending",
        settled: false,
        timedOut: true,
        commitmentTransactionHash: "0xcommitment-18300",
        closingTransaction: {
          hash: "0xclosing-alice",
          status: "committed",
        },
      });
      expect(report.nextAction).toContain("channel settlement");
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("recognizes a remotely forced channel after its CKB transaction commits", async () => {
    const { orchestrator, nodes, stateDir } = await lifecycleFixture();
    const channelId = "0xchannel-18300";
    const alice = nodes.get(18300)!;
    alice.channelState = {
      state_name: "Closed",
      state_flags: "UNCOOPERATIVE_REMOTE",
    };
    alice.commitmentHash = "0xcommitment-remote";
    alice.closingHash = "0xclosing-remote";
    try {
      await expect(
        orchestrator.inspectChannelSettlement("duo", "alice", channelId),
      ).resolves.toMatchObject({
        operation: "inspect",
        closeMode: "force",
        phase: "settled",
        settled: true,
        channelFlags: ["UNCOOPERATIVE_REMOTE"],
        closingTransaction: {
          hash: "0xclosing-remote",
          status: "committed",
        },
      });
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("keeps terminal Fiber state pending while CKB confirmation is unavailable", async () => {
    const { orchestrator, nodes, chain, stateDir } = await lifecycleFixture();
    const channelId = "0xchannel-18300";
    const alice = nodes.get(18300)!;
    alice.channelState = {
      state_name: "Closed",
      state_flags: "UNCOOPERATIVE_LOCAL",
    };
    alice.closingHash = "0xclosing-alice";
    chain.ready = false;
    try {
      await expect(
        orchestrator.inspectChannelSettlement("duo", "alice", channelId),
      ).resolves.toMatchObject({
        phase: "settlement-pending",
        settled: false,
        finalState: null,
        closingTransaction: {
          hash: "0xclosing-alice",
          status: "unavailable",
        },
      });
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("rejects an unknown channel without sending a shutdown request", async () => {
    const { orchestrator, nodes, stateDir } = await lifecycleFixture();
    try {
      await expect(
        orchestrator.forceCloseChannel("duo", "alice", "0xmissing", {
          confirmChannelId: "0xmissing",
        }),
      ).rejects.toMatchObject({ code: "CHANNEL_NOT_FOUND" });
      expect(nodes.get(18300)?.forceRequested).toBe(false);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });
});

describe("Orchestrator controlled faults", () => {
  it("persists an abrupt node kill, survives client restart, and resets idempotently", async () => {
    const { engine, orchestrator, makeRpc, makeChain, stateDir } =
      await lifecycleFixture();
    try {
      const applied = await orchestrator.applyFault(
        "duo",
        "node-kill",
        "alice",
      );
      expect(applied).toMatchObject({
        id: "node-kill:alice",
        requested: "active",
        changed: true,
        observed: { state: "active", containerStatus: "stopped" },
      });
      expect(await engine.status("forge-duo-node-2")).toBe("running");
      expect(await engine.status("forge-duo-ckb")).toBe("running");

      const restartedClient = new Orchestrator(
        engine,
        "/assets",
        stateDir,
        makeRpc,
        makeChain,
      );
      await expect(restartedClient.faultStatus("duo")).resolves.toMatchObject([
        {
          id: "node-kill:alice",
          observed: { state: "active" },
          survivesProcessRestart: true,
        },
      ]);
      const repeated = await restartedClient.applyFault(
        "duo",
        "node-kill",
        "alice",
      );
      expect(repeated.changed).toBe(false);
      expect(
        engine.log.filter((line) => line === "kill forge-duo-node-1"),
      ).toHaveLength(1);

      const reset = await restartedClient.resetFault(
        "duo",
        "node-kill",
        "alice",
        { timeoutMs: 20, reconcileTimeoutMs: 20 },
      );
      expect(reset).toMatchObject({
        requested: "reset",
        changed: true,
        recovery: "ready",
        observed: { state: "inactive", containerStatus: "running" },
      });
      expect(await restartedClient.faultStatus("duo")).toEqual([]);
      const repeatedReset = await restartedClient.resetFault(
        "duo",
        "node-kill",
        "alice",
      );
      expect(repeatedReset).toMatchObject({
        changed: false,
        recovery: "ready",
        observed: { state: "inactive" },
      });
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("isolates one peer on a CKB-only bridge and restores its primary attachment", async () => {
    const { engine, orchestrator, stateDir } = await lifecycleFixture();
    try {
      const applied = await orchestrator.applyFault(
        "duo",
        "peer-partition",
        "alice",
      );
      expect(applied.observed).toMatchObject({
        state: "active",
        containerStatus: "running",
      });
      expect(
        await engine.networkConnected("forge-duo", "forge-duo-node-1"),
      ).toBe(false);
      expect(
        await engine.networkConnected("ffault-duo-1", "forge-duo-node-1"),
      ).toBe(true);
      expect(
        await engine.networkConnected("ffault-duo-1", "forge-duo-ckb"),
      ).toBe(true);
      expect(await engine.getNetworkLabels("ffault-duo-1")).toEqual({
        [FORGE_LABEL]: "duo",
        "fiber-forge.fault": "true",
      });
      expect(
        await engine.networkConnected("forge-duo", "forge-duo-node-2"),
      ).toBe(true);

      await expect(
        orchestrator.applyFault("duo", "node-kill", "alice"),
      ).rejects.toMatchObject({
        code: "FAULT_CONFLICT",
        resource: "duo/alice",
      });
      expect(await engine.status("forge-duo-node-1")).toBe("running");

      const reset = await orchestrator.resetFault(
        "duo",
        "peer-partition",
        "alice",
        { timeoutMs: 20, reconcileTimeoutMs: 20 },
      );
      expect(reset).toMatchObject({
        recovery: "ready",
        observed: { state: "inactive" },
      });
      expect(
        await engine.networkConnected("forge-duo", "forge-duo-node-1"),
      ).toBe(true);
      expect(engine.networks.has("ffault-duo-1")).toBe(false);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("detaches CKB from every active segment and restores all attachments", async () => {
    const { engine, orchestrator, stateDir } = await lifecycleFixture();
    try {
      await orchestrator.applyFault("duo", "peer-partition", "alice");
      const applied = await orchestrator.applyFault("duo", "ckb-unavailable");
      expect(applied.observed.state).toBe("active");
      expect(await engine.networkConnected("forge-duo", "forge-duo-ckb")).toBe(
        false,
      );
      expect(
        await engine.networkConnected("ffault-duo-1", "forge-duo-ckb"),
      ).toBe(false);

      const reset = await orchestrator.resetFault(
        "duo",
        "ckb-unavailable",
        undefined,
        { timeoutMs: 20, reconcileTimeoutMs: 20 },
      );
      expect(reset).toMatchObject({
        recovery: "ready",
        observed: { state: "inactive" },
      });
      expect(await engine.networkConnected("forge-duo", "forge-duo-ckb")).toBe(
        true,
      );
      expect(
        await engine.networkConnected("ffault-duo-1", "forge-duo-ckb"),
      ).toBe(true);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("gates on-demand mining until reset proves block production", async () => {
    const { orchestrator, chain, stateDir } = await lifecycleFixture();
    try {
      await orchestrator.applyFault("duo", "mining-pause");
      await expect(orchestrator.mineBlocks("duo", 2)).rejects.toMatchObject({
        code: "MINING_PAUSED",
        resource: "duo/mining-pause",
      });
      await expect(
        orchestrator.issueUdt("duo", "alice", 100),
      ).rejects.toMatchObject({
        code: "MINING_PAUSED",
        resource: "duo/mining-pause",
      });
      expect(chain.tip).toBe(40);

      const reset = await orchestrator.resetFault("duo", "mining-pause");
      expect(reset.recovery).toBe("ready");
      expect(chain.tip).toBe(41);
      await expect(orchestrator.mineBlocks("duo", 2)).resolves.toEqual({
        net: "duo",
        count: 2,
        fromBlock: 41,
        toBlock: 43,
      });
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("rejects unsupported capabilities and invalid targets before mutation", async () => {
    const engine = new UnsupportedFaultEngine();
    const { orchestrator, stateDir } = await lifecycleFixture(engine);
    try {
      await expect(
        orchestrator.applyFault("duo", "node-kill", "alice"),
      ).rejects.toMatchObject({
        code: "FAULT_UNSUPPORTED",
        resource: "node-kill",
      });
      expect(await engine.status("forge-duo-node-1")).toBe("running");
      expect(await pathExists(join(stateDir, "duo", "faults.json"))).toBe(
        false,
      );

      await expect(
        orchestrator.applyFault("duo", "peer-partition", "missing"),
      ).rejects.toMatchObject({ code: "NODE_NOT_FOUND" });
      expect(engine.networks.has("ffault-duo-1")).toBe(false);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("rejects a same-named external network without changing or removing it", async () => {
    const { engine, orchestrator, stateDir } = await lifecycleFixture();
    await engine.ensureNetwork("ffault-duo-1", "10.99.1.0/24", {
      labels: { owner: "external" },
    });
    try {
      await expect(
        orchestrator.applyFault("duo", "peer-partition", "alice"),
      ).rejects.toMatchObject({
        code: "FAULT_CONFLICT",
        resource: "ffault-duo-1",
      });
      expect(await pathExists(join(stateDir, "duo", "faults.json"))).toBe(
        false,
      );

      await orchestrator.down("duo", { purge: true });
      expect(await engine.getNetworkLabels("ffault-duo-1")).toEqual({
        owner: "external",
      });
    } finally {
      await engine.removeNetwork("ffault-duo-1");
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("tears down every managed resource while faults are active", async () => {
    const { engine, orchestrator, stateDir } = await lifecycleFixture();
    await orchestrator.applyFault("duo", "peer-partition", "alice");
    await orchestrator.applyFault("duo", "node-kill", "bob");

    await orchestrator.down("duo", { purge: true });

    expect(await engine.listByLabel(FORGE_LABEL, "duo")).toEqual([]);
    expect(engine.networks.has("forge-duo")).toBe(false);
    expect(engine.networks.has("ffault-duo-1")).toBe(false);
    expect(await pathExists(join(stateDir, "duo"))).toBe(false);
    await rm(stateDir, { recursive: true, force: true });
  });
});

describe("Orchestrator.down", () => {
  it("stops and removes every labeled container and the network", async () => {
    const engine = new FakeEngine();
    await engine.run({
      name: "forge-duo-ckb",
      image: "i",
      network: "forge-duo",
      volumes: [{ source: "forge-duo-ckb-data", target: "/data" }],
      labels: { [FORGE_LABEL]: "duo" },
    });
    await engine.run({
      name: "forge-duo-node-1",
      image: "i",
      network: "forge-duo",
      labels: { [FORGE_LABEL]: "duo" },
    });
    await engine.ensureNetwork("forge-duo", "172.30.0.0/16");
    expect(await engine.volumeExists("forge-duo-ckb-data")).toBe(true);

    await new Orchestrator(engine, "/assets").down("duo");

    expect(await engine.status("forge-duo-ckb")).toBe("absent");
    expect(await engine.status("forge-duo-node-1")).toBe("absent");
    expect(engine.networks.has("forge-duo")).toBe(false);
    expect(await engine.volumeExists("forge-duo-ckb-data")).toBe(false);
  });

  it("is idempotent when containers and state are already absent", async () => {
    const engine = new FakeEngine();
    const stateDir = await mkdtemp(join(tmpdir(), "forge-down-test-"));
    await rm(stateDir, { recursive: true, force: true });
    const orchestrator = new Orchestrator(engine, "/assets", stateDir);

    await orchestrator.down("missing", { purge: true });
    await orchestrator.down("missing", { purge: true });

    expect(await engine.status("forge-missing-ckb")).toBe("absent");
  });

  it("rejects an unsafe network name before touching files or Docker", async () => {
    const root = await mkdtemp(join(tmpdir(), "forge-name-test-"));
    const stateDir = join(root, "state");
    const outsideFile = join(root, "outside", "keep.txt");
    await mkdir(join(root, "outside"), { recursive: true });
    await writeFile(outsideFile, "keep");
    const engine = new FakeEngine();

    await expect(
      new Orchestrator(engine, "/assets", stateDir).down("../outside", {
        purge: true,
      }),
    ).rejects.toMatchObject({
      code: "INVALID_NETWORK_NAME",
      resource: "../outside",
    });

    expect(await pathExists(outsideFile)).toBe(true);
    expect(engine.log).toEqual([]);
    await rm(root, { recursive: true, force: true });
  });

  it("tears one network down without touching another", async () => {
    const engine = new FakeEngine();
    for (const net of ["alpha", "beta"]) {
      await engine.ensureNetwork(`forge-${net}`, `10.1.${net.length}.0/24`);
      await engine.run({
        name: `forge-${net}-ckb`,
        image: "i",
        network: `forge-${net}`,
        volumes: [{ source: `forge-${net}-ckb-data`, target: "/data" }],
        labels: { [FORGE_LABEL]: net },
      });
    }

    await new Orchestrator(engine, "/assets").down("alpha");

    expect(await engine.status("forge-alpha-ckb")).toBe("absent");
    expect(await engine.status("forge-beta-ckb")).toBe("running");
    expect(engine.networks.has("forge-beta")).toBe(true);
    expect(await engine.volumeExists("forge-beta-ckb-data")).toBe(true);
  });

  it("continues teardown after a removal error without touching another network", async () => {
    const engine = new RemoveFailureEngine();
    const stateDir = await mkdtemp(join(tmpdir(), "forge-remove-test-"));
    const retainedState = join(stateDir, "alpha", "node", "fiber.db");
    await mkdir(join(stateDir, "alpha", "node"), { recursive: true });
    await writeFile(retainedState, "retain on failed remove");
    for (const net of ["alpha", "beta"]) {
      await engine.ensureNetwork(`forge-${net}`, `10.2.${net.length}.0/24`);
      await engine.run({
        name: `forge-${net}-ckb`,
        image: "i",
        network: `forge-${net}`,
        volumes: [{ source: `forge-${net}-ckb-data`, target: "/data" }],
        labels: { [FORGE_LABEL]: net },
      });
    }

    await expect(
      new Orchestrator(engine, "/assets", stateDir).down("alpha", {
        purge: true,
      }),
    ).rejects.toMatchObject({
      code: "DOCKER_OPERATION_FAILED",
      resource: "alpha",
    });

    expect(await engine.status("forge-alpha-ckb")).toBe("exited");
    expect(engine.networks.has("forge-alpha")).toBe(false);
    expect(await engine.volumeExists("forge-alpha-ckb-data")).toBe(false);
    expect(await pathExists(retainedState)).toBe(true);
    expect(await engine.status("forge-beta-ckb")).toBe("running");
    expect(engine.networks.has("forge-beta")).toBe(true);
    await rm(stateDir, { recursive: true, force: true });
  });

  it("succeeds when forced removal recovers from a stop failure", async () => {
    const engine = new StopFailureEngine();
    await engine.ensureNetwork("forge-alpha", "10.4.5.0/24");
    await engine.run({
      name: "forge-alpha-ckb",
      image: "i",
      network: "forge-alpha",
      labels: { [FORGE_LABEL]: "alpha" },
    });

    await new Orchestrator(engine, "/assets").down("alpha");

    expect(await engine.status("forge-alpha-ckb")).toBe("absent");
    expect(engine.networks.has("forge-alpha")).toBe(false);
  });

  it("discovers and removes an orphan network without a state directory", async () => {
    const engine = new FakeEngine();
    await engine.ensureNetwork("forge-orphan", "10.20.30.0/24");
    const stateDir = join(tmpdir(), `forge-missing-${Date.now()}`);

    const removed = await new Orchestrator(engine, "/assets", stateDir).downAll(
      { purge: true },
    );

    expect(removed).toEqual(["orphan"]);
    expect(engine.networks.has("forge-orphan")).toBe(false);
  });

  it("continues down --all after one network reports a teardown failure", async () => {
    const engine = new RemoveFailureEngine();
    for (const net of ["alpha", "beta"]) {
      await engine.ensureNetwork(`forge-${net}`, `10.3.${net.length}.0/24`);
      await engine.run({
        name: `forge-${net}-ckb`,
        image: "i",
        network: `forge-${net}`,
        labels: { [FORGE_LABEL]: net },
      });
    }

    await expect(
      new Orchestrator(engine, "/assets").downAll(),
    ).rejects.toMatchObject({
      code: "DOCKER_OPERATION_FAILED",
      resource: "alpha",
    });

    expect(await engine.status("forge-alpha-ckb")).toBe("exited");
    expect(await engine.status("forge-beta-ckb")).toBe("absent");
    expect(engine.networks.size).toBe(0);
  });
});

describe("Orchestrator.up preflight and rollback", () => {
  it("rejects an already-aborted operation before touching Docker", async () => {
    const engine = new FakeEngine();
    const controller = new AbortController();
    controller.abort("test cancellation");

    await expect(
      new Orchestrator(engine, "/assets").up(duo, {
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({
      code: "OPERATION_ABORTED",
      resource: "preflight",
    });

    expect(engine.log).toEqual([]);
  });

  it("rolls back when a progress callback aborts provisioning", async () => {
    const engine = new FakeEngine();
    const controller = new AbortController();

    await expect(
      new Orchestrator(engine, "/assets").up(duo, {
        signal: controller.signal,
        onProgress(message) {
          if (message.startsWith("network ")) controller.abort();
        },
      }),
    ).rejects.toMatchObject({
      code: "OPERATION_ABORTED",
      resource: "Docker network forge-duo",
    });

    expect(engine.containers.size).toBe(0);
    expect(engine.networks.size).toBe(0);
  });

  it("rejects invalid provisioning timeouts before touching Docker", async () => {
    const engine = new FakeEngine();

    await expect(
      new Orchestrator(engine, "/assets").up(duo, { timeoutMs: Number.NaN }),
    ).rejects.toMatchObject({
      code: "INVALID_TIMEOUT",
      resource: "UpOptions.timeoutMs",
    });

    expect(engine.log).toEqual([]);
  });

  it("reports an overall provisioning timeout with a stable code", async () => {
    const engine = new FakeEngine();

    await expect(
      new Orchestrator(engine, "/assets").up(duo, { timeoutMs: 1 }),
    ).rejects.toMatchObject({ code: "OPERATION_TIMEOUT" });

    expect(engine.containers.size).toBe(0);
    expect(engine.networks.size).toBe(0);
  });

  it("rejects an occupied requested port before creating resources", async () => {
    const occupied = await occupyFreePort();
    const engine = new FakeEngine();
    try {
      await expect(
        new Orchestrator(engine, "/assets").up(duo, {
          layout: { ckbHostPort: occupied.port },
        }),
      ).rejects.toMatchObject({
        code: "PORT_IN_USE",
        resource: `127.0.0.1:${occupied.port}`,
      });
      expect(engine.networks.size).toBe(0);
      expect(engine.containers.size).toBe(0);
    } finally {
      await occupied.close();
    }
  });

  it("rejects overlapping requested port ranges", async () => {
    const engine = new FakeEngine();
    await expect(
      new Orchestrator(engine, "/assets").up(duo, {
        layout: { ckbHostPort: 19100, rpcHostPortBase: 19100 },
      }),
    ).rejects.toMatchObject({ code: "PORT_IN_USE" });
    expect(engine.networks.size).toBe(0);
  });

  it("rejects an invalid requested port with a stable code", async () => {
    const engine = new FakeEngine();
    await expect(
      new Orchestrator(engine, "/assets").up(duo, {
        layout: { ckbHostPort: 0 },
      }),
    ).rejects.toMatchObject({
      code: "INVALID_PORT",
      resource: "CKB RPC port",
    });
    expect(engine.networks.size).toBe(0);
  });

  it("does not replace a running network with the same name", async () => {
    const engine = new FakeEngine();
    await engine.ensureNetwork("forge-duo", "10.5.7.0/24");
    await engine.run({
      name: "forge-duo-ckb",
      image: "i",
      network: "forge-duo",
      labels: { [FORGE_LABEL]: "duo" },
    });

    await expect(
      new Orchestrator(engine, "/assets").up(duo),
    ).rejects.toMatchObject({ code: "NETWORK_EXISTS", resource: "duo" });
    expect(await engine.status("forge-duo-ckb")).toBe("running");
  });

  it("cleans stale resources and rolls back a start failure", async () => {
    const engine = new FailingRunEngine();
    await engine.ensureNetwork("forge-duo", "10.5.7.0/24");
    await engine.run({
      name: "forge-duo-stale",
      image: "i",
      network: "forge-duo",
      volumes: [{ source: "forge-duo-ckb-data", target: "/data" }],
      labels: { [FORGE_LABEL]: "duo" },
    });
    await engine.stop("forge-duo-stale");
    const stateDir = await mkdtemp(join(tmpdir(), "forge-rollback-test-"));
    const staleNodeState = join(stateDir, "duo", "forge-duo-node-1", "store");
    await mkdir(staleNodeState, { recursive: true });
    await writeFile(join(staleNodeState, "fiber.db"), "stale");
    engine.observedPath = staleNodeState;
    engine.failRuns = true;
    const orchestrator = new Orchestrator(engine, "/assets", stateDir);

    await expect(orchestrator.up(duo)).rejects.toMatchObject({
      code: "CONTAINER_START_FAILED",
      resource: "forge-duo-ckb",
    });

    expect(engine.containers.size).toBe(0);
    expect(engine.networks.size).toBe(0);
    expect(await engine.volumeExists("forge-duo-ckb-data")).toBe(false);
    expect(engine.observedPathPresent).toBe(false);
    expect(await pathExists(join(stateDir, "duo"))).toBe(false);
    await rm(stateDir, { recursive: true, force: true });
  });
});
