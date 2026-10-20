/**
 * The orchestrator: `up` / `down` / `status` over a validated topology. `up` creates the docker
 * network, boots the CKB dev chain, then each fnn node (generating + encrypting a CKB key,
 * writing its config), waits for RPC, funds every node from the deployer, connects peers, opens
 * the declared channels, and drives blocks until each reaches CHANNEL_READY. Every step here is
 * proven live in `docs/dev-notes.md`.
 */

import {
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  inspectBundleFile,
  replayBundleFile,
  writeExportBundle,
  type BundleDiagnostics,
  type BundleInspection,
  type ExportBundleOptions,
  type ExportBundleResult,
  type ReplayBundleOptions,
  type ReplayBundleResult,
} from "./bundle.js";
import {
  type CkbTransactionStatus,
  DevChain,
  SIMPLE_UDT_CODE_HASH,
} from "./ckb.js";
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
import {
  type FaultKind,
  type FaultObservation,
  type FaultReport,
  type PersistedFault,
  type PersistedFaultFile,
  emptyFaultFile,
  faultId,
  faultNeedsTarget,
  isFaultKind,
  parseFaultFile,
} from "./faults.js";
import { encryptKey, generatePrivateKey } from "./keys.js";
import {
  LightningBackend,
  type LightningBackendPlan,
  type LightningBackendStartOptions,
  type LightningBackendStatus,
  lightningVolumeNames,
  planLightningBackend,
} from "./lightning.js";
import { runtimeImages } from "./package-metadata.js";
import { findFreePort, findFreePortBlock, isPortFree } from "./ports.js";
import {
  type Channel,
  FnnRpc,
  HttpTransport,
  type NodeInfo,
  type OpenChannelParams,
  channelStateFlags,
  channelStateName,
  ckbToShannonHex,
  dialAddress,
  isChannelReady,
  isPaymentSettled,
  peerIdOf,
  shannonHexToCkb,
} from "./rpc.js";
import {
  parseScenario,
  runScenario as executeScenario,
  type Scenario,
  type ScenarioReport,
  type ScenarioRunOptions,
} from "./scenario.js";
import {
  isValidNetworkName,
  parseTopology,
  validateTopology,
  type Topology,
} from "./topology.js";

export const FORGE_LABEL = "fiber-forge";
const FAULT_NETWORK_LABEL = "fiber-forge.fault";
export const DEFAULT_FNN_IMAGE = runtimeImages.fiber;
export const DEFAULT_CKB_IMAGE = runtimeImages.ckb;

const sleep = (ms: number) =>
  new Promise<void>((resolvePromise) => setTimeout(resolvePromise, ms));
const hex = (bytes: Uint8Array) => "0x" + Buffer.from(bytes).toString("hex");
export const DEFAULT_PROVISION_TIMEOUT_MS = 10 * 60_000;
export const DEFAULT_FORCE_CLOSE_TIMEOUT_MS = 7 * 60_000;

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
  /** Require an entirely absent target instead of replacing stale managed state. Used by replay. */
  requireClean?: boolean;
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
  /** Current layouts persist the normalized recipe needed for safe export. */
  schemaVersion?: 1;
  net: string;
  network: string;
  ckbHostPort: number;
  /** Present in layouts created by current releases; older layouts derive these names safely. */
  ckbContainer?: string;
  ckbIp?: string;
  nodes: {
    name: string;
    container: string;
    ip: string;
    rpcHostPort: number;
    pubkey: string;
    ckbAddress: string;
  }[];
  channels: { from: string; to: string; capacityCkb: number }[];
  /** Absent only in legacy layouts, which require an explicit topology during export. */
  topology?: Topology;
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
    /** Exact CKB wallet balance in shannons for machine comparisons. */
    onchainCkbShannon?: string;
    udtBalance: number;
    /** Exact dev-UDT wallet balance in 8-decimal base units. */
    udtBalanceBaseUnits?: string;
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

/** Result of explicit on-demand block generation. */
export interface MineReport {
  net: string;
  count: number;
  fromBlock: number;
  toBlock: number;
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

/** Observable phases of a cooperative or force-close lifecycle. */
export type ChannelSettlementPhase =
  | "open"
  | "close-requested"
  | "settlement-pending"
  | "settled"
  | "cooperatively-closed"
  | "closed-other";

/** Options for the destructive, local-dev force-close workflow. */
export interface ForceCloseOptions {
  /** Must exactly match `channelId`; prevents an accidental close from a copied command. */
  confirmChannelId: string;
  /** Maximum observation time. Defaults to seven minutes. */
  timeoutMs?: number;
  /** Blocks generated between observations. Defaults to 3; set to 0 to disable automatic mining. */
  mineBlocksPerPoll?: number;
  /** Delay between observations. Defaults to 1 second. */
  pollIntervalMs?: number;
}

/** Fiber and CKB evidence for one channel's close/settlement state. */
export interface ChannelSettlementReport {
  net: string;
  node: string;
  channelId: string;
  operation: "inspect" | "force-close";
  closeMode: "none" | "cooperative" | "force" | "other";
  /** `null` for inspection, otherwise whether this call sent `force: true`. */
  rpcAccepted: boolean | null;
  phase: ChannelSettlementPhase;
  settled: boolean;
  timedOut: boolean;
  channelState: string;
  channelFlags: string[];
  commitmentTransactionHash: string | null;
  closingTransaction: ({ hash: string } & CkbTransactionStatus) | null;
  finalState: { state: string; flags: string[] } | null;
  elapsedMs: number;
  nextAction: string | null;
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
    private readonly makeChain: (ckbHostPort: number) => DevChain = (
      ckbHostPort,
    ) => new DevChain(`http://127.0.0.1:${ckbHostPort}`),
  ) {}

  /** Serializes channel opens per network: two fundings must not race for the same wallet cell. */
  private readonly openQueue = new Map<string, Promise<void>>();

  /** Serializes lifecycle mutations for one node while allowing unrelated nodes to proceed. */
  private readonly lifecycleQueue = new Map<string, Promise<void>>();

  /** Serializes persisted fault-state transitions per network. */
  private readonly faultQueue = new Map<string, Promise<void>>();

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
    const faultNetworks = await this.faultNetworksForCleanup(net);
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
    for (const network of faultNetworks) {
      await this.removeFaultNetwork(net, network);
    }
    if ((await this.engine.forgeNets()).includes(net)) {
      await this.engine.removeNetwork(`forge-${net}`);
    }
    await this.engine.removeVolume(`forge-${net}-ckb-data`);
    const backendVolumes = lightningVolumeNames(net);
    for (const volume of Object.values(backendVolumes)) {
      await this.engine.removeVolume(volume);
    }
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
    if (options.requireClean) {
      await this.assertReplayTopologyClean(topology);
      guard.check("clean replay target preflight");
    } else {
      await this.prepareNetwork(topology.name);
      guard.check("stale resource cleanup");
    }
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
      await this.engine.ensureNetwork(layout.network, layout.subnet, {
        labels: { [FORGE_LABEL]: layout.net },
      });
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
        schemaVersion: 1,
        net: layout.net,
        network: layout.network,
        ckbHostPort: layout.ckbHostPort,
        ckbContainer: layout.ckbContainer,
        ckbIp: layout.ckbIp,
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
        topology: {
          name: topology.name,
          nodes: topology.nodes.map((node) => ({ ...node })),
          channels: topology.channels.map((channel) => ({ ...channel })),
          funding: { ...topology.funding },
        },
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
      let onchainCkbShannon: bigint | undefined;
      let udtBalance = 0;
      let udtBalanceBaseUnits: bigint | undefined;
      try {
        onchainCkbShannon = await chain.balanceShannonsOf(node.ckbAddress);
        udtBalanceBaseUnits = await chain.udtBalanceOf(node.ckbAddress);
        onchainCkb = Number(onchainCkbShannon / 100_000_000n);
        udtBalance = Number(udtBalanceBaseUnits) / 1e8;
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
        ...(onchainCkbShannon === undefined
          ? {}
          : { onchainCkbShannon: onchainCkbShannon.toString() }),
        udtBalance,
        ...(udtBalanceBaseUnits === undefined
          ? {}
          : { udtBalanceBaseUnits: udtBalanceBaseUnits.toString() }),
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

  /** Apply a named, persisted fault to one managed network. */
  async applyFault(
    net: string,
    kind: FaultKind,
    target?: string,
  ): Promise<FaultReport> {
    return this.queueFault(net, async () => {
      const state = await this.readState(net);
      this.validateFaultInput(state, kind, target);
      const file = await this.readFaultFile(net);
      const id = faultId(kind, target);
      const existing = file.faults.find((fault) => fault.id === id);
      await this.assertFaultSupported(kind);

      if (kind === "peer-partition" && this.hasFault(file, "ckb-unavailable")) {
        throw new ForgeError(
          "FAULT_CONFLICT",
          "peer partition requires CKB connectivity, but CKB is unavailable",
          {
            resource: `${net}/${id}`,
            action: `reset "ckb-unavailable" on network "${net}" first`,
          },
        );
      }

      if (existing) {
        const observed = await this.observeFault(state, file, existing, true);
        if (observed.state === "active") {
          return this.faultReport(
            state.net,
            existing,
            "active",
            observed,
            false,
          );
        }
      }

      const record =
        existing ?? (await this.prepareFaultRecord(state, kind, target));
      await this.preflightFaultApply(state, file, record);
      if (!existing) {
        file.faults.push(record);
        await this.writeFaultFile(net, file);
      }
      await this.applyFaultRecord(state, file, record);
      const observed = await this.observeFault(state, file, record, true);
      if (observed.state !== "active") {
        throw new ForgeError(
          "FAULT_STATE_MISMATCH",
          `fault "${record.id}" was requested but observed ${observed.state}`,
          {
            resource: `${net}/${record.id}`,
            action: `inspect with "fiber-forge fault status ${net} --json", then reset or retry`,
          },
        );
      }
      return this.faultReport(state.net, record, "active", observed, true);
    });
  }

  /** Inspect every persisted fault and its actual container/network condition. */
  async faultStatus(net: string): Promise<FaultReport[]> {
    return this.queueFault(net, async () => {
      const state = await this.readState(net);
      const file = await this.readFaultFile(net);
      const reports = await Promise.all(
        file.faults.map(async (fault) =>
          this.faultReport(
            net,
            fault,
            "active",
            await this.observeFault(state, file, fault, true),
            false,
          ),
        ),
      );
      return reports.sort((a, b) => a.id.localeCompare(b.id));
    });
  }

  /** Reset one named fault and wait for the relevant process or dependency readiness. */
  async resetFault(
    net: string,
    kind: FaultKind,
    target?: string,
    options: NodeLifecycleOptions = {},
  ): Promise<FaultReport> {
    return this.queueFault(net, async () => {
      const state = await this.readState(net);
      this.validateFaultInput(state, kind, target);
      const file = await this.readFaultFile(net);
      const id = faultId(kind, target);
      const record = file.faults.find((fault) => fault.id === id);
      if (!record) {
        return {
          net,
          id,
          kind,
          target: target ?? null,
          requested: "reset",
          observed: {
            state: "inactive",
            summary: "no matching fault is recorded",
          },
          changed: false,
          appliedAt: null,
          survivesProcessRestart: true,
          recovery: "ready",
          nextAction: null,
        };
      }

      await this.assertFaultSupported(kind);
      const recovery = await this.resetFaultRecord(
        state,
        file,
        record,
        options,
      );
      file.faults = file.faults.filter((fault) => fault.id !== record.id);
      await this.writeFaultFile(net, file);
      const observed = await this.observeFault(state, file, record, false);
      return {
        ...this.faultReport(net, record, "reset", observed, true),
        ...recovery,
      };
    });
  }

  /** Reset every active fault in dependency-safe order. */
  async resetAllFaults(
    net: string,
    options: NodeLifecycleOptions = {},
  ): Promise<FaultReport[]> {
    const active = await this.faultStatus(net);
    const order: Record<FaultKind, number> = {
      "ckb-unavailable": 0,
      "mining-pause": 1,
      "peer-partition": 2,
      "node-kill": 3,
    };
    const reports: FaultReport[] = [];
    for (const fault of active.sort(
      (a, b) => order[a.kind] - order[b.kind] || a.id.localeCompare(b.id),
    )) {
      reports.push(
        await this.resetFault(
          net,
          fault.kind,
          fault.target ?? undefined,
          options,
        ),
      );
    }
    return reports;
  }

  /** Generate blocks through the managed control plane, honoring a mining-pause fault. */
  async mineBlocks(net: string, count = 1): Promise<MineReport> {
    if (!Number.isInteger(count) || count <= 0 || count > 1_000) {
      throw new ForgeError(
        "FAULT_PRECONDITION_FAILED",
        "block count must be an integer between 1 and 1000",
        {
          resource: String(count),
          action: "choose a block count between 1 and 1000",
        },
      );
    }
    const state = await this.readState(net);
    await this.assertMiningAvailable(net);
    const chain = this.chainFor(state.ckbHostPort);
    const fromBlock = await chain.tipBlock();
    await chain.generateBlocks(count);
    return {
      net,
      count,
      fromBlock,
      toBlock: await chain.tipBlock(),
    };
  }

  /** Start the optional, private Bitcoin/LND backend on an existing managed Fiber network. */
  async startLightningBackend(
    net: string,
    options: LightningBackendStartOptions = {},
  ): Promise<LightningBackendStatus> {
    const state = await this.readState(net);
    const plan = this.lightningPlan(state);
    const backend = new LightningBackend(this.engine);
    const status = await backend.start(plan, options);
    try {
      await writeFile(
        join(this.stateDir, net, "lightning.json"),
        JSON.stringify(plan, null, 2),
      );
      return status;
    } catch (error) {
      const persistenceFailure = new ForgeError(
        "PROVISION_FAILED",
        `could not persist the Lightning backend plan for "${net}"`,
        {
          resource: net,
          action: "fix the network state directory permissions and retry",
          cause: error,
        },
      );
      try {
        await backend.down(plan);
      } catch (rollbackError) {
        throw new ForgeError(
          "ROLLBACK_FAILED",
          `${persistenceFailure.message}; Lightning backend rollback was also incomplete: ${errorDetails(rollbackError).message}`,
          {
            resource: net,
            action: `fix Docker and run "fiber-forge down ${net}"`,
            cause: new AggregateError([persistenceFailure, rollbackError]),
          },
        );
      }
      throw persistenceFailure;
    }
  }

  /** Return a sanitized, JSON-safe view of the optional Bitcoin/LND backend. */
  async lightningBackendStatus(net: string): Promise<LightningBackendStatus> {
    const state = await this.readState(net);
    return new LightningBackend(this.engine).status(this.lightningPlan(state));
  }

  /** Remove every optional Bitcoin/LND container and data volume for a managed network. */
  async stopLightningBackend(net: string): Promise<LightningBackendStatus> {
    const state = await this.readState(net);
    const backend = new LightningBackend(this.engine);
    const plan = this.lightningPlan(state);
    await backend.down(plan);
    await rm(join(this.stateDir, net, "lightning.json"), { force: true });
    return backend.status(plan);
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
    const faultNetworks = await this.faultNetworksForCleanup(net);
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
    for (const network of [`forge-${net}`, ...faultNetworks]) {
      for (const name of containers) {
        try {
          await this.engine.disconnectNetwork(network, name);
        } catch (error) {
          failures.push(
            `disconnect ${name} from ${network}: ${errorDetails(error).message}`,
          );
        }
      }
    }
    try {
      await this.engine.removeNetwork(`forge-${net}`);
    } catch (error) {
      failures.push(
        `remove network forge-${net}: ${errorDetails(error).message}`,
      );
    }
    for (const network of faultNetworks) {
      try {
        await this.removeFaultNetwork(net, network);
      } catch (error) {
        failures.push(
          `remove fault network ${network}: ${errorDetails(error).message}`,
        );
      }
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
    for (const volume of Object.values(lightningVolumeNames(net))) {
      try {
        await this.engine.removeVolume(volume);
      } catch (error) {
        failures.push(
          `remove volume ${volume}: ${errorDetails(error).message}`,
        );
      }
    }
    if (failures.length === 0) {
      try {
        await rm(join(this.stateDir, net, "faults.json"), { force: true });
        await rm(join(this.stateDir, net, "lightning.json"), { force: true });
      } catch (error) {
        failures.push(
          `remove fault state ${net}: ${errorDetails(error).message}`,
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
    try {
      const invoice = await this.createInvoice(
        net,
        to,
        amount,
        description,
        udt,
      );
      const status = await this.payInvoiceInternal(net, from, invoice);
      return {
        from,
        to,
        amountCkb: amount,
        paymentHash: status.paymentHash,
        status: status.status,
      };
    } catch (error) {
      if (error instanceof ForgeError) throw error;
      throw new ForgeError(
        "PAYMENT_FAILED",
        `payment from "${from}" to "${to}" failed`,
        {
          cause: error,
          resource: `${net}/${from}/${to}`,
          action: "inspect node connectivity and channel balances, then retry",
        },
      );
    }
  }

  /** Mint `amountUdt` whole units of the dev UDT into a node's wallet; returns the tx hash. */
  async issueUdt(
    net: string,
    node: string,
    amountUdt: number,
  ): Promise<string> {
    const state = await this.readState(net);
    await this.assertMiningAvailable(net);
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
    try {
      const result = await this.payInvoiceInternal(net, from, invoice);
      return {
        from,
        to: "",
        amountCkb: 0,
        paymentHash: result.paymentHash,
        status: result.status,
      };
    } catch (error) {
      if (error instanceof ForgeError) throw error;
      throw new ForgeError("PAYMENT_FAILED", `payment from "${from}" failed`, {
        cause: error,
        resource: `${net}/${from}`,
        action: "inspect node connectivity and channel balances, then retry",
      });
    }
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
    await this.assertMiningAvailable(net);
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

  /**
   * Force-close one local-dev channel and observe it until Fiber and CKB both report settlement.
   * A timeout is returned as evidence rather than thrown, so transaction identifiers are retained.
   */
  async forceCloseChannel(
    net: string,
    node: string,
    channelId: string,
    options: ForceCloseOptions,
  ): Promise<ChannelSettlementReport> {
    if (options.confirmChannelId !== channelId) {
      throw new ForgeError(
        "FORCE_CLOSE_CONFIRMATION_REQUIRED",
        "force-close confirmation must exactly match the full channel id",
        {
          resource: `${net}/${node}/${channelId}`,
          action: `retry with --confirm ${channelId}`,
        },
      );
    }
    const timeoutMs = options.timeoutMs ?? DEFAULT_FORCE_CLOSE_TIMEOUT_MS;
    const pollIntervalMs = options.pollIntervalMs ?? 1_000;
    const mineBlocksPerPoll = options.mineBlocksPerPoll ?? 3;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new ForgeError(
        "INVALID_TIMEOUT",
        "force-close timeoutMs must be a positive finite number",
        { resource: `${net}/${node}/${channelId}` },
      );
    }
    if (!Number.isFinite(pollIntervalMs) || pollIntervalMs <= 0) {
      throw new ForgeError(
        "INVALID_TIMEOUT",
        "force-close pollIntervalMs must be a positive finite number",
        { resource: `${net}/${node}/${channelId}` },
      );
    }
    if (
      !Number.isInteger(mineBlocksPerPoll) ||
      mineBlocksPerPoll < 0 ||
      mineBlocksPerPoll > 100
    ) {
      throw new ForgeError(
        "FAULT_PRECONDITION_FAILED",
        "force-close mineBlocksPerPoll must be an integer between 0 and 100",
        { resource: `${net}/${node}/${channelId}` },
      );
    }

    const state = await this.readState(net);
    const target = this.requireNode(state, node);
    const rpc = this.rpcFor(target.rpcHostPort);
    const initial = await this.requireChannel(rpc, net, node, channelId);
    const initialState = channelStateName(initial);
    const initialFlags = channelStateFlags(initial);
    const forceAlreadyStarted =
      (initialState === "ShuttingDown" &&
        initialFlags.includes("WAITING_COMMITMENT_CONFIRMATION")) ||
      (initialState === "Closed" &&
        initialFlags.some((flag) => flag.startsWith("UNCOOPERATIVE_")));
    if (initialState === "Closed" && !forceAlreadyStarted) {
      throw new ForgeError(
        "CHANNEL_STATE_MISMATCH",
        `channel ${channelId} is already closed without a force-close state`,
        {
          resource: `${net}/${node}/${channelId}`,
          action: `inspect it with "fiber-forge channel settlement ${net} ${node} ${channelId}"`,
        },
      );
    }
    if (initialState !== "ChannelReady" && !forceAlreadyStarted) {
      throw new ForgeError(
        "CHANNEL_STATE_MISMATCH",
        `channel ${channelId} cannot be force-closed from ${initialState || "Unknown"}`,
        {
          resource: `${net}/${node}/${channelId}`,
          action:
            "wait for ChannelReady or inspect the existing close operation",
        },
      );
    }

    const chain = this.makeChain(state.ckbHostPort);
    if (mineBlocksPerPoll > 0) {
      await this.assertMiningAvailable(net);
    }
    let rpcAccepted = false;
    if (!forceAlreadyStarted) {
      await rpc.shutdownChannel(channelId, true);
      rpcAccepted = true;
    }

    const started = Date.now();
    const deadline = started + timeoutMs;
    let report = await this.readSettlementReport(
      net,
      node,
      channelId,
      "force-close",
      rpcAccepted,
      started,
      rpc,
      chain,
    );
    while (!report.settled && Date.now() < deadline) {
      if (mineBlocksPerPoll > 0) {
        await chain.generateBlocks(mineBlocksPerPoll);
      }
      await sleep(Math.min(pollIntervalMs, Math.max(1, deadline - Date.now())));
      report = await this.readSettlementReport(
        net,
        node,
        channelId,
        "force-close",
        rpcAccepted,
        started,
        rpc,
        chain,
      );
    }
    return report.settled
      ? report
      : {
          ...report,
          timedOut: true,
          nextAction: `re-run "fiber-forge channel settlement ${net} ${node} ${channelId} --json"; the force-close continues in Fiber`,
        };
  }

  /** Reconstruct close/settlement state only from the persisted node and live Fiber/CKB data. */
  async inspectChannelSettlement(
    net: string,
    node: string,
    channelId: string,
  ): Promise<ChannelSettlementReport> {
    const state = await this.readState(net);
    const target = this.requireNode(state, node);
    return this.readSettlementReport(
      net,
      node,
      channelId,
      "inspect",
      null,
      Date.now(),
      this.rpcFor(target.rpcHostPort),
      this.makeChain(state.ckbHostPort),
    );
  }

  /** Top up a running node's on-chain wallet from the deployer; returns the funding tx hash. */
  async fund(net: string, node: string, amountCkb: number): Promise<string> {
    const state = await this.readState(net);
    await this.assertMiningAvailable(net);
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

  private async requireChannel(
    rpc: FnnRpc,
    net: string,
    node: string,
    channelId: string,
  ): Promise<Channel> {
    const channel = (await rpc.listChannels(undefined, true)).find(
      (candidate) => candidate.channel_id === channelId,
    );
    if (!channel) {
      throw new ForgeError(
        "CHANNEL_NOT_FOUND",
        `channel ${channelId} was not found on node "${node}"`,
        {
          resource: `${net}/${node}/${channelId}`,
          action: `copy the full id from "fiber-forge channel ls ${net} ${node} --json"`,
        },
      );
    }
    return channel;
  }

  private async readSettlementReport(
    net: string,
    node: string,
    channelId: string,
    operation: "inspect" | "force-close",
    rpcAccepted: boolean | null,
    started: number,
    rpc: FnnRpc,
    chain: DevChain,
  ): Promise<ChannelSettlementReport> {
    const channel = await this.requireChannel(rpc, net, node, channelId);
    const channelState = channelStateName(channel) || "Unknown";
    const channelFlags = channelStateFlags(channel);
    const commitmentTransactionHash =
      channel.latest_commitment_transaction_hash ?? null;
    const closingHash = channel.shutdown_transaction_hash ?? null;
    let closingTransaction: ChannelSettlementReport["closingTransaction"] =
      null;
    if (closingHash) {
      try {
        closingTransaction = {
          hash: closingHash,
          ...(await chain.transactionStatus(closingHash)),
        };
      } catch (error) {
        closingTransaction = {
          hash: closingHash,
          status: "unavailable",
          blockHash: null,
          blockNumber: null,
          reason: error instanceof Error ? error.message : String(error),
        };
      }
    }

    const cooperative = channelFlags.includes("COOPERATIVE");
    const force = channelFlags.some((flag) =>
      flag.startsWith("UNCOOPERATIVE_"),
    );
    const waiting = channelFlags.includes("WAITING_ONCHAIN_SETTLEMENT");
    const transactionCommitted = closingTransaction?.status === "committed";
    let phase: ChannelSettlementPhase = "open";
    if (channelState === "ShuttingDown") {
      phase = "close-requested";
    } else if (channelState === "Closed" && cooperative) {
      phase = "cooperatively-closed";
    } else if (
      channelState === "Closed" &&
      force &&
      (waiting || !transactionCommitted)
    ) {
      phase = "settlement-pending";
    } else if (
      channelState === "Closed" &&
      force &&
      !waiting &&
      transactionCommitted
    ) {
      phase = "settled";
    } else if (channelState === "Closed") {
      phase = force ? "close-requested" : "closed-other";
    }
    const settled = phase === "settled";
    const finalState = [
      "settled",
      "cooperatively-closed",
      "closed-other",
    ].includes(phase)
      ? { state: channelState, flags: channelFlags }
      : null;
    const closeMode = cooperative
      ? "cooperative"
      : force
        ? "force"
        : channelState === "Closed"
          ? "other"
          : "none";
    const nextAction = settled
      ? null
      : phase === "open"
        ? "the channel is still open"
        : phase === "cooperatively-closed"
          ? "the channel closed cooperatively; no force-close settlement is pending"
          : `re-run "fiber-forge channel settlement ${net} ${node} ${channelId} --json"`;
    return {
      net,
      node,
      channelId,
      operation,
      closeMode,
      rpcAccepted,
      phase,
      settled,
      timedOut: false,
      channelState,
      channelFlags,
      commitmentTransactionHash,
      closingTransaction,
      finalState,
      elapsedMs: Date.now() - started,
      nextAction,
    };
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

  /** Run a validated scenario through the supported SDK surface. */
  async runScenario(
    net: string,
    scenario: Scenario | string,
    options: ScenarioRunOptions = {},
  ): Promise<ScenarioReport> {
    const parsed =
      typeof scenario === "string" ? parseScenario(scenario) : scenario;
    return executeScenario(this, net, parsed, options.onStep, options.signal);
  }

  /** Export a canonical recipe and optional bounded diagnostics without copying node state. */
  async exportBundle(
    net: string,
    options: ExportBundleOptions,
  ): Promise<ExportBundleResult> {
    const state = await this.readState(net);
    const topology = this.topologyForExport(state, options.topology);
    let diagnostics: BundleDiagnostics | undefined;
    if (options.diagnostics) {
      const logs: Record<string, string> = {
        ckb: await this.logs(net, "ckb", 2_000),
      };
      for (const node of state.nodes) {
        logs[`node-${node.name}`] = await this.engine.logs(
          node.container,
          2_000,
        );
      }
      const [network, channels, faults] = await Promise.all([
        this.inspect(net),
        this.channels(net),
        this.faultStatus(net),
      ]);
      diagnostics = {
        network,
        channels,
        faults,
        logs,
        privatePaths: [this.stateDir],
      };
    }
    return writeExportBundle({
      topology,
      scenario: options.scenario,
      report: options.report,
      output: options.output,
      sourceHost: { docker: await this.engine.version() },
      ...(diagnostics ? { diagnostics } : {}),
    });
  }

  /** Inspect and verify an untrusted bundle without contacting Docker. */
  async inspectBundle(path: string): Promise<BundleInspection> {
    return inspectBundleFile(path);
  }

  /** Replay a bundle on a fresh network and purge that network before returning. */
  async replayBundle(
    path: string,
    options: ReplayBundleOptions,
  ): Promise<ReplayBundleResult> {
    return replayBundleFile(this, path, options);
  }

  /** Replay must never inherit, replace, or clean resources that existed before it started. */
  async assertReplayTargetClean(net: string): Promise<void> {
    this.requireNetworkName(net);
    let stateExists = false;
    try {
      await lstat(join(this.stateDir, net));
      stateExists = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const [containers, networkExists, volumeExists] = await Promise.all([
      this.engine.listByLabel(FORGE_LABEL, net),
      this.engine.networkExists(`forge-${net}`),
      this.engine.volumeExists(`forge-${net}-ckb-data`),
    ]);
    const resources = [
      ...(stateExists ? [`state ${join(this.stateDir, net)}`] : []),
      ...containers.map((container) => `container ${container}`),
      ...(networkExists ? [`network forge-${net}`] : []),
      ...(volumeExists ? [`volume forge-${net}-ckb-data`] : []),
    ];
    if (resources.length > 0) {
      throw new ForgeError(
        "NETWORK_EXISTS",
        `replay target "${net}" is not clean: ${resources.join(", ")}`,
        {
          resource: net,
          action:
            "choose a fresh replay network name; existing resources are never replaced",
        },
      );
    }
  }

  private async assertReplayTopologyClean(topology: Topology): Promise<void> {
    await this.assertReplayTargetClean(topology.name);
    const names = [
      `forge-${topology.name}-ckb`,
      ...topology.nodes.map(
        (_node, index) => `forge-${topology.name}-node-${index + 1}`,
      ),
    ];
    const faultNetworks = topology.nodes.map(
      (_node, index) => `ffault-${topology.name}-${index + 1}`,
    );
    const [occupied, existingFaultNetworks] = await Promise.all([
      Promise.all(
        names.map(async (name) => ({
          name,
          status: await this.engine.status(name),
        })),
      ).then((entries) => entries.filter((entry) => entry.status !== "absent")),
      Promise.all(
        faultNetworks.map(async (name) => ({
          name,
          exists: await this.engine.networkExists(name),
        })),
      ).then((entries) => entries.filter((entry) => entry.exists)),
    ]);
    if (occupied.length > 0 || existingFaultNetworks.length > 0) {
      const conflicts = [
        ...occupied.map((entry) => `container ${entry.name} (${entry.status})`),
        ...existingFaultNetworks.map((entry) => `network ${entry.name}`),
      ];
      throw new ForgeError(
        "NETWORK_EXISTS",
        `replay target "${topology.name}" has conflicting resources: ${conflicts.join(", ")}`,
        {
          resource: topology.name,
          action:
            "choose a fresh replay network name; external containers are never replaced",
        },
      );
    }
  }

  private topologyForExport(
    state: NetworkState,
    fallback?: Topology | string,
  ): Topology {
    const normalize = (value: Topology): Topology =>
      validateTopology({
        name: value.name,
        nodes: value.nodes.map((node) => ({ name: node.name })),
        channels: value.channels.map((channel) => ({
          from: channel.from,
          to: channel.to,
          capacity_ckb: channel.capacityCkb,
        })),
        funding: { per_node_ckb: value.funding.perNodeCkb },
      });
    const topology = state.topology
      ? normalize(state.topology)
      : fallback
        ? typeof fallback === "string"
          ? parseTopology(fallback)
          : normalize(fallback)
        : undefined;
    if (!topology) {
      throw new ForgeError(
        "BUNDLE_INVALID",
        `legacy network "${state.net}" does not record its original funding topology`,
        {
          resource: state.net,
          action: "provide the original topology with --topology and retry",
        },
      );
    }
    const expectedNodes = state.nodes.map((node) => node.name);
    const actualNodes = topology.nodes.map((node) => node.name);
    const expectedChannels = state.channels.map(
      (channel) =>
        `${channel.from}\0${channel.to}\0${String(channel.capacityCkb)}`,
    );
    const actualChannels = topology.channels.map(
      (channel) =>
        `${channel.from}\0${channel.to}\0${String(channel.capacityCkb)}`,
    );
    if (
      topology.name !== state.net ||
      expectedNodes.join("\0") !== actualNodes.join("\0") ||
      expectedChannels.join("\n") !== actualChannels.join("\n")
    ) {
      throw new ForgeError(
        "BUNDLE_INVALID",
        `topology does not match the recorded nodes and channels for "${state.net}"`,
        {
          resource: state.net,
          action: "use the exact topology that created this network",
        },
      );
    }
    return topology;
  }

  private queueFault<T>(net: string, operation: () => Promise<T>): Promise<T> {
    const prior = this.faultQueue.get(net) ?? Promise.resolve();
    const result = prior.catch(() => undefined).then(operation);
    const settled = result.then(
      () => undefined,
      () => undefined,
    );
    this.faultQueue.set(net, settled);
    return result.finally(() => {
      if (this.faultQueue.get(net) === settled) {
        this.faultQueue.delete(net);
      }
    });
  }

  private validateFaultInput(
    state: NetworkState,
    kind: FaultKind,
    target?: string,
  ): void {
    if (!isFaultKind(String(kind))) {
      throw new ForgeError(
        "FAULT_UNSUPPORTED",
        `fault kind "${String(kind)}" is not supported`,
        {
          resource: String(kind),
          action:
            "use node-kill, peer-partition, ckb-unavailable, or mining-pause",
        },
      );
    }
    if (faultNeedsTarget(kind) && !target) {
      throw new ForgeError(
        "FAULT_PRECONDITION_FAILED",
        `fault "${kind}" requires a node target`,
        {
          resource: `${state.net}/${kind}`,
          action: `provide a node listed by "fiber-forge status ${state.net}"`,
        },
      );
    }
    if (!faultNeedsTarget(kind) && target) {
      throw new ForgeError(
        "FAULT_PRECONDITION_FAILED",
        `fault "${kind}" does not accept a node target`,
        {
          resource: `${state.net}/${kind}/${target}`,
          action: `omit the node target for "${kind}"`,
        },
      );
    }
    if (target) {
      this.requireNode(state, target);
    }
  }

  private async faultNetworksForCleanup(net: string): Promise<string[]> {
    const networks = new Set<string>();
    try {
      const state = JSON.parse(
        await readFile(join(this.stateDir, net, "layout.json"), "utf8"),
      ) as NetworkState;
      state.nodes.forEach((_node, index) =>
        networks.add(`ffault-${net}-${index + 1}`),
      );
    } catch {
      // Teardown still removes known runtime resources when saved state is unavailable.
    }
    try {
      const file = parseFaultFile(
        JSON.parse(
          await readFile(join(this.stateDir, net, "faults.json"), "utf8"),
        ),
      );
      for (const fault of file.faults) {
        if (fault.isolation) networks.add(fault.isolation.network);
      }
    } catch {
      // Deterministic names derived above cover valid managed partition networks.
    }
    return [...networks];
  }

  private async removeFaultNetwork(
    net: string,
    network: string,
  ): Promise<void> {
    const labels = await this.engine.getNetworkLabels(network);
    if (
      labels?.[FORGE_LABEL] === net &&
      labels[FAULT_NETWORK_LABEL] === "true"
    ) {
      await this.engine.removeNetwork(network);
    }
  }

  private async readFaultFile(net: string): Promise<PersistedFaultFile> {
    const path = join(this.stateDir, net, "faults.json");
    try {
      return parseFaultFile(JSON.parse(await readFile(path, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return emptyFaultFile();
      }
      throw new ForgeError(
        "FAULT_STATE_MISMATCH",
        `could not read persisted fault state for network "${net}"`,
        {
          resource: path,
          action: `inspect or repair "${path}" before changing faults`,
          cause: error,
        },
      );
    }
  }

  private async writeFaultFile(
    net: string,
    file: PersistedFaultFile,
  ): Promise<void> {
    const path = join(this.stateDir, net, "faults.json");
    const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
    try {
      await writeFile(temporary, JSON.stringify(file, null, 2) + "\n", {
        mode: 0o600,
      });
      await rename(temporary, path);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => {});
      throw new ForgeError(
        "FAULT_STATE_MISMATCH",
        `could not persist fault state for network "${net}"`,
        {
          resource: path,
          action: "fix state-directory permissions and retry",
          cause: error,
        },
      );
    }
  }

  private hasFault(file: PersistedFaultFile, kind: FaultKind): boolean {
    return file.faults.some((fault) => fault.kind === kind);
  }

  private async assertFaultSupported(kind: FaultKind): Promise<void> {
    const capabilities = await this.engine.faultCapabilities();
    const supported =
      kind === "node-kill"
        ? capabilities.abruptKill
        : kind === "peer-partition" || kind === "ckb-unavailable"
          ? capabilities.networkIsolation
          : true;
    if (!supported) {
      throw new ForgeError(
        "FAULT_UNSUPPORTED",
        `container engine does not support fault "${kind}"`,
        {
          resource: kind,
          action: "use a Docker Engine host with kill and bridge-network APIs",
        },
      );
    }
  }

  private async prepareFaultRecord(
    state: NetworkState,
    kind: FaultKind,
    target?: string,
  ): Promise<PersistedFault> {
    const record: PersistedFault = {
      id: faultId(kind, target),
      kind,
      ...(target ? { target } : {}),
      appliedAt: new Date().toISOString(),
    };
    if (kind === "peer-partition") {
      const node = this.requireNode(state, target!);
      const index = state.nodes.indexOf(node) + 1;
      const base = pickSubnetBase(
        `${state.net}-partition-${index}`,
        await this.engine.usedSubnets(),
      );
      record.isolation = {
        network: `ffault-${state.net}-${index}`,
        subnet: `${base}.0/24`,
        nodeIp: `${base}.11`,
        ckbIp: `${base}.2`,
      };
    }
    return record;
  }

  private async preflightFaultApply(
    state: NetworkState,
    file: PersistedFaultFile,
    fault: PersistedFault,
  ): Promise<void> {
    if (
      (fault.kind === "node-kill" || fault.kind === "peer-partition") &&
      file.faults.some(
        (active) =>
          active.target === fault.target &&
          ((active.kind === "node-kill" && fault.kind === "peer-partition") ||
            (active.kind === "peer-partition" && fault.kind === "node-kill")),
      )
    ) {
      const conflicting =
        fault.kind === "node-kill" ? "peer-partition" : "node-kill";
      throw new ForgeError(
        "FAULT_CONFLICT",
        `fault "${fault.kind}" cannot be combined with "${conflicting}" on node "${fault.target}"`,
        {
          resource: `${state.net}/${fault.target}`,
          action: `reset "${conflicting}" on node "${fault.target}" first`,
        },
      );
    }
    if (fault.kind === "node-kill" || fault.kind === "peer-partition") {
      const node = this.requireNode(state, fault.target!);
      const status = nodeRuntimeStatus(
        await this.engine.status(node.container),
      );
      if (status !== "running") {
        throw new ForgeError(
          "FAULT_PRECONDITION_FAILED",
          `node "${node.name}" must be running before applying ${fault.kind}`,
          {
            resource: `${state.net}/${node.name}`,
            action: `run "fiber-forge node start ${state.net} ${node.name}" first`,
          },
        );
      }
    }
    if (fault.kind === "peer-partition" || fault.kind === "ckb-unavailable") {
      const ckb = this.ckbContainerOf(state);
      if ((await this.engine.status(ckb)) !== "running") {
        throw new ForgeError(
          "FAULT_PRECONDITION_FAILED",
          `CKB container "${ckb}" must be running before applying ${fault.kind}`,
          {
            resource: `${state.net}/ckb`,
            action: `restore network "${state.net}" before applying the fault`,
          },
        );
      }
    }
    if (fault.kind === "peer-partition" && fault.isolation) {
      const labels = await this.engine.getNetworkLabels(
        fault.isolation.network,
      );
      if (
        labels &&
        (labels[FORGE_LABEL] !== state.net ||
          labels[FAULT_NETWORK_LABEL] !== "true")
      ) {
        throw new ForgeError(
          "FAULT_CONFLICT",
          `Docker network "${fault.isolation.network}" is not owned by network "${state.net}"`,
          {
            resource: fault.isolation.network,
            action:
              "rename or remove the conflicting Docker network, then retry",
          },
        );
      }
    }
    if (
      fault.kind === "peer-partition" &&
      this.hasFault(file, "ckb-unavailable")
    ) {
      throw new ForgeError(
        "FAULT_CONFLICT",
        "peer partition cannot be applied while CKB is unavailable",
        {
          resource: `${state.net}/${fault.id}`,
          action: `reset "ckb-unavailable" on network "${state.net}" first`,
        },
      );
    }
  }

  private async applyFaultRecord(
    state: NetworkState,
    file: PersistedFaultFile,
    fault: PersistedFault,
  ): Promise<void> {
    if (fault.kind === "node-kill") {
      await this.engine.kill(this.requireNode(state, fault.target!).container);
      return;
    }
    if (fault.kind === "peer-partition") {
      const node = this.requireNode(state, fault.target!);
      const isolation = fault.isolation!;
      const ckb = this.ckbContainerOf(state);
      await this.engine.ensureNetwork(isolation.network, isolation.subnet, {
        labels: {
          [FORGE_LABEL]: state.net,
          [FAULT_NETWORK_LABEL]: "true",
        },
      });
      await this.engine.connectNetwork(isolation.network, ckb, {
        ip: isolation.ckbIp,
        aliases: [ckb],
      });
      await this.engine.connectNetwork(isolation.network, node.container, {
        ip: isolation.nodeIp,
        aliases: [node.container],
      });
      await this.engine.disconnectNetwork(state.network, node.container);
      return;
    }
    if (fault.kind === "ckb-unavailable") {
      const ckb = this.ckbContainerOf(state);
      for (const network of this.ckbNetworks(state, file)) {
        await this.engine.disconnectNetwork(network, ckb);
      }
    }
  }

  private async observeFault(
    state: NetworkState,
    file: PersistedFaultFile,
    fault: PersistedFault,
    persisted: boolean,
  ): Promise<FaultObservation> {
    if (fault.kind === "node-kill") {
      const node = this.requireNode(state, fault.target!);
      const status = nodeRuntimeStatus(
        await this.engine.status(node.container),
      );
      const observedState =
        status === "absent"
          ? "degraded"
          : status === "stopped"
            ? persisted
              ? "active"
              : "degraded"
            : "inactive";
      return {
        state: observedState,
        summary:
          status === "stopped"
            ? `node ${node.name} is abruptly stopped with retained state`
            : status === "running"
              ? `node ${node.name} is running`
              : `node ${node.name} container is missing`,
        containerStatus: status,
      };
    }

    if (fault.kind === "peer-partition") {
      const node = this.requireNode(state, fault.target!);
      const isolation = fault.isolation;
      if (!isolation) {
        return {
          state: "degraded",
          summary: "persisted partition is missing isolation network details",
        };
      }
      const ckb = this.ckbContainerOf(state);
      const [nodePrimary, nodeIsolated, ckbIsolated] = await Promise.all([
        this.engine.networkConnected(state.network, node.container),
        this.engine.networkConnected(isolation.network, node.container),
        this.engine.networkConnected(isolation.network, ckb),
      ]);
      const attachments = [
        {
          container: node.container,
          network: state.network,
          connected: nodePrimary,
        },
        {
          container: node.container,
          network: isolation.network,
          connected: nodeIsolated,
        },
        { container: ckb, network: isolation.network, connected: ckbIsolated },
      ];
      const active = !nodePrimary && nodeIsolated && ckbIsolated;
      const inactive = nodePrimary && !nodeIsolated;
      return {
        state: active ? "active" : inactive ? "inactive" : "degraded",
        summary: active
          ? `node ${node.name} is isolated from Fiber peers while attached to CKB`
          : inactive
            ? `node ${node.name} is attached to the primary network`
            : `node ${node.name} has incomplete partition attachments`,
        containerStatus: nodeRuntimeStatus(
          await this.engine.status(node.container),
        ),
        attachments,
      };
    }

    if (fault.kind === "ckb-unavailable") {
      const ckb = this.ckbContainerOf(state);
      const networks = this.ckbNetworks(state, file);
      const attachments = await Promise.all(
        networks.map(async (network) => ({
          container: ckb,
          network,
          connected: await this.engine.networkConnected(network, ckb),
        })),
      );
      const connected = attachments.filter((item) => item.connected).length;
      return {
        state:
          connected === 0
            ? persisted
              ? "active"
              : "degraded"
            : connected === attachments.length
              ? "inactive"
              : "degraded",
        summary:
          connected === 0
            ? "CKB is detached from every managed Fiber network"
            : connected === attachments.length
              ? "CKB is attached to every managed Fiber network"
              : "CKB has incomplete network attachments",
        containerStatus: nodeRuntimeStatus(await this.engine.status(ckb)),
        attachments,
      };
    }

    return {
      state: persisted ? "active" : "inactive",
      summary: persisted
        ? "Fiber Forge on-demand block generation is paused"
        : "Fiber Forge on-demand block generation is enabled",
    };
  }

  private async resetFaultRecord(
    state: NetworkState,
    file: PersistedFaultFile,
    fault: PersistedFault,
    options: NodeLifecycleOptions,
  ): Promise<Pick<FaultReport, "recovery" | "nextAction">> {
    const { timeoutMs, reconcileTimeoutMs } = this.lifecycleTimeouts(options);
    if (fault.kind === "node-kill") {
      const report = await this.startNodeNow(
        state.net,
        fault.target!,
        "start",
        options,
      );
      return { recovery: report.recovery, nextAction: report.nextAction };
    }

    if (fault.kind === "peer-partition") {
      const node = this.requireNode(state, fault.target!);
      const isolation = fault.isolation;
      if (!isolation) {
        throw new ForgeError(
          "FAULT_STATE_MISMATCH",
          `fault "${fault.id}" has no isolation network details`,
          {
            resource: `${state.net}/${fault.id}`,
            action:
              "inspect faults.json and remove the orphaned fault network manually",
          },
        );
      }
      await this.engine.connectNetwork(state.network, node.container, {
        ip: node.ip,
        aliases: [node.container],
      });
      await this.engine.disconnectNetwork(isolation.network, node.container);
      await this.engine.disconnectNetwork(
        isolation.network,
        this.ckbContainerOf(state),
      );
      await this.removeFaultNetwork(state.net, isolation.network);
      const rpc = this.rpcFor(node.rpcHostPort);
      const info = await this.waitLifecycleNodeInfo(
        rpc,
        timeoutMs,
        state.net,
        node.name,
        node.container,
      );
      if (info.pubkey !== node.pubkey) {
        throw new ForgeError(
          "NODE_IDENTITY_MISMATCH",
          `node "${node.name}" has a different public key after partition reset`,
          {
            resource: `${state.net}/${node.name}`,
            action: `stop using network "${state.net}" and recreate it`,
          },
        );
      }
      const observed = await this.observeNodeRecovery(
        state,
        node,
        rpc,
        reconcileTimeoutMs,
      );
      return observed.ready
        ? { recovery: "ready", nextAction: null }
        : {
            recovery: "action-required",
            nextAction: `inspect peers and channels with "fiber-forge node inspect ${state.net} ${node.name} --json"`,
          };
    }

    if (fault.kind === "ckb-unavailable") {
      const ckb = this.ckbContainerOf(state);
      await this.engine.connectNetwork(state.network, ckb, {
        ip: this.ckbIpOf(state),
        aliases: [ckb],
      });
      for (const partition of file.faults.filter(
        (candidate) =>
          candidate.kind === "peer-partition" && candidate.isolation,
      )) {
        await this.engine.connectNetwork(partition.isolation!.network, ckb, {
          ip: partition.isolation!.ckbIp,
          aliases: [ckb],
        });
      }
      await this.chainFor(state.ckbHostPort).waitReady(timeoutMs);
      return { recovery: "ready", nextAction: null };
    }

    const chain = this.chainFor(state.ckbHostPort);
    await chain.waitReady(timeoutMs);
    const before = await chain.tipBlock();
    await chain.generateBlocks(1);
    const after = await chain.tipBlock();
    return after > before
      ? { recovery: "ready", nextAction: null }
      : {
          recovery: "action-required",
          nextAction: `inspect CKB logs with "fiber-forge logs ${state.net} ckb"`,
        };
  }

  private faultReport(
    net: string,
    fault: PersistedFault,
    requested: "active" | "reset",
    observed: FaultObservation,
    changed: boolean,
  ): FaultReport {
    const suffix = fault.target ? ` ${fault.target}` : "";
    return {
      net,
      id: fault.id,
      kind: fault.kind,
      target: fault.target ?? null,
      requested,
      observed,
      changed,
      appliedAt: fault.appliedAt,
      survivesProcessRestart: true,
      recovery: requested === "reset" ? "ready" : "not-applicable",
      nextAction:
        requested === "active"
          ? `run "fiber-forge fault reset ${net} ${fault.kind}${suffix}"`
          : null,
    };
  }

  private ckbContainerOf(state: NetworkState): string {
    return state.ckbContainer ?? `forge-${state.net}-ckb`;
  }

  private ckbIpOf(state: NetworkState): string {
    if (state.ckbIp) return state.ckbIp;
    const octets = state.nodes[0]?.ip.split(".");
    if (!octets || octets.length !== 4) {
      throw new ForgeError(
        "FAULT_STATE_MISMATCH",
        `network "${state.net}" has no recoverable CKB address`,
        {
          resource: `${state.net}/ckb`,
          action: `recreate network "${state.net}" with the current Fiber Forge version`,
        },
      );
    }
    return `${octets[0]}.${octets[1]}.${octets[2]}.2`;
  }

  private ckbNetworks(state: NetworkState, file: PersistedFaultFile): string[] {
    return [
      state.network,
      ...file.faults.flatMap((fault) =>
        fault.kind === "peer-partition" && fault.isolation
          ? [fault.isolation.network]
          : [],
      ),
    ];
  }

  private async assertMiningAvailable(net: string): Promise<void> {
    if (this.hasFault(await this.readFaultFile(net), "mining-pause")) {
      throw new ForgeError(
        "MINING_PAUSED",
        `on-demand block generation is paused for network "${net}"`,
        {
          resource: `${net}/mining-pause`,
          action: `run "fiber-forge fault reset ${net} mining-pause"`,
        },
      );
    }
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

  private lightningPlan(state: NetworkState): LightningBackendPlan {
    const match = state.ckbIp?.match(/^(\d{1,3}\.\d{1,3}\.\d{1,3})\.\d{1,3}$/);
    if (!match) {
      throw new ForgeError(
        "PROVISION_FAILED",
        `network "${state.net}" does not record a supported IPv4 layout`,
        {
          resource: state.net,
          action: "recreate the network with the current Fiber Forge version",
        },
      );
    }
    return planLightningBackend(state.net, state.network, match[1]);
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

  private chainFor(ckbHostPort: number): DevChain {
    return this.makeChain(ckbHostPort);
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
