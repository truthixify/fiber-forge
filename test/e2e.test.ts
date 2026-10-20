import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DockerEngine } from "../src/engine";
import { FORGE_LABEL, Orchestrator } from "../src/orchestrator";
import { preset } from "../src/presets";
import {
  type Channel,
  FnnRpc,
  HttpTransport,
  dialAddress,
  isChannelReady,
  peerIdOf,
} from "../src/rpc";
import { type Topology } from "../src/topology";

// Live tests need a Docker daemon and pull the pinned CKB and Fiber images.
const RUN = process.env.FORGE_E2E === "1";
const assetsDir = join(import.meta.dirname, "..", "assets");
const MULTIHOP_NET = "e2e-multihop";
const RECOVERY_NET = "e2e-recovery";

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
    const stateDir = await mkdtemp(join(tmpdir(), "fiber-forge-e2e-"));
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
    const stateDir = await mkdtemp(join(tmpdir(), "fiber-forge-recovery-"));
    const orchestrator = new Orchestrator(engine, assetsDir, stateDir);
    const trio = { ...selected, name: RECOVERY_NET };
    const [sender, relay, receiver] = trio.nodes.map((node) => node.name);
    const progress: string[] = [];
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

      await engine.stop(layout.nodes[1].container);

      const stopped = await orchestrator.inspect(RECOVERY_NET);
      expect(stopped.nodes.find((node) => node.name === relay)?.status).toBe(
        "exited",
      );
      await expect(
        orchestrator.payInvoice(RECOVERY_NET, sender, interruptedInvoice),
      ).rejects.toThrow(/Failed to build route|Insufficient balance/i);

      await engine.start(layout.nodes[1].container);
      const expectedPeers = [
        [infos[1].pubkey],
        [infos[0].pubkey, infos[2].pubkey],
        [infos[1].pubkey],
      ];
      let recoveryMode = "automatic";
      let recoveredPubkeys: string[];
      try {
        recoveredPubkeys = await waitForNetworkRecovery(
          rpcs,
          [sender, relay, receiver],
          expectedPeers,
          10_000,
        );
      } catch (automaticError) {
        recoveryMode = "manual-peer-reconnect";
        progress.push(
          `automatic recovery incomplete: ${(automaticError as Error).message}`,
        );
        const relayPeerId = peerIdOf(infos[1]);
        if (!relayPeerId) {
          throw new Error(`restarted relay ${relay} has no peer id`);
        }
        await ensurePeerConnected(
          rpcs[0],
          infos[1].pubkey,
          dialAddress(layout.nodes[1].ip, relayPeerId),
        );
        recoveredPubkeys = await waitForNetworkRecovery(
          rpcs,
          [sender, relay, receiver],
          expectedPeers,
        );
      }
      progress.push(`recovery classification: ${recoveryMode}`);
      expect(recoveredPubkeys).toEqual(infos.map((info) => info.pubkey));
      const channelIdsAfter = (
        await Promise.all(rpcs.map((rpc) => rpc.listChannels()))
      ).map((channels) => channels.map((channel) => channel.channel_id).sort());
      expect(channelIdsAfter).toEqual(channelIdsBefore);
      expect(await engine.status(layout.nodes[1].container)).toBe("running");

      const recoveredInvoice = await orchestrator.createInvoice(
        RECOVERY_NET,
        receiver,
        100,
        `${recoveryMode} relay recovery proof`,
      );
      const recovered = await orchestrator.payInvoice(
        RECOVERY_NET,
        sender,
        recoveredInvoice,
      );
      expect(recovered.status).toBe("Success");
    } catch (error) {
      failure = await addLiveDiagnostics(error, engine, progress, RECOVERY_NET);
    } finally {
      try {
        await verifyCleanup(orchestrator, engine, stateDir, RECOVERY_NET);
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
  }, 360_000);
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
