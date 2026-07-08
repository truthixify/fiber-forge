/**
 * The orchestrator: `up` / `down` / `status` over a validated topology. `up` creates the docker
 * network, boots the CKB dev chain, then each fnn node (generating + encrypting a CKB key,
 * writing its config), waits for RPC, funds every node from the deployer, connects peers, opens
 * the declared channels, and drives blocks until each reaches CHANNEL_READY. Every step here is
 * proven live in `docs/dev-notes.md`.
 */

import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { DevChain } from "./ckb";
import {
  CKB_RPC_PORT,
  FNN_P2P_PORT,
  FNN_RPC_PORT,
  type LayoutOptions,
  type NetworkLayout,
  type NodeLayout,
  fnnConfigYaml,
  planLayout,
} from "./config";
import { type ContainerEngine, type ContainerSpec } from "./engine";
import { encryptKey, generatePrivateKey } from "./keys";
import {
  FnnRpc,
  HttpTransport,
  type NodeInfo,
  ckbToShannonHex,
  dialAddress,
  isChannelReady,
  peerIdOf,
} from "./rpc";
import { type Topology } from "./topology";

export const FORGE_LABEL = "fiber-forge";
export const DEFAULT_FNN_IMAGE = "nervos/fiber:0.9.0-rc7";
export const DEFAULT_CKB_IMAGE = "nervos/ckb:v0.201.0";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const hex = (bytes: Uint8Array) => "0x" + Buffer.from(bytes).toString("hex");

export interface UpOptions {
  fnnImage?: string;
  ckbImage?: string;
  layout?: LayoutOptions;
  onProgress?: (message: string) => void;
}

/** The CKB dev-chain container spec (contracts baked into genesis via the mounted assets). */
export function ckbContainerSpec(
  layout: NetworkLayout,
  assetsDir: string,
  ckbImage = DEFAULT_CKB_IMAGE,
): ContainerSpec {
  return {
    name: layout.ckbContainer,
    image: ckbImage,
    network: layout.network,
    ip: layout.ckbIp,
    user: "0",
    entrypoint: ["bash", "/assets/ckb-entrypoint.sh"],
    ports: [{ host: layout.ckbHostPort, container: CKB_RPC_PORT }],
    volumes: [
      { source: `forge-${layout.net}-ckb-data`, target: "/data" },
      { source: assetsDir, target: "/assets", readOnly: true },
    ],
    labels: { [FORGE_LABEL]: layout.net },
  };
}

/** An fnn node container spec (RPC bound to its private IP; p2p announced on a fixed port). */
export function nodeContainerSpec(
  layout: NetworkLayout,
  node: NodeLayout,
  nodeDir: string,
  fnnImage = DEFAULT_FNN_IMAGE,
): ContainerSpec {
  return {
    name: node.container,
    image: fnnImage,
    network: layout.network,
    ip: node.ip,
    user: "0",
    env: {
      FIBER_SECRET_KEY_PASSWORD: node.password,
      FIBER_LISTENING_ADDR: `/ip4/0.0.0.0/tcp/${FNN_P2P_PORT}`,
      FIBER_ANNOUNCE_LISTENING_ADDR: "true",
      FIBER_ANNOUNCE_PRIVATE_ADDR: "true",
      RUST_LOG: "info",
    },
    ports: [{ host: node.rpcHostPort, container: FNN_RPC_PORT }],
    volumes: [{ source: nodeDir, target: "/fiber" }],
    labels: { [FORGE_LABEL]: layout.net },
  };
}

export interface NodeStatus {
  name: string;
  container: string;
  rpcHostPort: number;
  status: string;
  pubkey?: string;
}

export class Orchestrator {
  constructor(
    private readonly engine: ContainerEngine,
    private readonly assetsDir: string,
    private readonly stateDir = join(homedir(), ".fiber-forge"),
  ) {}

  /** Bring the whole network up to funded, connected, CHANNEL_READY channels. */
  async up(
    topology: Topology,
    options: UpOptions = {},
  ): Promise<NetworkLayout> {
    const layout = planLayout(topology, options.layout);
    const log = options.onProgress ?? (() => {});
    const netDir = join(this.stateDir, layout.net);

    log(`network ${layout.network} (${layout.subnet})`);
    await this.engine.ensureNetwork(layout.network, layout.subnet);

    log(`ckb dev chain ${layout.ckbContainer}`);
    await this.engine.run(
      ckbContainerSpec(layout, this.assetsDir, options.ckbImage),
    );
    const chain = new DevChain(`http://127.0.0.1:${layout.ckbHostPort}`);
    await chain.waitReady();
    await chain.generateBlocks(2);

    const privateKeys = new Map<string, string>();
    for (const node of layout.nodes) {
      const nodeDir = join(netDir, node.container);
      const privateKey = generatePrivateKey();
      privateKeys.set(node.name, hex(privateKey));
      await this.writeNodeDir(nodeDir, layout, node, privateKey);
      log(`node ${node.name} (${node.ip})`);
      await this.engine.run(
        nodeContainerSpec(layout, node, nodeDir, options.fnnImage),
      );
    }

    const rpcByName = new Map<string, FnnRpc>();
    const infoByName = new Map<string, { pubkey: string; peerId: string }>();
    for (const node of layout.nodes) {
      const rpc = new FnnRpc(
        new HttpTransport(`http://127.0.0.1:${node.rpcHostPort}`),
      );
      rpcByName.set(node.name, rpc);
      log(`waiting for ${node.name} rpc`);
      const info = await this.waitNodeInfo(rpc);
      const peerId = peerIdOf(info);
      if (!peerId) {
        throw new Error(`node ${node.name} did not announce a peer address`);
      }
      infoByName.set(node.name, { pubkey: info.pubkey, peerId });
    }

    for (const node of layout.nodes) {
      const address = await chain.addressOfPrivateKey(
        privateKeys.get(node.name)!,
      );
      log(`funding ${node.name} ${topology.funding.perNodeCkb} CKB`);
      await chain.fund(address, topology.funding.perNodeCkb);
    }
    await chain.generateBlocks(4);

    for (const channel of topology.channels) {
      const from = rpcByName.get(channel.from)!;
      const to = infoByName.get(channel.to)!;
      const toLayout = layout.nodes.find((n) => n.name === channel.to)!;
      log(`connect ${channel.from} -> ${channel.to}`);
      await from.connectPeer(dialAddress(toLayout.ip, to.peerId, FNN_P2P_PORT));
      await this.waitPeerConnected(from, to.pubkey);
      log(
        `open channel ${channel.from} -> ${channel.to} (${channel.capacityCkb} CKB)`,
      );
      await this.openChannel(from, {
        pubkey: to.pubkey,
        fundingAmount: ckbToShannonHex(channel.capacityCkb),
      });
      await this.waitChannelReady(
        from,
        to.pubkey,
        chain,
        `${channel.from}->${channel.to}`,
        log,
      );
    }

    log(`network ${layout.net} ready`);
    return layout;
  }

  /** Remove all containers of a network, the network, and optionally its state + data volume. */
  async down(net: string, options: { purge?: boolean } = {}): Promise<void> {
    for (const name of await this.engine.listByLabel(FORGE_LABEL, net)) {
      await this.engine.stop(name);
      await this.engine.remove(name);
    }
    await this.engine.removeNetwork(`forge-${net}`);
    if (options.purge) {
      await rm(join(this.stateDir, net), { recursive: true, force: true });
    }
  }

  /** Machine-readable status of a running network. */
  async status(net: string): Promise<{ net: string; nodes: NodeStatus[] }> {
    const containers = await this.engine.listByLabel(FORGE_LABEL, net);
    const nodes: NodeStatus[] = [];
    for (const container of containers.filter((c) => c.includes("-node-"))) {
      const status = await this.engine.status(container);
      nodes.push({ name: container, container, rpcHostPort: 0, status });
    }
    return { net, nodes };
  }

  private async writeNodeDir(
    dir: string,
    layout: NetworkLayout,
    node: NodeLayout,
    privateKey: Uint8Array,
  ): Promise<void> {
    await rm(dir, { recursive: true, force: true });
    await mkdir(join(dir, "ckb"), { recursive: true });
    await writeFile(
      join(dir, "ckb", "key"),
      encryptKey(privateKey, node.password),
    );
    await writeFile(join(dir, "config.yml"), fnnConfigYaml(layout, node));
    // dev.toml references the contracts relatively; sitting beside them in /fiber it is `contracts`.
    const devToml = await readFile(join(this.assetsDir, "dev.toml"), "utf8");
    await writeFile(
      join(dir, "dev.toml"),
      devToml.replaceAll("../../deploy/contracts", "contracts"),
    );
    await cp(join(this.assetsDir, "contracts"), join(dir, "contracts"), {
      recursive: true,
    });
  }

  private async waitNodeInfo(
    rpc: FnnRpc,
    timeoutMs = 60_000,
  ): Promise<NodeInfo> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      try {
        const info = await rpc.nodeInfo();
        if (peerIdOf(info)) {
          return info;
        }
      } catch {
        // node not ready yet
      }
      if (Date.now() > deadline) {
        throw new Error("node did not announce its RPC + peer address in time");
      }
      await sleep(1000);
    }
  }

  /** Wait until `pubkey` appears in the node's peer list (the connection handshake finished). */
  private async waitPeerConnected(
    rpc: FnnRpc,
    pubkey: string,
    timeoutMs = 30_000,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const peers = await rpc.listPeers();
      if (peers.some((peer) => peer.pubkey === pubkey)) {
        return;
      }
      if (Date.now() > deadline) {
        throw new Error(`peer ${pubkey} did not connect in time`);
      }
      await sleep(1000);
    }
  }

  /**
   * Open a channel, retrying through the transient "waiting for peer to send Init message" error
   * that occurs while the just-connected peer completes feature negotiation.
   */
  private async openChannel(
    rpc: FnnRpc,
    params: { pubkey: string; fundingAmount: string },
    attempts = 15,
  ): Promise<void> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        await rpc.openChannel(params);
        return;
      } catch (error) {
        if (attempt >= attempts) {
          throw error;
        }
        await sleep(2000);
      }
    }
  }

  private async waitChannelReady(
    rpc: FnnRpc,
    peerPubkey: string,
    chain: DevChain,
    label: string,
    log: (message: string) => void,
    timeoutMs = 120_000,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      await chain.generateBlocks(1);
      const channels = await rpc.listChannels(peerPubkey);
      if (channels.some(isChannelReady)) {
        log(`channel ${label} ready`);
        return;
      }
      if (Date.now() > deadline) {
        throw new Error(`channel ${label} did not reach CHANNEL_READY in time`);
      }
      await sleep(2000);
    }
  }
}
