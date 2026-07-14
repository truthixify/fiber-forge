/**
 * The orchestrator: `up` / `down` / `status` over a validated topology. `up` creates the docker
 * network, boots the CKB dev chain, then each fnn node (generating + encrypting a CKB key,
 * writing its config), waits for RPC, funds every node from the deployer, connects peers, opens
 * the declared channels, and drives blocks until each reaches CHANNEL_READY. Every step here is
 * proven live in `docs/dev-notes.md`.
 */

import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { DevChain, SIMPLE_UDT_CODE_HASH } from "./ckb";
import {
  CKB_RPC_PORT,
  FNN_P2P_PORT,
  FNN_RPC_PORT,
  type LayoutOptions,
  type NetworkLayout,
  type NodeLayout,
  type UdtWhitelistInfo,
  fnnConfigYaml,
  pickSubnetBase,
  planLayout,
} from "./config";
import { type ContainerEngine, type ContainerSpec } from "./engine";
import { encryptKey, generatePrivateKey } from "./keys";
import { findFreePort, findFreePortBlock } from "./ports";
import {
  type Channel,
  FnnRpc,
  HttpTransport,
  type NodeInfo,
  type OpenChannelParams,
  channelStateName,
  ckbToShannonHex,
  dialAddress,
  isChannelReady,
  isPaymentSettled,
  peerIdOf,
  shannonHexToCkb,
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
  /** If set, issue this many whole UDT to every node and mirror each channel as a UDT channel. */
  udtPerNode?: number;
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

/** The persisted layout of a running network (`~/.fiber-forge/<net>/layout.json`). */
export interface NetworkState {
  net: string;
  network: string;
  ckbHostPort: number;
  nodes: {
    name: string;
    container: string;
    ip: string;
    rpcHostPort: number;
    pubkey: string;
    ckbAddress: string;
  }[];
  channels: { from: string; to: string; capacityCkb: number }[];
}

/** A live view of a network for the GUI: block height, node status + balances, live channels. */
export interface NetworkView {
  net: string;
  block: number;
  nodes: {
    name: string;
    container: string;
    rpcHostPort: number;
    pubkey: string;
    status: string;
    onchainCkb: number;
    udtBalance: number;
  }[];
  channels: {
    from: string;
    to: string;
    capacityCkb: number;
    state: string;
    localCkb: number;
    remoteCkb: number;
    channelId: string;
    udt: boolean;
  }[];
}

/** A channel as seen from one node. */
export interface ChannelRow {
  node: string;
  channelId: string;
  peer: string;
  state: string;
  localCkb: number;
  remoteCkb: number;
}

/** The outcome of a payment. */
export interface PaymentReport {
  from: string;
  to: string;
  amountCkb: number;
  paymentHash: string;
  status: string;
}

/** One row of `fiber-forge ls`. */
export interface NetworkSummary {
  net: string;
  nodeCount: number;
  running: boolean;
}

const LOG_LEVEL_RANK: Record<string, number> = {
  trace: 0,
  debug: 1,
  info: 2,
  warn: 3,
  error: 4,
};

/** Keep only log lines whose level is at or above `level` (fnn logs `... LEVEL module: msg`). */
export function filterLogsByLevel(raw: string, level: string): string {
  const min = LOG_LEVEL_RANK[level.toLowerCase()] ?? 0;
  return raw
    .split("\n")
    .filter((line) => {
      const match = line.match(/\b(TRACE|DEBUG|INFO|WARN|ERROR)\b/);
      return match
        ? (LOG_LEVEL_RANK[match[1].toLowerCase()] ?? 0) >= min
        : false;
    })
    .join("\n");
}

export class Orchestrator {
  constructor(
    private readonly engine: ContainerEngine,
    private readonly assetsDir: string,
    private readonly stateDir = join(homedir(), ".fiber-forge"),
  ) {}

  /** Serializes channel opens per network: two fundings must not race for the same wallet cell. */
  private readonly openQueue = new Map<string, Promise<void>>();

  /** Bring the whole network up to funded, connected, CHANNEL_READY channels. */
  async up(
    topology: Topology,
    options: UpOptions = {},
  ): Promise<NetworkLayout> {
    const layoutOptions: LayoutOptions = { ...(options.layout ?? {}) };
    if (!layoutOptions.subnetBase) {
      layoutOptions.subnetBase = pickSubnetBase(
        topology.name,
        await this.engine.usedSubnets(),
      );
    }
    if (layoutOptions.ckbHostPort === undefined) {
      layoutOptions.ckbHostPort = await findFreePort(8114);
    }
    if (layoutOptions.rpcHostPortBase === undefined) {
      layoutOptions.rpcHostPortBase = await findFreePortBlock(
        8300,
        topology.nodes.length,
      );
    }
    const layout = planLayout(topology, layoutOptions);
    const log = options.onProgress ?? (() => {});
    const netDir = join(this.stateDir, layout.net);

    try {
      log(`network ${layout.network} (${layout.subnet})`);
      await this.engine.ensureNetwork(layout.network, layout.subnet);

      log(`ckb dev chain ${layout.ckbContainer}`);
      await this.engine.run(
        ckbContainerSpec(layout, this.assetsDir, options.ckbImage),
      );
      const chain = new DevChain(`http://127.0.0.1:${layout.ckbHostPort}`);
      await chain.waitReady();
      await chain.generateBlocks(2);

      const udtDep = await chain.udtDep();
      const udtWhitelist: UdtWhitelistInfo = {
        codeHash: SIMPLE_UDT_CODE_HASH,
        depTxHash: udtDep.txHash,
        depIndex: udtDep.index,
      };

      const privateKeys = new Map<string, string>();
      for (const node of layout.nodes) {
        const nodeDir = join(netDir, node.container);
        const privateKey = generatePrivateKey();
        privateKeys.set(node.name, hex(privateKey));
        await this.writeNodeDir(
          nodeDir,
          layout,
          node,
          privateKey,
          udtWhitelist,
        );
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

      const addressByName = new Map<string, string>();
      for (const node of layout.nodes) {
        const address = await chain.addressOfPrivateKey(
          privateKeys.get(node.name)!,
        );
        addressByName.set(node.name, address);
        log(`funding ${node.name} ${topology.funding.perNodeCkb} CKB`);
        await chain.fund(address, topology.funding.perNodeCkb);
      }
      await chain.generateBlocks(4);

      for (const channel of topology.channels) {
        const from = rpcByName.get(channel.from)!;
        const to = infoByName.get(channel.to)!;
        const toLayout = layout.nodes.find((n) => n.name === channel.to)!;
        log(`connect ${channel.from} -> ${channel.to}`);
        await from.connectPeer(
          dialAddress(toLayout.ip, to.peerId, FNN_P2P_PORT),
        );
        await this.waitPeerConnected(from, to.pubkey);
        log(
          `open channel ${channel.from} -> ${channel.to} (${channel.capacityCkb} CKB)`,
        );
        const priorReady = await this.readyChannelCount(from, to.pubkey);
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
          priorReady + 1,
        );
      }

      if (options.udtPerNode && options.udtPerNode > 0) {
        const amountUdt = options.udtPerNode;
        for (const node of layout.nodes) {
          log(`issuing ${amountUdt} UDT to ${node.name}`);
          await chain.issueUdt(
            addressByName.get(node.name)!,
            BigInt(Math.round(amountUdt * 1e8)),
          );
        }
        const udtTypeScript = await chain.udtScript();
        for (const channel of topology.channels) {
          const from = rpcByName.get(channel.from)!;
          const to = infoByName.get(channel.to)!;
          log(
            `open UDT channel ${channel.from} -> ${channel.to} (${channel.capacityCkb} UDT)`,
          );
          const priorReady = await this.readyChannelCount(from, to.pubkey);
          await this.openChannel(from, {
            pubkey: to.pubkey,
            fundingAmount: ckbToShannonHex(channel.capacityCkb),
            udtTypeScript,
          });
          await this.waitChannelReady(
            from,
            to.pubkey,
            chain,
            `${channel.from}->${channel.to} (UDT)`,
            log,
            priorReady + 1,
          );
        }
      }

      if (topology.channels.length > 0) {
        log("propagating routing graph");
        await this.waitGraphPropagated(rpcByName, topology.channels.length);
      }

      const state: NetworkState = {
        net: layout.net,
        network: layout.network,
        ckbHostPort: layout.ckbHostPort,
        nodes: layout.nodes.map((n) => ({
          name: n.name,
          container: n.container,
          ip: n.ip,
          rpcHostPort: n.rpcHostPort,
          pubkey: infoByName.get(n.name)!.pubkey,
          ckbAddress: addressByName.get(n.name)!,
        })),
        channels: topology.channels.map((c) => ({
          from: c.from,
          to: c.to,
          capacityCkb: c.capacityCkb,
        })),
      };
      await writeFile(
        join(netDir, "layout.json"),
        JSON.stringify(state, null, 2),
      );

      log(`network ${layout.net} ready`);
      return layout;
    } catch (error) {
      // A spawn that fails partway must not leave half-built containers running on the machine —
      // tear down whatever was created before surfacing the error.
      await this.down(layout.net, { purge: true }).catch(() => {});
      throw error;
    }
  }

  /** Wait until every node's routing graph has learned all `expected` channels, so a payment made
   * immediately after `up` can find a route instead of failing with "no path found". Bounded so it
   * never blocks forever. */
  private async waitGraphPropagated(
    rpcByName: Map<string, FnnRpc>,
    expected: number,
  ): Promise<void> {
    const deadline = Date.now() + 60_000;
    for (const rpc of rpcByName.values()) {
      while (Date.now() < deadline) {
        const count = await rpc.graphChannelCount().catch(() => 0);
        if (count >= expected) break;
        await sleep(1500);
      }
    }
  }

  /** A fully-live graph view for the GUI — real block height, node balances, and open channels. */
  async inspect(net: string): Promise<NetworkView> {
    const state = await this.readState(net);
    const chain = new DevChain(`http://127.0.0.1:${state.ckbHostPort}`);
    let block = 0;
    try {
      block = await chain.tipBlock();
    } catch {
      // chain unreachable
    }

    const nodes = [];
    for (const node of state.nodes) {
      let onchainCkb = 0;
      let udtBalance = 0;
      try {
        onchainCkb = Number(await chain.balanceOf(node.ckbAddress));
        udtBalance = Number(await chain.udtBalanceOf(node.ckbAddress)) / 1e8;
      } catch {
        // chain unreachable
      }
      nodes.push({
        name: node.name,
        container: node.container,
        rpcHostPort: node.rpcHostPort,
        pubkey: node.pubkey,
        status: await this.engine.status(node.container),
        onchainCkb,
        udtBalance,
      });
    }

    const nameByPubkey = new Map(state.nodes.map((n) => [n.pubkey, n.name]));
    const channels = [];
    const seen = new Set<string>();
    for (const node of state.nodes) {
      let live: Channel[];
      try {
        live = await this.rpcFor(node.rpcHostPort).listChannels();
      } catch {
        continue;
      }
      for (const channel of live) {
        if (seen.has(channel.channel_id)) {
          continue;
        }
        seen.add(channel.channel_id);
        const localCkb = shannonHexToCkb(channel.local_balance);
        const remoteCkb = shannonHexToCkb(channel.remote_balance);
        channels.push({
          from: node.name,
          to: nameByPubkey.get(channel.pubkey ?? "") ?? "?",
          capacityCkb: localCkb + remoteCkb,
          state: channelStateName(channel),
          localCkb,
          remoteCkb,
          channelId: channel.channel_id,
          udt: Boolean(channel.funding_udt_type_script),
        });
      }
    }

    return { net, block, nodes, channels };
  }

  /**
   * Tear a network down. By default removes its containers, network, and ckb data volume, keeping
   * the state dir. `keep` preserves the data volume too (for a stateful restart); `purge` also
   * deletes the state dir, leaving nothing on disk.
   */
  async down(
    net: string,
    options: { purge?: boolean; keep?: boolean } = {},
  ): Promise<void> {
    for (const name of await this.engine.listByLabel(FORGE_LABEL, net)) {
      await this.engine.stop(name);
      await this.engine.remove(name);
    }
    await this.engine.removeNetwork(`forge-${net}`);
    if (!options.keep) {
      await this.engine.removeVolume(`forge-${net}-ckb-data`);
    }
    if (options.purge) {
      await rm(join(this.stateDir, net), { recursive: true, force: true });
    }
  }

  /** Tear down every network on disk, in one call. Returns the names removed (in order). */
  async downAll(
    options: { purge?: boolean; keep?: boolean } = {},
  ): Promise<string[]> {
    // Discover nets from docker itself as well as the state dir, so orphaned networks (whose state
    // dir was already deleted) are still torn down instead of piling up and starving Docker.
    const stateNets = (await this.list()).map((summary) => summary.net);
    const dockerNets = await this.engine.forgeNets();
    const nets = [...new Set([...stateNets, ...dockerNets])];
    for (const net of nets) {
      await this.down(net, options);
    }
    return nets;
  }

  /** Every fiber-forge network on disk, with its node count and whether its ckb chain is running. */
  async list(): Promise<NetworkSummary[]> {
    let entries: string[];
    try {
      entries = await readdir(this.stateDir);
    } catch {
      return [];
    }
    const summaries: NetworkSummary[] = [];
    for (const net of entries.sort()) {
      try {
        const state = await this.readState(net);
        summaries.push({
          net,
          nodeCount: state.nodes.length,
          running: (await this.engine.status(`forge-${net}-ckb`)) === "running",
        });
      } catch {
        // not a network directory
      }
    }
    return summaries;
  }

  /**
   * Create an invoice on a node; returns the invoice address to pay. With `udt`, the invoice is
   * denominated in the dev UDT (`amount` is whole UDT; both scale by 8 decimals to base units).
   */
  async createInvoice(
    net: string,
    node: string,
    amount: number,
    description?: string,
    udt?: boolean,
  ): Promise<string> {
    const state = await this.readState(net);
    const target = this.requireNode(state, node);
    const udtTypeScript = udt
      ? await new DevChain(`http://127.0.0.1:${state.ckbHostPort}`).udtScript()
      : undefined;
    const { invoice_address } = await this.rpcFor(
      target.rpcHostPort,
    ).newInvoice({
      amount: ckbToShannonHex(amount),
      description,
      udtTypeScript,
    });
    return invoice_address;
  }

  /** Pay `amount` from one node to another (creates an invoice on the receiver, then pays it). */
  async pay(
    net: string,
    from: string,
    to: string,
    amount: number,
    description?: string,
    udt?: boolean,
  ): Promise<PaymentReport> {
    const invoice = await this.createInvoice(net, to, amount, description, udt);
    const status = await this.payInvoiceInternal(net, from, invoice);
    return {
      from,
      to,
      amountCkb: amount,
      paymentHash: status.paymentHash,
      status: status.status,
    };
  }

  /** Mint `amountUdt` whole units of the dev UDT into a node's wallet; returns the tx hash. */
  async issueUdt(
    net: string,
    node: string,
    amountUdt: number,
  ): Promise<string> {
    const state = await this.readState(net);
    const target = this.requireNode(state, node);
    const chain = new DevChain(`http://127.0.0.1:${state.ckbHostPort}`);
    return chain.issueUdt(
      target.ckbAddress,
      BigInt(Math.round(amountUdt * 1e8)),
    );
  }

  /** Pay an existing invoice string from a node. */
  async payInvoice(
    net: string,
    from: string,
    invoice: string,
  ): Promise<PaymentReport> {
    const result = await this.payInvoiceInternal(net, from, invoice);
    return {
      from,
      to: "",
      amountCkb: 0,
      paymentHash: result.paymentHash,
      status: result.status,
    };
  }

  /** Open a channel between two already-running nodes and wait until it is ready. */
  async openChannelBetween(
    net: string,
    from: string,
    to: string,
    capacity: number,
    onProgress?: (message: string) => void,
    udt?: boolean,
  ): Promise<void> {
    const prev = this.openQueue.get(net) ?? Promise.resolve();
    const task = prev
      .catch(() => {})
      .then(() =>
        this.openChannelBetweenInner(net, from, to, capacity, onProgress, udt),
      );
    this.openQueue.set(
      net,
      task.then(
        () => {},
        () => {},
      ),
    );
    return task;
  }

  private async openChannelBetweenInner(
    net: string,
    from: string,
    to: string,
    capacity: number,
    onProgress?: (message: string) => void,
    udt?: boolean,
  ): Promise<void> {
    const log = onProgress ?? (() => {});
    const state = await this.readState(net);
    const fromNode = this.requireNode(state, from);
    const toNode = this.requireNode(state, to);
    const fromRpc = this.rpcFor(fromNode.rpcHostPort);
    const toRpc = this.rpcFor(toNode.rpcHostPort);
    const chain = new DevChain(`http://127.0.0.1:${state.ckbHostPort}`);
    const udtTypeScript = udt ? await chain.udtScript() : undefined;
    // Confirm any in-flight funding/issuance txs first, so the opener has a spendable cell to fund
    // this channel (otherwise fnn fails with "capacity not enough" and stalls at AwaitingTxSignatures).
    await chain.generateBlocks(3);
    // A UDT channel is funded from the opener's UDT balance. On this devnet the UDT is free to
    // issue from genesis, so top up the shortfall automatically rather than failing — opening a
    // UDT channel then works without a separate `udt issue` step first.
    if (udt) {
      const balance =
        Number(await chain.udtBalanceOf(fromNode.ckbAddress)) / 1e8;
      if (balance < capacity) {
        const short = Math.ceil(capacity - balance);
        log(`issuing ${short} UDT to ${from}`);
        await chain.issueUdt(
          fromNode.ckbAddress,
          BigInt(Math.round(short * 1e8)),
        );
        await chain.generateBlocks(4);
      }
    }

    const toPeerId = peerIdOf(await toRpc.nodeInfo());
    if (!toPeerId) {
      throw new Error(`node ${to} has no announced peer address`);
    }
    log(`connect ${from} -> ${to}`);
    await fromRpc.connectPeer(dialAddress(toNode.ip, toPeerId, FNN_P2P_PORT));
    await this.waitPeerConnected(fromRpc, toNode.pubkey);
    log(`open channel ${from} -> ${to} (${capacity} ${udt ? "UDT" : "CKB"})`);
    const priorReady = await this.readyChannelCount(fromRpc, toNode.pubkey);
    await this.openChannel(fromRpc, {
      pubkey: toNode.pubkey,
      fundingAmount: ckbToShannonHex(capacity),
      udtTypeScript,
    });
    await this.waitChannelReady(
      fromRpc,
      toNode.pubkey,
      chain,
      `${from}->${to}`,
      log,
      priorReady + 1,
    );
  }

  /** Cooperatively close a channel by id, from the node that owns it. */
  async closeChannel(
    net: string,
    node: string,
    channelId: string,
  ): Promise<void> {
    const target = await this.nodeOf(net, node);
    await this.rpcFor(target.rpcHostPort).shutdownChannel(channelId);
  }

  /** Top up a running node's on-chain wallet from the deployer; returns the funding tx hash. */
  async fund(net: string, node: string, amountCkb: number): Promise<string> {
    const state = await this.readState(net);
    const target = this.requireNode(state, node);
    const chain = new DevChain(`http://127.0.0.1:${state.ckbHostPort}`);
    const tx = await chain.fund(target.ckbAddress, amountCkb);
    await chain.generateBlocks(4);
    return tx;
  }

  /** List channels across the network (or one node), with live state and balances. */
  async channels(net: string, node?: string): Promise<ChannelRow[]> {
    const state = await this.readState(net);
    const nodes = node ? [this.requireNode(state, node)] : state.nodes;
    const byPubkey = new Map(state.nodes.map((n) => [n.pubkey, n.name]));
    const rows: ChannelRow[] = [];
    for (const n of nodes) {
      let channels;
      try {
        channels = await this.rpcFor(n.rpcHostPort).listChannels();
      } catch {
        continue;
      }
      for (const channel of channels) {
        rows.push({
          node: n.name,
          channelId: channel.channel_id,
          peer: byPubkey.get(channel.pubkey ?? "") ?? "?",
          state: channelStateName(channel),
          localCkb: shannonHexToCkb(channel.local_balance),
          remoteCkb: shannonHexToCkb(channel.remote_balance),
        });
      }
    }
    return rows;
  }

  /** Recent logs for a node (or the ckb chain when `node` is `"ckb"`). */
  async logs(
    net: string,
    node: string,
    tailLines = 200,
    level?: string,
  ): Promise<string> {
    const state = await this.readState(net);
    const container =
      node === "ckb"
        ? `forge-${net}-ckb`
        : this.requireNode(state, node).container;
    const raw = await this.engine.logs(container, tailLines);
    return level ? filterLogsByLevel(raw, level) : raw;
  }

  private async payInvoiceInternal(
    net: string,
    from: string,
    invoice: string,
  ): Promise<{ paymentHash: string; status: string }> {
    const fromNode = await this.nodeOf(net, from);
    const rpc = this.rpcFor(fromNode.rpcHostPort);
    const sent = await this.sendPaymentSettling(rpc, invoice);
    const status = await this.waitPayment(rpc, sent.payment_hash);
    return { paymentHash: sent.payment_hash, status };
  }

  /** Send a payment, retrying while routing gossip settles. A channel that just reached
   * `ChannelReady` is not yet in the graph for a few seconds, so the first attempt can fail with
   * "no path found"; retry that specific error rather than surfacing it. */
  private async sendPaymentSettling(rpc: FnnRpc, invoice: string) {
    const deadline = Date.now() + 30_000;
    for (;;) {
      try {
        return await rpc.sendPayment(invoice);
      } catch (error) {
        const message = (error as Error).message ?? "";
        const routing = /no path found|pathfind|no route/i.test(message);
        if (!routing || Date.now() > deadline) {
          throw error;
        }
        await sleep(2000);
      }
    }
  }

  private async waitPayment(
    rpc: FnnRpc,
    paymentHash: string,
    timeoutMs = 60_000,
  ): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const { status } = await rpc.getPayment(paymentHash);
      if (isPaymentSettled(status)) {
        return status;
      }
      if (Date.now() > deadline) {
        return status;
      }
      await sleep(1000);
    }
  }

  private async readState(net: string): Promise<NetworkState> {
    try {
      return JSON.parse(
        await readFile(join(this.stateDir, net, "layout.json"), "utf8"),
      ) as NetworkState;
    } catch {
      throw new Error(`network "${net}" not found`);
    }
  }

  private requireNode(
    state: NetworkState,
    name: string,
  ): NetworkState["nodes"][number] {
    const node = state.nodes.find((n) => n.name === name);
    if (!node) {
      throw new Error(`network ${state.net} has no node "${name}"`);
    }
    return node;
  }

  private async nodeOf(
    net: string,
    name: string,
  ): Promise<NetworkState["nodes"][number]> {
    return this.requireNode(await this.readState(net), name);
  }

  private rpcFor(rpcHostPort: number): FnnRpc {
    return new FnnRpc(new HttpTransport(`http://127.0.0.1:${rpcHostPort}`));
  }

  private async writeNodeDir(
    dir: string,
    layout: NetworkLayout,
    node: NodeLayout,
    privateKey: Uint8Array,
    udt?: UdtWhitelistInfo,
  ): Promise<void> {
    await rm(dir, { recursive: true, force: true });
    await mkdir(join(dir, "ckb"), { recursive: true });
    await writeFile(
      join(dir, "ckb", "key"),
      encryptKey(privateKey, node.password),
    );
    await writeFile(join(dir, "config.yml"), fnnConfigYaml(layout, node, udt));
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
    params: OpenChannelParams,
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

  /** Ready channels a node currently has with a peer — the baseline a new open must exceed. */
  private async readyChannelCount(
    rpc: FnnRpc,
    peerPubkey: string,
  ): Promise<number> {
    return (await rpc.listChannels(peerPubkey)).filter(isChannelReady).length;
  }

  private async waitChannelReady(
    rpc: FnnRpc,
    peerPubkey: string,
    chain: DevChain,
    label: string,
    log: (message: string) => void,
    minReady = 1,
    timeoutMs = 120_000,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      // Mine a few blocks each pass so the funding tx proposes+commits quickly (CKB is two-step).
      await chain.generateBlocks(3);
      const channels = await rpc.listChannels(peerPubkey);
      // Count ready channels, not "any ready" — else a new channel to an already-connected peer
      // is reported ready the instant its sibling is, and the new one is left half-open.
      if (channels.filter(isChannelReady).length >= minReady) {
        log(`channel ${label} ready`);
        return;
      }
      if (Date.now() > deadline) {
        throw new Error(`channel ${label} did not reach CHANNEL_READY in time`);
      }
      await sleep(1000);
    }
  }
}
