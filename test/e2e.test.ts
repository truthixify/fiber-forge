import { access, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type ContainerSpec, DockerEngine } from "../src/engine";
import { ForgeError } from "../src/errors";
import { DevChain } from "../src/ckb";
import {
  FORGE_LABEL,
  type NodeLifecycleReport,
  Orchestrator,
} from "../src/orchestrator";
import { preset } from "../src/presets";
import {
  type Channel,
  FnnRpc,
  HttpTransport,
  dialAddress,
  isChannelReady,
  peerIdOf,
} from "../src/rpc";
import { parseScenario, runScenario } from "../src/scenario";
import { type Topology } from "../src/topology";

// Live tests need a Docker daemon and pull the pinned CKB and Fiber images.
const RUN = process.env.FORGE_E2E === "1";
const assetsDir = join(import.meta.dirname, "..", "assets");
const MULTIHOP_NET = "e2e-multihop";
const RECOVERY_NET = "e2e-recovery";
const REPLAY_NET = "e2e-replay";
const FAILURE_PROBE = ["1", "true"].includes(
  (process.env.FORGE_E2E_FAILURE_PROBE ?? "").toLowerCase(),
);

async function makeLiveStateDir(prefix: string): Promise<string> {
  const root = process.env.FORGE_E2E_STATE_ROOT;
  if (!root) {
    return mkdtemp(join(tmpdir(), prefix));
  }
  await mkdir(root, { recursive: true });
  return mkdtemp(join(root, prefix));
}

class NodeStartFailureEngine extends DockerEngine {
  override async run(spec: ContainerSpec): Promise<void> {
    if (/-node-1$/.test(spec.name)) {
      throw new ForgeError(
        "CONTAINER_START_FAILED",
        `injected node start failure for ${spec.name}`,
        { resource: spec.name, action: "test-only injected failure" },
      );
    }
    await super.run(spec);
  }
}

function edge(from: string, to: string): string {
  return [from, to].sort().join("--");
}

function readyPeers(channels: Channel[]): string[] {
  return channels
    .filter(isChannelReady)
    .map((channel) => channel.pubkey ?? "")
    .sort();
}

async function atStage<T>(
  stage: "readiness" | "routing" | "invoice" | "payment",
  action: () => Promise<T>,
): Promise<T> {
  try {
    return await action();
  } catch (error) {
    throw stageFailure(stage, error);
  }
}

function stageFailure(
  stage: "readiness" | "routing" | "invoice" | "payment",
  error: unknown,
): Error {
  const message = error instanceof Error ? error.message : String(error);
  return new Error(`${stage} stage failed: ${message}`, { cause: error });
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function addLiveDiagnostics(
  error: unknown,
  engine: DockerEngine,
  progress: string[],
  net = MULTIHOP_NET,
): Promise<Error> {
  const message = error instanceof Error ? error.message : String(error);
  const lines = [message, "recent progress:", ...progress.slice(-12)];
  try {
    const containers = (await engine.listByLabel(FORGE_LABEL, net)).sort();
    for (const container of containers) {
      const status = await engine.status(container);
      lines.push(`${container}: ${status}`);
      const logs = (await engine.logs(container, 20)).trim();
      if (logs) {
        lines.push(logs.slice(-2_000));
      }
    }
  } catch (diagnosticError) {
    lines.push(`diagnostics unavailable: ${String(diagnosticError)}`);
  }
  return new Error(lines.join("\n"), { cause: error });
}

async function verifyCleanup(
  orchestrator: Orchestrator,
  engine: DockerEngine,
  stateDir: string,
  net = MULTIHOP_NET,
  faultNetworks: string[] = [],
): Promise<void> {
  const failures: string[] = [];
  try {
    await orchestrator.down(net, { purge: true });
  } catch (error) {
    failures.push(`teardown failed: ${String(error)}`);
  }

  try {
    const containers = await engine.listByLabel(FORGE_LABEL, net);
    if (containers.length > 0) {
      failures.push(`containers remain: ${containers.join(", ")}`);
    }
    if ((await engine.forgeNets()).includes(net)) {
      failures.push(`network remains: forge-${net}`);
    }
    for (const network of faultNetworks) {
      if (await engine.networkExists(network)) {
        failures.push(`fault network remains: ${network}`);
      }
    }
    if (await engine.volumeExists(`forge-${net}-ckb-data`)) {
      failures.push(`volume remains: forge-${net}-ckb-data`);
    }
    if (await pathExists(join(stateDir, net))) {
      failures.push(`state remains: ${join(stateDir, net)}`);
    }
  } catch (error) {
    failures.push(`cleanup verification failed: ${String(error)}`);
  }

  await rm(stateDir, { recursive: true, force: true });
  if (failures.length > 0) {
    throw new Error(failures.join("\n"));
  }
}

async function waitForNetworkRecovery(
  rpcs: FnnRpc[],
  nodes: string[],
  expectedPeers: string[][],
  timeoutMs = 60_000,
): Promise<string[]> {
  const deadline = Date.now() + timeoutMs;
  let observed = "no RPC response";
  while (Date.now() < deadline) {
    try {
      const [infos, channels, peers, graphCounts] = await Promise.all([
        Promise.all(rpcs.map((rpc) => rpc.nodeInfo())),
        Promise.all(rpcs.map((rpc) => rpc.listChannels())),
        Promise.all(rpcs.map((rpc) => rpc.listPeers())),
        Promise.all(rpcs.map((rpc) => rpc.graphChannelCount())),
      ]);
      const ready = channels.map(readyPeers);
      const connected = peers.map((list) =>
        list.map((peer) => peer.pubkey).sort(),
      );
      const complete = expectedPeers.every((expected, index) => {
        const sorted = [...expected].sort();
        return (
          ready[index].join(",") === sorted.join(",") &&
          sorted.every((peer) => connected[index].includes(peer)) &&
          graphCounts[index] >= 2
        );
      });
      observed = nodes
        .map(
          (node, index) =>
            `${node}: ready=${ready[index].length}/${expectedPeers[index].length}, ` +
            `connected=${connected[index].length}/${expectedPeers[index].length}, ` +
            `graph=${graphCounts[index]}/2`,
        )
        .join("; ");
      if (complete) {
        return infos.map((info) => info.pubkey);
      }
    } catch {
      // The restarted process has not restored its RPC and channels yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(
    `network did not recover ready channels and peers in ${timeoutMs}ms (${observed})`,
  );
}

async function ensurePeerConnected(
  rpc: FnnRpc,
  pubkey: string,
  address: string,
): Promise<void> {
  const isConnected = async () =>
    (await rpc.listPeers()).some((peer) => peer.pubkey === pubkey);
  if (await isConnected()) {
    return;
  }
  try {
    await rpc.connectPeer(address);
  } catch (error) {
    if (!(await isConnected())) {
      throw error;
    }
  }
}

async function expectProvisionRollback(
  net: string,
  engine: DockerEngine,
  expected: { code: string; resource: string | RegExp },
  failProgress?: (message: string) => void,
): Promise<void> {
  const topology: Topology = {
    name: net,
    nodes: [{ name: "alice" }, { name: "bob" }],
    channels: [{ from: "alice", to: "bob", capacityCkb: 1000 }],
    funding: { perNodeCkb: 100000 },
  };
  const stateDir = await makeLiveStateDir("rollback-");
  const orchestrator = new Orchestrator(engine, assetsDir, stateDir);
  try {
    const attempt = orchestrator.up(topology, {
      onProgress: (message) => failProgress?.(message),
    });
    const matcher =
      expected.resource instanceof RegExp
        ? {
            code: expected.code,
            resource: expect.stringMatching(expected.resource),
          }
        : expected;
    await expect(attempt).rejects.toMatchObject(matcher);
  } finally {
    await verifyCleanup(orchestrator, engine, stateDir, net);
  }
}

async function channelBalance(
  orchestrator: Orchestrator,
  node: string,
  peer: string,
): Promise<number> {
  const channel = (await orchestrator.channels(MULTIHOP_NET, node)).find(
    (row) => row.peer === peer && row.state === "ChannelReady",
  );
  if (!channel) {
    throw new Error(`ready channel ${node}<->${peer} is missing`);
  }
  return channel.localCkb;
}

async function waitForBalanceMovement(
  orchestrator: Orchestrator,
  sender: string,
  relay: string,
  receiver: string,
  senderBefore: number,
  receiverBefore: number,
): Promise<void> {
  const deadline = Date.now() + 15_000;
  let senderAfter = senderBefore;
  let receiverAfter = receiverBefore;
  while (Date.now() < deadline) {
    senderAfter = await channelBalance(orchestrator, sender, relay);
    receiverAfter = await channelBalance(orchestrator, receiver, relay);
    if (senderAfter < senderBefore && receiverAfter > receiverBefore) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(
    `channel balances did not move: sender ${senderBefore}->${senderAfter}, ` +
      `receiver ${receiverBefore}->${receiverAfter}`,
  );
}

describe.skipIf(!RUN)("live: trio multi-hop CKB payment", () => {
  it("routes between the endpoints without a direct channel", async () => {
    const selected = preset("trio");
    if (!selected) {
      throw new Error("trio preset is unavailable");
    }
    const engine = new DockerEngine();
    const stateDir = await makeLiveStateDir("multihop-");
    const orchestrator = new Orchestrator(engine, assetsDir, stateDir);
    const trio = { ...selected, name: MULTIHOP_NET };
    const [sender, relay, receiver] = trio.nodes.map((node) => node.name);
    const progress: string[] = [];
    let failure: Error | undefined;
    let cleanupFailure: Error | undefined;

    try {
      await atStage("readiness", async () => {
        expect(
          trio.channels.map((channel) => edge(channel.from, channel.to)).sort(),
        ).toEqual([edge(sender, relay), edge(relay, receiver)].sort());
      });

      const layout = await (async () => {
        try {
          return await orchestrator.up(trio, {
            onProgress: (message) => {
              progress.push(message);
              console.log("  " + message);
            },
          });
        } catch (error) {
          const stage = progress.includes("propagating routing graph")
            ? "routing"
            : "readiness";
          throw stageFailure(stage, error);
        }
      })();
      if (FAILURE_PROBE) {
        throw stageFailure(
          "payment",
          new Error(
            "intentional evidence failure probe token=FORGE_EVIDENCE_PROBE_SECRET",
          ),
        );
      }
      const rpcs = layout.nodes.map(
        (node) =>
          new FnnRpc(new HttpTransport(`http://127.0.0.1:${node.rpcHostPort}`)),
      );
      const infos = await atStage("readiness", () =>
        Promise.all(rpcs.map((rpc) => rpc.nodeInfo())),
      );
      const channels = await atStage("readiness", () =>
        Promise.all(rpcs.map((rpc) => rpc.listChannels())),
      );
      expect(readyPeers(channels[0])).toEqual([infos[1].pubkey]);
      expect(readyPeers(channels[1])).toEqual(
        [infos[0].pubkey, infos[2].pubkey].sort(),
      );
      expect(readyPeers(channels[2])).toEqual([infos[1].pubkey]);
      expect(readyPeers(channels[0])).not.toContain(infos[2].pubkey);

      await atStage("routing", async () => {
        const graphCounts = await Promise.all(
          rpcs.map((rpc) => rpc.graphChannelCount()),
        );
        expect(graphCounts).toEqual([2, 2, 2]);

        const graph = await orchestrator.inspectRoutingGraph(MULTIHOP_NET, {
          observer: sender,
          limit: 10,
        });
        expect(graph.source).toBe("fiber.graph_nodes+fiber.graph_channels");
        expect(graph.observer).toEqual({
          name: sender,
          pubkey: infos[0].pubkey,
        });
        expect(graph.nodes).toHaveLength(3);
        expect(graph.channels).toHaveLength(2);
        expect(
          graph.channels.every((channel) =>
            channel.directions.some(
              (direction) =>
                direction.announcement === "present" &&
                direction.enabled === true,
            ),
          ),
        ).toBe(true);
      });

      const senderBefore = await channelBalance(orchestrator, sender, relay);
      const receiverBefore = await channelBalance(
        orchestrator,
        receiver,
        relay,
      );

      const invoice = await atStage("invoice", () =>
        orchestrator.createInvoice(
          MULTIHOP_NET,
          receiver,
          100,
          "live trio multi-hop proof",
        ),
      );
      await atStage("payment", async () => {
        const report = await orchestrator.payInvoice(
          MULTIHOP_NET,
          sender,
          invoice,
        );
        expect(report.status).toBe("Success");
        expect(report.paymentHash).toMatch(/^0x[0-9a-f]+$/i);
        await waitForBalanceMovement(
          orchestrator,
          sender,
          relay,
          receiver,
          senderBefore,
          receiverBefore,
        );
      });

      const routedSenderBefore = await channelBalance(
        orchestrator,
        sender,
        relay,
      );
      const routedReceiverBefore = await channelBalance(
        orchestrator,
        receiver,
        relay,
      );
      const inspected = await atStage("routing", () =>
        orchestrator.inspectRoute(MULTIHOP_NET, sender, receiver, 41, {
          via: [relay],
        }),
      );
      expect(inspected.attemptedRoute.source).toBe("fiber.build_router");
      expect(inspected.attemptedRoute.pathSource).toBe("explicit");
      expect(
        inspected.attemptedRoute.requestedPath.map((node) => node.name),
      ).toEqual([sender, relay, receiver]);
      expect(inspected.attemptedRoute.hops).toHaveLength(2);
      expect(inspected.finalSuccessfulRoute).toBeNull();

      await atStage("payment", async () => {
        const routed = await orchestrator.payWithRoute(
          MULTIHOP_NET,
          sender,
          receiver,
          41,
          { via: [relay] },
          "live explicit route proof",
        );
        expect(routed.status).toBe("Success");
        expect(routed.paymentHash).toMatch(/^0x[0-9a-f]+$/i);
        expect(routed.attemptedRoute.source).toBe("fiber.build_router");
        expect(
          routed.attemptedRoute.hops.map((hop) => ({
            target: hop.targetPubkey,
            channel: hop.channelOutpoint,
          })),
        ).toEqual(
          inspected.attemptedRoute.hops.map((hop) => ({
            target: hop.targetPubkey,
            channel: hop.channelOutpoint,
          })),
        );
        expect(routed.finalSuccessfulRoute).toEqual(routed.attemptedRoute);
        await waitForBalanceMovement(
          orchestrator,
          sender,
          relay,
          receiver,
          routedSenderBefore,
          routedReceiverBefore,
        );
      });
    } catch (error) {
      failure = await addLiveDiagnostics(error, engine, progress);
    } finally {
      try {
        await verifyCleanup(orchestrator, engine, stateDir);
      } catch (error) {
        cleanupFailure =
          error instanceof Error ? error : new Error(String(error));
      }
    }

    if (failure && cleanupFailure) {
      throw new AggregateError(
        [failure, cleanupFailure],
        "live multi-hop test and cleanup both failed",
      );
    }
    if (failure) {
      throw failure;
    }
    if (cleanupFailure) {
      throw cleanupFailure;
    }
  }, 360_000);
});

describe.skipIf(!RUN)("live: relay node recovery", () => {
  it("fails while stopped, restores the restarted relay, then pays", async () => {
    const selected = preset("trio");
    if (!selected) {
      throw new Error("trio preset is unavailable");
    }
    const engine = new DockerEngine();
    const stateDir = await makeLiveStateDir("recovery-");
    const orchestrator = new Orchestrator(engine, assetsDir, stateDir);
    const trio = { ...selected, name: RECOVERY_NET };
    const [sender, relay, receiver] = trio.nodes.map((node) => node.name);
    const progress: string[] = [];
    const faultNetworksToCheck: string[] = [];
    let failure: Error | undefined;
    let cleanupFailure: Error | undefined;

    try {
      const layout = await orchestrator.up(trio, {
        onProgress: (message) => {
          progress.push(message);
          console.log("  " + message);
        },
      });
      const rpcs = layout.nodes.map(
        (node) =>
          new FnnRpc(new HttpTransport(`http://127.0.0.1:${node.rpcHostPort}`)),
      );
      const infos = await Promise.all(rpcs.map((rpc) => rpc.nodeInfo()));
      const channelIdsBefore = (
        await Promise.all(rpcs.map((rpc) => rpc.listChannels()))
      ).map((channels) => channels.map((channel) => channel.channel_id).sort());
      const interruptedInvoice = await orchestrator.createInvoice(
        RECOVERY_NET,
        receiver,
        100,
        "relay unavailable proof",
      );

      const stoppedReport = await orchestrator.stopNode(RECOVERY_NET, relay);
      expect(stoppedReport).toMatchObject({
        action: "stop",
        status: "stopped",
        changed: true,
      });
      expect(await engine.status(layout.nodes[0].container)).toBe("running");
      expect(await engine.status(layout.nodes[2].container)).toBe("running");
      expect(await engine.status(layout.ckbContainer)).toBe("running");

      const repeatedStop = await orchestrator.stopNode(RECOVERY_NET, relay);
      expect(repeatedStop.changed).toBe(false);

      const stopped = await orchestrator.inspectNode(RECOVERY_NET, relay);
      expect(stopped.status).toBe("stopped");
      await expect(
        orchestrator.payInvoice(RECOVERY_NET, sender, interruptedInvoice),
      ).rejects.toMatchObject({ code: "PAYMENT_FAILED" });

      const expectedPeers = [
        [infos[1].pubkey],
        [infos[0].pubkey, infos[2].pubkey],
        [infos[1].pubkey],
      ];
      const reconcile = async (
        report: Pick<NodeLifecycleReport, "recovery" | "nextAction">,
      ): Promise<{ mode: string; pubkeys: string[] }> => {
        let mode =
          report.recovery === "ready" ? "automatic" : "manual-peer-reconnect";
        if (report.recovery !== "ready") {
          progress.push(
            `lifecycle report requires action: ${report.nextAction}`,
          );
        }
        try {
          const pubkeys = await waitForNetworkRecovery(
            rpcs,
            [sender, relay, receiver],
            expectedPeers,
            report.recovery === "ready" ? 10_000 : 1_000,
          );
          return { mode, pubkeys };
        } catch (automaticError) {
          mode = "manual-peer-reconnect";
          progress.push(
            `automatic recovery incomplete: ${(automaticError as Error).message}`,
          );
          for (const [fromIndex, toIndex] of [
            [0, 1],
            [1, 2],
          ] as const) {
            const peerId = peerIdOf(infos[toIndex]);
            if (!peerId) {
              throw new Error(
                `node ${layout.nodes[toIndex].name} has no peer id after recovery`,
              );
            }
            await ensurePeerConnected(
              rpcs[fromIndex],
              infos[toIndex].pubkey,
              dialAddress(layout.nodes[toIndex].ip, peerId),
            );
          }
          return {
            mode,
            pubkeys: await waitForNetworkRecovery(
              rpcs,
              [sender, relay, receiver],
              expectedPeers,
            ),
          };
        }
      };

      const startedReport = await orchestrator.startNode(RECOVERY_NET, relay);
      expect(startedReport).toMatchObject({
        action: "start",
        previousStatus: "stopped",
        status: "running",
        rpcReady: true,
        identityMatches: true,
      });
      const startedRecovery = await reconcile(startedReport);
      progress.push(`start recovery classification: ${startedRecovery.mode}`);
      expect(startedRecovery.pubkeys).toEqual(infos.map((info) => info.pubkey));

      const recoveredInvoice = await orchestrator.createInvoice(
        RECOVERY_NET,
        receiver,
        100,
        `${startedRecovery.mode} relay recovery proof`,
      );
      const recovered = await orchestrator.payInvoice(
        RECOVERY_NET,
        sender,
        recoveredInvoice,
      );
      expect(recovered.status).toBe("Success");

      const restartedReport = await orchestrator.restartNode(
        RECOVERY_NET,
        relay,
      );
      expect(restartedReport).toMatchObject({
        action: "restart",
        previousStatus: "running",
        status: "running",
        changed: true,
        rpcReady: true,
        identityMatches: true,
      });
      const restartedRecovery = await reconcile(restartedReport);
      progress.push(
        `restart recovery classification: ${restartedRecovery.mode}`,
      );
      expect(restartedRecovery.pubkeys).toEqual(
        infos.map((info) => info.pubkey),
      );
      const channelIdsAfter = (
        await Promise.all(rpcs.map((rpc) => rpc.listChannels()))
      ).map((channels) => channels.map((channel) => channel.channel_id).sort());
      expect(channelIdsAfter).toEqual(channelIdsBefore);
      expect(await engine.status(layout.nodes[1].container)).toBe("running");

      const finalPayment = await orchestrator.pay(
        RECOVERY_NET,
        sender,
        receiver,
        100,
        `${restartedRecovery.mode} relay restart proof`,
      );
      expect(finalPayment.status).toBe("Success");

      const chain = new DevChain(`http://127.0.0.1:${layout.ckbHostPort}`);
      const tipBeforePause = await chain.tipBlock();
      const miningPause = await orchestrator.applyFault(
        RECOVERY_NET,
        "mining-pause",
      );
      expect(miningPause.observed.state).toBe("active");
      await expect(
        orchestrator.mineBlocks(RECOVERY_NET, 1),
      ).rejects.toMatchObject({ code: "MINING_PAUSED" });
      expect(await chain.tipBlock()).toBe(tipBeforePause);
      const miningReset = await orchestrator.resetFault(
        RECOVERY_NET,
        "mining-pause",
      );
      expect(miningReset.recovery).toBe("ready");
      expect(await chain.tipBlock()).toBeGreaterThan(tipBeforePause);

      const ckbFault = await orchestrator.applyFault(
        RECOVERY_NET,
        "ckb-unavailable",
      );
      expect(ckbFault.observed).toMatchObject({ state: "active" });
      expect(
        ckbFault.observed.attachments?.every(
          (attachment) => !attachment.connected,
        ),
      ).toBe(true);
      const ckbReset = await orchestrator.resetFault(
        RECOVERY_NET,
        "ckb-unavailable",
      );
      expect(ckbReset).toMatchObject({
        recovery: "ready",
        observed: { state: "inactive" },
      });

      const partition = await orchestrator.applyFault(
        RECOVERY_NET,
        "peer-partition",
        relay,
      );
      expect(partition.observed).toMatchObject({
        state: "active",
        containerStatus: "running",
      });
      expect(partition.observed.attachments).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            container: `forge-${RECOVERY_NET}-node-2`,
            network: `forge-${RECOVERY_NET}`,
            connected: false,
          }),
          expect.objectContaining({
            container: `forge-${RECOVERY_NET}-node-2`,
            network: expect.stringMatching(/^ffault-/),
            connected: true,
          }),
        ]),
      );
      await expect(rpcs[1].nodeInfo()).rejects.toThrow();
      const partitionReset = await orchestrator.resetFault(
        RECOVERY_NET,
        "peer-partition",
        relay,
      );
      const partitionRecovery = await reconcile(partitionReset);
      expect(partitionRecovery.pubkeys).toEqual(
        infos.map((info) => info.pubkey),
      );

      const outageScenario = parseScenario(
        [
          "version: 1",
          "steps:",
          `  - fault: { action: apply, kind: node-kill, target: ${relay} }`,
          "    expect: { node_status: stopped, timeout_ms: 10000 }",
          `  - pay: { from: ${sender}, to: ${receiver}, amount: 100, description: scenario outage proof }`,
          "    expect: { error_code: PAYMENT_FAILED }",
          `  - fault: { action: reset, kind: node-kill, target: ${relay} }`,
          "    expect: { node_status: running, timeout_ms: 60000 }",
        ].join("\n"),
      );
      const outageReport = await runScenario(
        orchestrator,
        RECOVERY_NET,
        outageScenario,
      );
      expect(outageReport).toMatchObject({
        format: "fiber-forge-scenario-report",
        passed: true,
        summary: { total: 3, passed: 3, failed: 0 },
      });
      expect(outageReport.steps[1]).toMatchObject({
        passed: true,
        assertions: [
          {
            type: "error_code",
            expected: "PAYMENT_FAILED",
            actual: "PAYMENT_FAILED",
          },
        ],
      });
      const killRecovery = await reconcile(
        await orchestrator.inspectNode(RECOVERY_NET, relay),
      );
      expect(killRecovery.pubkeys).toEqual(infos.map((info) => info.pubkey));

      const bundlePath = join(stateDir, "outage.ffbundle");
      const exported = await orchestrator.exportBundle(RECOVERY_NET, {
        scenario: outageScenario,
        report: outageReport,
        output: bundlePath,
      });
      expect(exported).toMatchObject({
        level: "recipe",
        artifacts: 3,
      });
      await expect(
        orchestrator.inspectBundle(bundlePath),
      ).resolves.toMatchObject({
        integrity: "verified",
        redaction: "verified",
        compatibility: { replayable: true },
        recipe: { network: RECOVERY_NET, executions: 3 },
      });
      const replay = await orchestrator.replayBundle(bundlePath, {
        network: REPLAY_NET,
        timeoutMs: 10 * 60_000,
        onProgress: (message) => {
          progress.push(`replay: ${message}`);
          console.log(`  replay: ${message}`);
        },
      });
      expect(replay).toMatchObject({
        network: REPLAY_NET,
        reproduced: true,
        differences: [],
        cleanup: { purged: true },
      });
      expect(await engine.listByLabel(FORGE_LABEL, REPLAY_NET)).toEqual([]);
      expect((await engine.forgeNets()).includes(REPLAY_NET)).toBe(false);
      expect(await engine.volumeExists(`forge-${REPLAY_NET}-ckb-data`)).toBe(
        false,
      );
      expect(await pathExists(join(stateDir, REPLAY_NET))).toBe(false);

      const forceCloseChannelId = channelIdsBefore[0][0];
      if (!forceCloseChannelId) {
        throw new Error(
          "sender channel id was unavailable for force-close proof",
        );
      }
      const forceObserverRestart = await orchestrator.restartNode(
        RECOVERY_NET,
        sender,
      );
      expect(forceObserverRestart).toMatchObject({
        status: "running",
        rpcReady: true,
        identityMatches: true,
      });

      const forceClose = await orchestrator.forceCloseChannel(
        RECOVERY_NET,
        sender,
        forceCloseChannelId,
        {
          confirmChannelId: forceCloseChannelId,
          timeoutMs: 420_000,
        },
      );
      expect(forceClose).toMatchObject({
        operation: "force-close",
        rpcAccepted: true,
        closeMode: "force",
        phase: "settled",
        settled: true,
        timedOut: false,
        channelState: "Closed",
        channelFlags: ["UNCOOPERATIVE_LOCAL"],
        closingTransaction: { status: "committed" },
        finalState: {
          state: "Closed",
          flags: ["UNCOOPERATIVE_LOCAL"],
        },
      });
      expect(forceClose.commitmentTransactionHash).toMatch(/^0x[0-9a-f]{64}$/);
      expect(forceClose.closingTransaction?.hash).toMatch(/^0x[0-9a-f]{64}$/);

      const restartedOrchestrator = new Orchestrator(
        engine,
        assetsDir,
        stateDir,
      );
      const reinspection = await restartedOrchestrator.inspectChannelSettlement(
        RECOVERY_NET,
        sender,
        forceCloseChannelId,
      );
      expect(reinspection).toMatchObject({
        operation: "inspect",
        rpcAccepted: null,
        phase: "settled",
        settled: true,
        commitmentTransactionHash: forceClose.commitmentTransactionHash,
        closingTransaction: {
          hash: forceClose.closingTransaction?.hash,
          status: "committed",
        },
        finalState: forceClose.finalState,
      });
      const teardownPartition = await orchestrator.applyFault(
        RECOVERY_NET,
        "peer-partition",
        relay,
      );
      const faultNetwork = teardownPartition.observed.attachments?.find(
        (attachment) => attachment.network.startsWith("ffault-"),
      )?.network;
      if (!faultNetwork) {
        throw new Error("partition did not report its managed fault network");
      }
      faultNetworksToCheck.push(faultNetwork);
    } catch (error) {
      failure = await addLiveDiagnostics(error, engine, progress, RECOVERY_NET);
    } finally {
      try {
        await verifyCleanup(
          orchestrator,
          engine,
          stateDir,
          RECOVERY_NET,
          faultNetworksToCheck,
        );
      } catch (error) {
        cleanupFailure =
          error instanceof Error ? error : new Error(String(error));
      }
    }

    if (failure && cleanupFailure) {
      throw new AggregateError(
        [failure, cleanupFailure],
        "live recovery test and cleanup both failed",
      );
    }
    if (failure) {
      throw failure;
    }
    if (cleanupFailure) {
      throw cleanupFailure;
    }
  }, 840_000);
});

describe.skipIf(!RUN)("live: partial provisioning rollback", () => {
  it("cleans up after a node container fails to start", async () => {
    await expectProvisionRollback(
      "e2e-rollback-node",
      new NodeStartFailureEngine(),
      {
        code: "CONTAINER_START_FAILED",
        resource: /forge-e2e-rollback-node-node-1/,
      },
    );
  }, 180_000);

  it("cleans up after peer connection fails", async () => {
    await expectProvisionRollback(
      "e2e-rollback-peer",
      new DockerEngine(),
      { code: "PROVISION_FAILED", resource: /peer connection/ },
      (message) => {
        if (message.startsWith("connect ")) {
          throw new Error("injected peer connection failure");
        }
      },
    );
  }, 180_000);

  it("cleans up after channel opening fails", async () => {
    await expectProvisionRollback(
      "e2e-rollback-channel",
      new DockerEngine(),
      { code: "PROVISION_FAILED", resource: /channel alice->bob/ },
      (message) => {
        if (message.startsWith("open channel ")) {
          throw new Error("injected channel opening failure");
        }
      },
    );
  }, 180_000);
});

describe.skipIf(!RUN)("live: UDT asset channel + payment", () => {
  const nodesOnly: Topology = {
    name: "e2e-udt",
    nodes: [{ name: "alice" }, { name: "bob" }],
    channels: [],
    funding: { perNodeCkb: 100000 },
  };

  it("issues UDT, opens a UDT channel, and pays a UDT invoice", async () => {
    const engine = new DockerEngine();
    const stateDir = await makeLiveStateDir("udt-");
    const orchestrator = new Orchestrator(engine, assetsDir, stateDir);
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
      await verifyCleanup(orchestrator, engine, stateDir, "e2e-udt");
    }
  }, 300_000);
});
