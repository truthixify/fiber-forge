/**
 * The orchestrator: `up` / `down` / `status` over a validated topology. `up` creates the docker
 * network, boots the CKB dev chain, then each fnn node (generating + encrypting a CKB key,
 * writing its config), waits for RPC, funds every node from the deployer, connects peers, opens
 * the declared channels, and drives blocks until each reaches CHANNEL_READY. Every step here is
 * proven live in `docs/dev-notes.md`.
 */

import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";

import { DevChain, SIMPLE_UDT_CODE_HASH } from "./ckb.js";
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
} from "./config.js";
import {
  type ContainerEngine,
  type ContainerSpec,
  type ContainerStatus,
} from "./engine.js";
import { ForgeError, errorDetails } from "./errors.js";
import { encryptKey, generatePrivateKey } from "./keys.js";
import { findFreePort, findFreePortBlock, isPortFree } from "./ports.js";
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
} from "./rpc.js";
import { isValidNetworkName, type Topology } from "./topology.js";

export const FORGE_LABEL = "fiber-forge";
const packageMetadata = createRequire(import.meta.url)("../package.json") as {
  fiberForge: { images: { ckb: string; fiber: string } };
};
export const DEFAULT_FNN_IMAGE = packageMetadata.fiberForge.images.fiber;
export const DEFAULT_CKB_IMAGE = packageMetadata.fiberForge.images.ckb;

const sleep = (ms: number) =>
  new Promise<void>((resolvePromise) => setTimeout(resolvePromise, ms));
const hex = (bytes: Uint8Array) => "0x" + Buffer.from(bytes).toString("hex");
export const DEFAULT_PROVISION_TIMEOUT_MS = 10 * 60_000;

function nodeRuntimeStatus(status: ContainerStatus): NodeRuntimeStatus {
  return status === "exited" ? "stopped" : status;
}

class ProvisionGuard {
  private readonly deadline: number;

  constructor(
    private readonly net: string,
    private readonly timeoutMs: number,
    private readonly signal?: AbortSignal,
  ) {
    this.deadline = Date.now() + timeoutMs;
  }

  check(resource: string): void {
    if (this.signal?.aborted) {
      throw new ForgeError(
        "OPERATION_ABORTED",
        `provisioning network "${this.net}" was aborted at ${resource}`,
        {
          resource,
          action: "retry with a fresh AbortSignal when ready",
          cause: this.signal.reason,
        },
      );
    }
    if (Date.now() >= this.deadline) {
      throw new ForgeError(
        "OPERATION_TIMEOUT",
        `provisioning network "${this.net}" exceeded its ${this.timeoutMs}ms timeout at ${resource}`,
        {
          resource,
          action: "increase UpOptions.timeoutMs or inspect the named resource",
        },
      );
    }
  }

  remaining(limitMs: number, resource: string): number {
    this.check(resource);
    return Math.max(1, Math.min(limitMs, this.deadline - Date.now()));
  }

  async wait(delayMs: number, resource: string): Promise<void> {
    this.check(resource);
    const timeoutMs = Math.max(
      0,
      Math.min(delayMs, this.deadline - Date.now()),
    );
    await new Promise<void>((resolvePromise, rejectPromise) => {
      let settled = false;
      const finish = (callback: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.signal?.removeEventListener("abort", onAbort);
        callback();
      };
      const onAbort = () =>
        finish(() => {
          try {
            this.check(resource);
          } catch (error) {
            rejectPromise(error);
          }
        });
      const timer = setTimeout(() => finish(resolvePromise), timeoutMs);
      this.signal?.addEventListener("abort", onAbort, { once: true });
    });
    this.check(resource);
  }
}

function waitWithGuard(
  delayMs: number,
  guard: ProvisionGuard | undefined,
  resource: string,
): Promise<void> {
  return guard ? guard.wait(delayMs, resource) : sleep(delayMs);
}

export interface UpOptions {
  fnnImage?: string;
  ckbImage?: string;
  layout?: LayoutOptions;
  onProgress?: (message: string) => void;
  /** Cancel provisioning cooperatively. Rollback finishes before the promise rejects. */
  signal?: AbortSignal;
  /** Overall provisioning deadline in milliseconds. Defaults to 10 minutes. */
  timeoutMs?: number;
  /** If set, issue this many whole UDT to every node and mirror each channel as a UDT channel. */
  udtPerNode?: number;
}

/** Options controlling how much persisted state is retained during teardown. */
export interface DownOptions {
  /** Remove the saved layout directory as well as runtime resources. */
  purge?: boolean;
  /** Preserve the CKB data volume when removing the network containers. */
  keep?: boolean;
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
  // Match bind-mounted state ownership so purge can remove node-created files on native Linux.
  const user =
    typeof process.getuid === "function" && typeof process.getgid === "function"
      ? `${process.getuid()}:${process.getgid()}`
      : undefined;
  return {
    name: node.container,
    image: fnnImage,
    network: layout.network,
    ip: node.ip,
    user,
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

/** A supported operation on one persisted Fiber node container. */
export type NodeLifecycleAction = "inspect" | "stop" | "start" | "restart";

/** User-facing node states. Docker's `exited` state is reported as `stopped`. */
export type NodeRuntimeStatus = "running" | "stopped" | "absent";

/** One live channel observation made after a node RPC becomes ready. */
export interface NodeChannelObservation {
  channelId: string | null;
  peer: string;
  state: string;
  connected: boolean;
}

/** Options for bounded node start and restart readiness checks. */
export interface NodeLifecycleOptions {
  /** Maximum time to wait for the node RPC and identity. Defaults to 60 seconds. */
  timeoutMs?: number;
  /** Maximum time to observe automatic peer/channel recovery. Defaults to 10 seconds. */
  reconcileTimeoutMs?: number;
}

/** Machine-readable result shared by the SDK, CLI, daemon, and GUI. */
export interface NodeLifecycleReport {
  net: string;
  node: string;
  action: NodeLifecycleAction;
  previousStatus: NodeRuntimeStatus;
  status: NodeRuntimeStatus;
  changed: boolean;
  rpcReady: boolean;
  identityMatches: boolean | null;
  channels: NodeChannelObservation[];
  recovery: "not-applicable" | "ready" | "action-required";
  nextAction: string | null;
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
    private readonly makeRpc: (rpcHostPort: number) => FnnRpc = (rpcHostPort) =>
      new FnnRpc(new HttpTransport(`http://127.0.0.1:${rpcHostPort}`)),
  ) {}

  /** Serializes channel opens per network: two fundings must not race for the same wallet cell. */
  private readonly openQueue = new Map<string, Promise<void>>();

  /** Serializes lifecycle mutations for one node while allowing unrelated nodes to proceed. */
  private readonly lifecycleQueue = new Map<string, Promise<void>>();

  private invalidPort(port: number, resource: string): ForgeError {
    return new ForgeError(
      "INVALID_PORT",
      `${resource} must be an integer between 1 and 65535`,
      { resource, action: "choose a valid host port and retry" },
    );
  }

  private requireNetworkName(net: string): void {
    if (!isValidNetworkName(net)) {
      throw new ForgeError(
        "INVALID_NETWORK_NAME",
        `network name "${net}" must be lowercase alphanumeric/hyphen (1-30 chars)`,
        {
          resource: net,
          action: "use a network name such as my-network",
        },
      );
    }
  }

  private async resolvePorts(
    topology: Topology,
    requested: LayoutOptions,
  ): Promise<LayoutOptions> {
    const options = { ...requested };
    if (options.ckbHostPort !== undefined) {
      if (
        !Number.isInteger(options.ckbHostPort) ||
        options.ckbHostPort < 1 ||
        options.ckbHostPort > 65535
      ) {
        throw this.invalidPort(options.ckbHostPort, "CKB RPC port");
      }
    } else {
      options.ckbHostPort = await findFreePort(8114);
    }

    if (options.rpcHostPortBase !== undefined) {
      const last = options.rpcHostPortBase + topology.nodes.length - 1;
      if (
        !Number.isInteger(options.rpcHostPortBase) ||
        options.rpcHostPortBase < 1 ||
        last > 65535
      ) {
        throw this.invalidPort(options.rpcHostPortBase, "Fiber RPC port base");
      }
    } else {
      let searchFrom = 8300;
      for (;;) {
        const candidate = await findFreePortBlock(
          searchFrom,
          topology.nodes.length,
        );
        const last = candidate + topology.nodes.length - 1;
        if (options.ckbHostPort! < candidate || options.ckbHostPort! > last) {
          options.rpcHostPortBase = candidate;
          break;
        }
        searchFrom = candidate + 1;
      }
    }

    const ports = [
      { label: "CKB RPC port", value: options.ckbHostPort! },
      ...topology.nodes.map((_node, index) => ({
        label: `Fiber RPC port ${index + 1}`,
        value: options.rpcHostPortBase! + index,
      })),
    ];
    const seen = new Map<number, string>();
    for (const port of ports) {
      const prior = seen.get(port.value);
      if (prior) {
        throw new ForgeError(
          "PORT_IN_USE",
          `${port.label} ${port.value} overlaps ${prior}`,
          {
            resource: `127.0.0.1:${port.value}`,
            action: "choose non-overlapping --ckb-port and --rpc-base values",
          },
        );
      }
      seen.set(port.value, port.label);
      if (!(await isPortFree(port.value))) {
        throw new ForgeError(
          "PORT_IN_USE",
          `${port.label} ${port.value} is already in use`,
          {
            resource: `127.0.0.1:${port.value}`,
            action: `free port ${port.value} or choose a different port`,
          },
        );
      }
    }
    return options;
  }

  private async prepareNetwork(net: string): Promise<void> {
    const containers = await this.engine.listByLabel(FORGE_LABEL, net);
    const statuses = await Promise.all(
      containers.map(
        async (name) => [name, await this.engine.status(name)] as const,
      ),
    );
    const running = statuses
      .filter(([, status]) => status === "running")
      .map(([name]) => name);
    if (running.length > 0) {
      throw new ForgeError(
        "NETWORK_EXISTS",
        `network "${net}" already has running containers: ${running.join(", ")}`,
        {
          resource: net,
          action: `run "fiber-forge down ${net}" before replacing it`,
        },
      );
    }

    for (const [name] of statuses) {
      await this.engine.stop(name);
      await this.engine.remove(name);
    }
    if ((await this.engine.forgeNets()).includes(net)) {
      await this.engine.removeNetwork(`forge-${net}`);
    }
    await this.engine.removeVolume(`forge-${net}-ckb-data`);
    const netDir = join(this.stateDir, net);
    try {
      await rm(netDir, { recursive: true, force: true });
    } catch (error) {
      throw new ForgeError(
        "PROVISION_FAILED",
        `could not remove stale network state at "${netDir}"`,
        {
          resource: netDir,
          action: "fix the state directory permissions, remove it, then retry",
          cause: error,
        },
      );
    }
  }

  /** Bring the whole network up to funded, connected, CHANNEL_READY channels. */
  async up(
    topology: Topology,
    options: UpOptions = {},
  ): Promise<NetworkLayout> {
    this.requireNetworkName(topology.name);
    const timeoutMs = options.timeoutMs ?? DEFAULT_PROVISION_TIMEOUT_MS;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new ForgeError(
        "INVALID_TIMEOUT",
        "UpOptions.timeoutMs must be a positive finite number",
        {
          resource: "UpOptions.timeoutMs",
          action: "provide a positive timeout in milliseconds",
        },
      );
    }
    const guard = new ProvisionGuard(topology.name, timeoutMs, options.signal);
    guard.check("preflight");
    const layoutOptions = await this.resolvePorts(
      topology,
      options.layout ?? {},
    );
    guard.check("port preflight");
    await this.prepareNetwork(topology.name);
    guard.check("stale resource cleanup");
    if (!layoutOptions.subnetBase) {
      layoutOptions.subnetBase = pickSubnetBase(
        topology.name,
        await this.engine.usedSubnets(),
      );
      guard.check("Docker subnet discovery");
    }
    const layout = planLayout(topology, layoutOptions);
    const log = options.onProgress ?? (() => {});
    const netDir = join(this.stateDir, layout.net);
    let phase = `Docker network ${layout.network}`;

    try {
      guard.check(phase);
      log(`network ${layout.network} (${layout.subnet})`);
      guard.check(phase);
      await this.engine.ensureNetwork(layout.network, layout.subnet);
      guard.check(phase);

      phase = `CKB container ${layout.ckbContainer}`;
      guard.check(phase);
      log(`ckb dev chain ${layout.ckbContainer}`);
      guard.check(phase);
      await this.engine.run(
        ckbContainerSpec(layout, this.assetsDir, options.ckbImage),
      );
      guard.check(phase);
      const chain = new DevChain(`http://127.0.0.1:${layout.ckbHostPort}`);
      await chain.waitReady(guard.remaining(60_000, phase));
      guard.check(phase);
      await chain.generateBlocks(2);
      guard.check(phase);

      const udtDep = await chain.udtDep();
      guard.check(phase);
      const udtWhitelist: UdtWhitelistInfo = {
        codeHash: SIMPLE_UDT_CODE_HASH,
        depTxHash: udtDep.txHash,
        depIndex: udtDep.index,
      };

      const privateKeys = new Map<string, string>();
      for (const node of layout.nodes) {
        phase = `Fiber container ${node.container}`;
        guard.check(phase);
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
        guard.check(phase);
        log(`node ${node.name} (${node.ip})`);
        guard.check(phase);
        await this.engine.run(
          nodeContainerSpec(layout, node, nodeDir, options.fnnImage),
        );
        guard.check(phase);
      }

      const rpcByName = new Map<string, FnnRpc>();
      const infoByName = new Map<string, { pubkey: string; peerId: string }>();
      for (const node of layout.nodes) {
        phase = `Fiber RPC for node ${node.name}`;
        guard.check(phase);
        const rpc = new FnnRpc(
          new HttpTransport(`http://127.0.0.1:${node.rpcHostPort}`),
        );
        rpcByName.set(node.name, rpc);
        log(`waiting for ${node.name} rpc`);
        guard.check(phase);
        const info = await this.waitNodeInfo(rpc, 60_000, guard, phase);
        const peerId = peerIdOf(info);
        if (!peerId) {
          throw new Error(`node ${node.name} did not announce a peer address`);
        }
        infoByName.set(node.name, { pubkey: info.pubkey, peerId });
      }

      const addressByName = new Map<string, string>();
      for (const node of layout.nodes) {
        phase = `funding node ${node.name}`;
        guard.check(phase);
        const address = await chain.addressOfPrivateKey(
          privateKeys.get(node.name)!,
        );
        addressByName.set(node.name, address);
        log(`funding ${node.name} ${topology.funding.perNodeCkb} CKB`);
        guard.check(phase);
        await chain.fund(address, topology.funding.perNodeCkb);
        guard.check(phase);
      }
      await chain.generateBlocks(4);
      guard.check(phase);

      for (const channel of topology.channels) {
        phase = `peer connection ${channel.from}->${channel.to}`;
        guard.check(phase);
        const from = rpcByName.get(channel.from)!;
        const to = infoByName.get(channel.to)!;
        const toLayout = layout.nodes.find((n) => n.name === channel.to)!;
        log(`connect ${channel.from} -> ${channel.to}`);
        guard.check(phase);
        await from.connectPeer(
          dialAddress(toLayout.ip, to.peerId, FNN_P2P_PORT),
        );
        guard.check(phase);
        await this.waitPeerConnected(from, to.pubkey, 30_000, guard, phase);
        phase = `channel ${channel.from}->${channel.to}`;
        guard.check(phase);
        log(
          `open channel ${channel.from} -> ${channel.to} (${channel.capacityCkb} CKB)`,
        );
        guard.check(phase);
        const priorReady = await this.readyChannelCount(from, to.pubkey);
        guard.check(phase);
        await this.openChannel(
          from,
          {
            pubkey: to.pubkey,
            fundingAmount: ckbToShannonHex(channel.capacityCkb),
          },
          15,
          guard,
          phase,
        );
        await this.waitChannelReady(
          from,
          to.pubkey,
          chain,
          `${channel.from}->${channel.to}`,
          log,
          priorReady + 1,
          120_000,
          guard,
        );
      }

      if (options.udtPerNode && options.udtPerNode > 0) {
        const amountUdt = options.udtPerNode;
        for (const node of layout.nodes) {
          phase = `UDT issuance for node ${node.name}`;
          guard.check(phase);
          log(`issuing ${amountUdt} UDT to ${node.name}`);
          guard.check(phase);
          await chain.issueUdt(
            addressByName.get(node.name)!,
            BigInt(Math.round(amountUdt * 1e8)),
          );
          guard.check(phase);
        }
        const udtTypeScript = await chain.udtScript();
        guard.check(phase);
        for (const channel of topology.channels) {
          phase = `UDT channel ${channel.from}->${channel.to}`;
          guard.check(phase);
          const from = rpcByName.get(channel.from)!;
          const to = infoByName.get(channel.to)!;
          log(
            `open UDT channel ${channel.from} -> ${channel.to} (${channel.capacityCkb} UDT)`,
          );
          guard.check(phase);
          const priorReady = await this.readyChannelCount(from, to.pubkey);
          guard.check(phase);
          await this.openChannel(
            from,
            {
              pubkey: to.pubkey,
              fundingAmount: ckbToShannonHex(channel.capacityCkb),
              udtTypeScript,
            },
            15,
            guard,
            phase,
          );
          await this.waitChannelReady(
            from,
            to.pubkey,
            chain,
            `${channel.from}->${channel.to} (UDT)`,
            log,
            priorReady + 1,
            120_000,
            guard,
          );
        }
      }

      if (topology.channels.length > 0) {
        phase = "routing graph propagation";
        guard.check(phase);
        log("propagating routing graph");
        guard.check(phase);
        await this.waitGraphPropagated(
          rpcByName,
          topology.channels.length,
          guard,
        );
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
      guard.check("persisting network state");

      log(`network ${layout.net} ready`);
      guard.check("network ready");
      return layout;
    } catch (error) {
      let controlError: unknown;
      try {
        guard.check(phase);
      } catch (guardError) {
        controlError = guardError;
      }
      const primary =
        controlError instanceof ForgeError
          ? controlError
          : error instanceof ForgeError
            ? error
            : new ForgeError(
                "PROVISION_FAILED",
                `failed to provision network "${layout.net}" at ${phase}: ${errorDetails(error).message}`,
                {
                  resource: phase,
                  action: "inspect the named resource, then retry provisioning",
                  cause: error,
                },
              );
      try {
        await this.down(layout.net, { purge: true });
      } catch (rollbackError) {
        throw new ForgeError(
          "ROLLBACK_FAILED",
          `${primary.message}; rollback also failed: ${errorDetails(rollbackError).message}`,
          {
            resource: layout.net,
            action: `run "fiber-forge down ${layout.net} --purge" after fixing Docker`,
            cause: new AggregateError([primary, rollbackError]),
          },
        );
      }
      throw primary;
    }
  }

  /** Wait until every node's routing graph has learned all `expected` channels, so a payment made
   * immediately after `up` can find a route instead of failing with "no path found". Bounded so it
   * never blocks forever. */
  private async waitGraphPropagated(
    rpcByName: Map<string, FnnRpc>,
    expected: number,
    guard?: ProvisionGuard,
  ): Promise<void> {
    const resource = "routing graph propagation";
    const timeoutMs = guard?.remaining(180_000, resource) ?? 180_000;
    const deadline = Date.now() + timeoutMs;
    let counts = new Map<string, number>();
    for (;;) {
      guard?.check(resource);
      counts = new Map(
        await Promise.all(
          [...rpcByName].map(
            async ([name, rpc]) =>
              [name, await rpc.graphChannelCount().catch(() => 0)] as const,
          ),
        ),
      );
      guard?.check(resource);
      if ([...counts.values()].every((count) => count >= expected)) {
        return;
      }
      if (Date.now() > deadline) {
        guard?.check(resource);
        const observed = [...counts]
          .map(([name, count]) => `${name}=${count}/${expected}`)
          .join(", ");
        throw new Error(
          `routing graph did not propagate in 180s (${observed})`,
        );
      }
      await waitWithGuard(1500, guard, resource);
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

  /** Inspect one recorded node without changing its container state. */
  async inspectNode(net: string, node: string): Promise<NodeLifecycleReport> {
    return this.queueNodeLifecycle(net, node, async () => {
      const state = await this.readState(net);
      const target = this.requireNode(state, node);
      const dockerStatus = await this.engine.status(target.container);
      const status = nodeRuntimeStatus(dockerStatus);
      if (status !== "running") {
        return {
          net,
          node,
          action: "inspect",
          previousStatus: status,
          status,
          changed: false,
          rpcReady: false,
          identityMatches: null,
          channels: [],
          recovery: "action-required",
          nextAction:
            status === "stopped"
              ? `run "fiber-forge node start ${net} ${node}"`
              : `recreate network "${net}" because container "${target.container}" is missing`,
        };
      }

      const rpc = this.rpcFor(target.rpcHostPort);
      let info: NodeInfo;
      try {
        info = await rpc.nodeInfo();
      } catch {
        return {
          net,
          node,
          action: "inspect",
          previousStatus: status,
          status,
          changed: false,
          rpcReady: false,
          identityMatches: null,
          channels: [],
          recovery: "action-required",
          nextAction: `inspect logs with "fiber-forge logs ${net} ${node}"`,
        };
      }

      const identityMatches = info.pubkey === target.pubkey;
      const observed = await this.observeNodeRecovery(state, target, rpc, 0);
      return {
        net,
        node,
        action: "inspect",
        previousStatus: status,
        status,
        changed: false,
        rpcReady: true,
        identityMatches,
        channels: observed.channels,
        recovery:
          identityMatches && observed.ready ? "ready" : "action-required",
        nextAction:
          identityMatches && observed.ready
            ? null
            : identityMatches
              ? `inspect peers and channels, then retry "fiber-forge node inspect ${net} ${node} --json"`
              : `recreate network "${net}"; the running container identity does not match saved state`,
      };
    });
  }

  /** Stop one Fiber node while retaining its container and bind-mounted state. */
  async stopNode(net: string, node: string): Promise<NodeLifecycleReport> {
    return this.queueNodeLifecycle(net, node, async () => {
      const state = await this.readState(net);
      const target = this.requireNode(state, node);
      const previousStatus = nodeRuntimeStatus(
        await this.engine.status(target.container),
      );
      this.requireNodeContainer(net, node, target.container, previousStatus);

      if (previousStatus === "running") {
        await this.engine.stop(target.container);
      }
      const status = nodeRuntimeStatus(
        await this.engine.status(target.container),
      );
      if (status !== "stopped") {
        throw new ForgeError(
          "NODE_STATE_MISMATCH",
          `node "${node}" did not reach stopped state (observed ${status})`,
          {
            resource: `${net}/${node}`,
            action: `inspect Docker container "${target.container}" and retry`,
          },
        );
      }

      return {
        net,
        node,
        action: "stop",
        previousStatus,
        status,
        changed: previousStatus !== status,
        rpcReady: false,
        identityMatches: null,
        channels: [],
        recovery: "not-applicable",
        nextAction: `run "fiber-forge node start ${net} ${node}" to restore the process`,
      };
    });
  }

  /** Start one stopped Fiber node and report its observed identity, peers, and channel state. */
  async startNode(
    net: string,
    node: string,
    options: NodeLifecycleOptions = {},
  ): Promise<NodeLifecycleReport> {
    return this.queueNodeLifecycle(net, node, () =>
      this.startNodeNow(net, node, "start", options),
    );
  }

  /** Stop and start one Fiber node without replacing its persisted container or node data. */
  async restartNode(
    net: string,
    node: string,
    options: NodeLifecycleOptions = {},
  ): Promise<NodeLifecycleReport> {
    return this.queueNodeLifecycle(net, node, () =>
      this.startNodeNow(net, node, "restart", options),
    );
  }

  /**
   * Tear a network down. By default removes its containers, network, and ckb data volume, keeping
   * the state dir. `keep` preserves the CKB data volume too; `purge` also deletes the state dir,
   * leaving nothing on disk. Teardown removes Fiber containers, so it is not a node restart path.
   */
  async down(net: string, options: DownOptions = {}): Promise<void> {
    this.requireNetworkName(net);
    const failures: string[] = [];
    let containerRemovalFailed = false;
    const containers = await this.engine.listByLabel(FORGE_LABEL, net);
    for (const name of containers) {
      let stopFailure: string | undefined;
      try {
        await this.engine.stop(name);
      } catch (error) {
        stopFailure = `stop ${name}: ${errorDetails(error).message}`;
      }
      try {
        await this.engine.remove(name);
      } catch (error) {
        containerRemovalFailed = true;
        if (stopFailure) {
          failures.push(stopFailure);
        }
        failures.push(`remove ${name}: ${errorDetails(error).message}`);
      }
    }
    try {
      await this.engine.removeNetwork(`forge-${net}`);
    } catch (error) {
      failures.push(
        `remove network forge-${net}: ${errorDetails(error).message}`,
      );
    }
    if (!options.keep) {
      try {
        await this.engine.removeVolume(`forge-${net}-ckb-data`);
      } catch (error) {
        failures.push(
          `remove volume forge-${net}-ckb-data: ${errorDetails(error).message}`,
        );
      }
    }
    if (options.purge && !containerRemovalFailed) {
      try {
        await rm(join(this.stateDir, net), { recursive: true, force: true });
      } catch (error) {
        failures.push(`remove state ${net}: ${errorDetails(error).message}`);
      }
    }
    if (failures.length > 0) {
      throw new ForgeError(
        "DOCKER_OPERATION_FAILED",
        `network "${net}" teardown was incomplete: ${failures.join("; ")}`,
        {
          resource: net,
          action: `fix the reported resources, then run "fiber-forge down ${net}${options.purge ? " --purge" : ""}" again`,
        },
      );
    }
  }

  /** Tear down every network on disk, in one call. Returns the names removed (in order). */
  async downAll(options: DownOptions = {}): Promise<string[]> {
    // Discover nets from docker itself as well as the state dir, so orphaned networks (whose state
    // dir was already deleted) are still torn down instead of piling up and starving Docker.
    const stateNets = (await this.list()).map((summary) => summary.net);
    const dockerNets = await this.engine.forgeNets();
    const nets = [...new Set([...stateNets, ...dockerNets])];
    const failures: string[] = [];
    const failedNets: string[] = [];
    for (const net of nets) {
      try {
        await this.down(net, options);
      } catch (error) {
        failedNets.push(net);
        failures.push(`${net}: ${errorDetails(error).message}`);
      }
    }
    if (failures.length > 0) {
      throw new ForgeError(
        "DOCKER_OPERATION_FAILED",
        `one or more networks had incomplete teardown: ${failures.join("; ")}`,
        {
          resource: failedNets.join(", "),
          action:
            'fix the reported resources, then run "fiber-forge down --all" again',
        },
      );
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

  private queueNodeLifecycle(
    net: string,
    node: string,
    operation: () => Promise<NodeLifecycleReport>,
  ): Promise<NodeLifecycleReport> {
    const key = `${net}/${node}`;
    const prior = this.lifecycleQueue.get(key) ?? Promise.resolve();
    const result = prior.catch(() => undefined).then(operation);
    const settled = result.then(
      () => undefined,
      () => undefined,
    );
    this.lifecycleQueue.set(key, settled);
    return result.finally(() => {
      if (this.lifecycleQueue.get(key) === settled) {
        this.lifecycleQueue.delete(key);
      }
    });
  }

  private lifecycleTimeouts(options: NodeLifecycleOptions): {
    timeoutMs: number;
    reconcileTimeoutMs: number;
  } {
    const timeoutMs = options.timeoutMs ?? 60_000;
    const reconcileTimeoutMs = options.reconcileTimeoutMs ?? 10_000;
    for (const [resource, value] of [
      ["NodeLifecycleOptions.timeoutMs", timeoutMs],
      ["NodeLifecycleOptions.reconcileTimeoutMs", reconcileTimeoutMs],
    ] as const) {
      if (!Number.isFinite(value) || value <= 0) {
        throw new ForgeError(
          "INVALID_TIMEOUT",
          `${resource} must be a positive finite number`,
          {
            resource,
            action: "provide a positive timeout in milliseconds",
          },
        );
      }
    }
    return { timeoutMs, reconcileTimeoutMs };
  }

  private requireNodeContainer(
    net: string,
    node: string,
    container: string,
    status: NodeRuntimeStatus,
  ): void {
    if (status === "absent") {
      throw new ForgeError(
        "NODE_CONTAINER_MISSING",
        `node "${node}" is recorded but container "${container}" is missing`,
        {
          resource: `${net}/${node}`,
          action: `recreate network "${net}" before retrying`,
        },
      );
    }
  }

  private async startNodeNow(
    net: string,
    node: string,
    action: "start" | "restart",
    options: NodeLifecycleOptions,
  ): Promise<NodeLifecycleReport> {
    const { timeoutMs, reconcileTimeoutMs } = this.lifecycleTimeouts(options);
    const state = await this.readState(net);
    const target = this.requireNode(state, node);
    const previousStatus = nodeRuntimeStatus(
      await this.engine.status(target.container),
    );
    this.requireNodeContainer(net, node, target.container, previousStatus);

    if (action === "restart" && previousStatus === "running") {
      await this.engine.stop(target.container);
      const stopped = nodeRuntimeStatus(
        await this.engine.status(target.container),
      );
      if (stopped !== "stopped") {
        throw new ForgeError(
          "NODE_STATE_MISMATCH",
          `node "${node}" did not stop before restart (observed ${stopped})`,
          {
            resource: `${net}/${node}`,
            action: `inspect Docker container "${target.container}" and retry`,
          },
        );
      }
    }

    if (action === "restart" || previousStatus === "stopped") {
      await this.engine.start(target.container);
    }
    const status = nodeRuntimeStatus(
      await this.engine.status(target.container),
    );
    if (status !== "running") {
      throw new ForgeError(
        "NODE_STATE_MISMATCH",
        `node "${node}" did not reach running state (observed ${status})`,
        {
          resource: `${net}/${node}`,
          action: `inspect Docker container "${target.container}" and its logs`,
        },
      );
    }

    const rpc = this.rpcFor(target.rpcHostPort);
    const info = await this.waitLifecycleNodeInfo(
      rpc,
      timeoutMs,
      net,
      node,
      target.container,
    );
    if (info.pubkey !== target.pubkey) {
      throw new ForgeError(
        "NODE_IDENTITY_MISMATCH",
        `node "${node}" restarted with a different public key`,
        {
          resource: `${net}/${node}`,
          action: `stop using network "${net}" and recreate it from a trusted topology`,
        },
      );
    }

    const observed = await this.observeNodeRecovery(
      state,
      target,
      rpc,
      reconcileTimeoutMs,
    );
    return {
      net,
      node,
      action,
      previousStatus,
      status,
      changed: action === "restart" || previousStatus !== status,
      rpcReady: true,
      identityMatches: true,
      channels: observed.channels,
      recovery: observed.ready ? "ready" : "action-required",
      nextAction: observed.ready
        ? null
        : `inspect peers and channels, then retry "fiber-forge node inspect ${net} ${node} --json"`,
    };
  }

  private async waitLifecycleNodeInfo(
    rpc: FnnRpc,
    timeoutMs: number,
    net: string,
    node: string,
    container: string,
  ): Promise<NodeInfo> {
    const deadline = Date.now() + timeoutMs;
    let lastError: unknown;
    for (;;) {
      try {
        const info = await rpc.nodeInfo();
        if (peerIdOf(info)) {
          return info;
        }
      } catch (error) {
        lastError = error;
      }
      if (Date.now() >= deadline) {
        throw new ForgeError(
          "NODE_RPC_UNAVAILABLE",
          `node "${node}" is running but its RPC did not become ready within ${timeoutMs}ms`,
          {
            resource: `${net}/${node}`,
            action: `inspect logs with "fiber-forge logs ${net} ${node}" and retry the start operation`,
            cause: lastError,
          },
        );
      }
      await sleep(Math.min(250, Math.max(1, deadline - Date.now())));
      if (
        nodeRuntimeStatus(await this.engine.status(container)) !== "running"
      ) {
        throw new ForgeError(
          "NODE_STATE_MISMATCH",
          `node "${node}" exited while waiting for RPC readiness`,
          {
            resource: `${net}/${node}`,
            action: `inspect logs with "fiber-forge logs ${net} ${node}"`,
          },
        );
      }
    }
  }

  private async observeNodeRecovery(
    state: NetworkState,
    target: NetworkState["nodes"][number],
    rpc: FnnRpc,
    timeoutMs: number,
  ): Promise<{ channels: NodeChannelObservation[]; ready: boolean }> {
    const peerNames = new Map(
      state.nodes.map((node) => [node.pubkey, node.name]),
    );
    const expectedNames = new Set<string>();
    for (const channel of state.channels) {
      if (channel.from === target.name) expectedNames.add(channel.to);
      if (channel.to === target.name) expectedNames.add(channel.from);
    }
    const expectedPeers = state.nodes.filter((node) =>
      expectedNames.has(node.name),
    );
    const deadline = Date.now() + timeoutMs;
    let channels: NodeChannelObservation[] = [];

    for (;;) {
      try {
        const [liveChannels, livePeers] = await Promise.all([
          rpc.listChannels(),
          rpc.listPeers(),
        ]);
        const connectedPubkeys = new Set(livePeers.map((peer) => peer.pubkey));
        channels = liveChannels.map((channel) => ({
          channelId: channel.channel_id,
          peer: peerNames.get(channel.pubkey ?? "") ?? channel.pubkey ?? "?",
          state: channelStateName(channel) || "Unknown",
          connected: connectedPubkeys.has(channel.pubkey ?? ""),
        }));
        for (const peer of expectedPeers) {
          if (!liveChannels.some((channel) => channel.pubkey === peer.pubkey)) {
            channels.push({
              channelId: null,
              peer: peer.name,
              state: "Missing",
              connected: connectedPubkeys.has(peer.pubkey),
            });
          }
        }
        channels.sort((a, b) =>
          `${a.peer}/${a.channelId ?? ""}`.localeCompare(
            `${b.peer}/${b.channelId ?? ""}`,
          ),
        );
        const ready =
          expectedPeers.every(
            (peer) =>
              connectedPubkeys.has(peer.pubkey) &&
              liveChannels.some(
                (channel) =>
                  channel.pubkey === peer.pubkey && isChannelReady(channel),
              ),
          ) && liveChannels.every(isChannelReady);
        if (ready || Date.now() >= deadline) {
          return { channels, ready };
        }
      } catch {
        if (Date.now() >= deadline) {
          return { channels: [], ready: false };
        }
      }
      await sleep(Math.min(500, Math.max(1, deadline - Date.now())));
    }
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
    this.requireNetworkName(net);
    try {
      return JSON.parse(
        await readFile(join(this.stateDir, net, "layout.json"), "utf8"),
      ) as NetworkState;
    } catch (error) {
      throw new ForgeError("NETWORK_NOT_FOUND", `network "${net}" not found`, {
        resource: net,
        action: 'run "fiber-forge ls" to list recorded networks',
        cause: error,
      });
    }
  }

  private requireNode(
    state: NetworkState,
    name: string,
  ): NetworkState["nodes"][number] {
    const node = state.nodes.find((n) => n.name === name);
    if (!node) {
      throw new ForgeError(
        "NODE_NOT_FOUND",
        `network ${state.net} has no node "${name}"`,
        {
          resource: `${state.net}/${name}`,
          action: `run "fiber-forge status ${state.net}" to list its nodes`,
        },
      );
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
    return this.makeRpc(rpcHostPort);
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
    guard?: ProvisionGuard,
    resource = "Fiber RPC readiness",
  ): Promise<NodeInfo> {
    const boundedTimeout = guard?.remaining(timeoutMs, resource) ?? timeoutMs;
    const deadline = Date.now() + boundedTimeout;
    for (;;) {
      guard?.check(resource);
      try {
        const info = await rpc.nodeInfo();
        guard?.check(resource);
        if (peerIdOf(info)) {
          return info;
        }
      } catch {
        // node not ready yet
      }
      guard?.check(resource);
      if (Date.now() > deadline) {
        throw new Error("node did not announce its RPC + peer address in time");
      }
      await waitWithGuard(1000, guard, resource);
    }
  }

  /** Wait until `pubkey` appears in the node's peer list (the connection handshake finished). */
  private async waitPeerConnected(
    rpc: FnnRpc,
    pubkey: string,
    timeoutMs = 30_000,
    guard?: ProvisionGuard,
    resource = `peer ${pubkey}`,
  ): Promise<void> {
    const boundedTimeout = guard?.remaining(timeoutMs, resource) ?? timeoutMs;
    const deadline = Date.now() + boundedTimeout;
    for (;;) {
      guard?.check(resource);
      const peers = await rpc.listPeers();
      guard?.check(resource);
      if (peers.some((peer) => peer.pubkey === pubkey)) {
        return;
      }
      if (Date.now() > deadline) {
        guard?.check(resource);
        throw new Error(`peer ${pubkey} did not connect in time`);
      }
      await waitWithGuard(1000, guard, resource);
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
    guard?: ProvisionGuard,
    resource = "channel open",
  ): Promise<void> {
    for (let attempt = 0; ; attempt += 1) {
      guard?.check(resource);
      try {
        await rpc.openChannel(params);
        guard?.check(resource);
        return;
      } catch (error) {
        guard?.check(resource);
        if (attempt >= attempts) {
          throw error;
        }
        await waitWithGuard(2000, guard, resource);
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
    guard?: ProvisionGuard,
  ): Promise<void> {
    const resource = `channel ${label}`;
    const boundedTimeout = guard?.remaining(timeoutMs, resource) ?? timeoutMs;
    const deadline = Date.now() + boundedTimeout;
    for (;;) {
      guard?.check(resource);
      // Mine a few blocks each pass so the funding tx proposes+commits quickly (CKB is two-step).
      await chain.generateBlocks(3);
      guard?.check(resource);
      const channels = await rpc.listChannels(peerPubkey);
      guard?.check(resource);
      // Count ready channels, not "any ready" — else a new channel to an already-connected peer
      // is reported ready the instant its sibling is, and the new one is left half-open.
      if (channels.filter(isChannelReady).length >= minReady) {
        log(`channel ${label} ready`);
        return;
      }
      if (Date.now() > deadline) {
        guard?.check(resource);
        throw new Error(`channel ${label} did not reach CHANNEL_READY in time`);
      }
      await waitWithGuard(1000, guard, resource);
    }
  }
}
