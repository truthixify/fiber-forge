import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  type BundleInspection,
  type ExportBundleOptions,
  type ExportBundleResult,
  type ReplayBundleOptions,
  type ReplayBundleResult,
} from "./bundle.js";
import {
  type LayoutOptions,
  type NetworkLayout,
  planLayout,
} from "./config.js";
import { DockerEngine } from "./engine.js";
import { type ForgeErrorDetails } from "./errors.js";
import { type FaultKind, type FaultReport } from "./faults.js";
import {
  type ChannelRow,
  type ChannelSettlementReport,
  type DownOptions,
  type MineReport,
  type NetworkSummary,
  type NetworkView,
  type NodeLifecycleOptions,
  type NodeLifecycleReport,
  Orchestrator,
  type PaymentReport,
  type ForceCloseOptions,
  type UpOptions,
} from "./orchestrator.js";
import {
  type Scenario,
  type ScenarioReport,
  type ScenarioRunOptions,
} from "./scenario.js";
import { type Topology, validateTopology } from "./topology.js";

export { version } from "./version.js";
export {
  BUNDLE_SCHEMA_VERSION,
  DEFAULT_REPLAY_TIMEOUT_MS,
  MAX_BUNDLE_BYTES,
  MAX_BUNDLE_ENTRIES,
  MAX_BUNDLE_EXPANDED_BYTES,
  MAX_REPLAY_TIMEOUT_MS,
} from "./bundle.js";
export type {
  BundleArtifactManifest,
  BundleArtifactRole,
  BundleCompatibility,
  BundleInspection,
  BundleLevel,
  ExportBundleOptions,
  ExportBundleResult,
  ExportManifest,
  PortableAssertionResult,
  PortableScenarioReport,
  ReplayBundleOptions,
  ReplayBundleResult,
} from "./bundle.js";
export { ForgeError, errorDetails } from "./errors.js";
export type { ForgeErrorCode, ForgeErrorDetails } from "./errors.js";
export { FAULT_KINDS, isFaultKind } from "./faults.js";
export type {
  FaultKind,
  FaultNetworkAttachment,
  FaultObservation,
  FaultObservedState,
  FaultReport,
} from "./faults.js";
export {
  FUNDING_BUFFER_CKB,
  MAX_NODES,
  MIN_CHANNEL_CAPACITY_CKB,
  MIN_NODES,
  TopologyError,
  parseTopology,
  validateTopology,
} from "./topology.js";
export type {
  ChannelSpec,
  FundingSpec,
  NodeSpec,
  Topology,
} from "./topology.js";
export { line, preset, presetNames, ring, star } from "./presets.js";
export {
  SCENARIO_REPORT_VERSION,
  SCENARIO_SCHEMA_VERSION,
  ScenarioError,
  parseScenario,
} from "./scenario.js";
export type {
  AssertionResult,
  BalanceAsset,
  BalanceOperator,
  Scenario,
  ScenarioAction,
  ScenarioAssertion,
  ScenarioExpectation,
  ScenarioNodeStatus,
  ScenarioReport,
  ScenarioRunOptions,
  ScenarioStep,
  ScenarioTiming,
  StepResult,
} from "./scenario.js";
export type { LayoutOptions, NetworkLayout, NodeLayout } from "./config.js";
export { DEFAULT_PROVISION_TIMEOUT_MS } from "./orchestrator.js";
export type {
  ChannelRow,
  ChannelSettlementPhase,
  ChannelSettlementReport,
  DownOptions,
  NetworkState,
  NetworkSummary,
  NetworkView,
  MineReport,
  ForceCloseOptions,
  NodeChannelObservation,
  NodeLifecycleAction,
  NodeLifecycleOptions,
  NodeLifecycleReport,
  NodeRuntimeStatus,
  PaymentReport,
  UpOptions,
} from "./orchestrator.js";

/** Options for constructing the default Docker-backed SDK client. */
export interface FiberForgeOptions {
  /** Directory used for persisted network layouts. Defaults to `~/.fiber-forge`. */
  stateDir?: string;
}

/**
 * Validate a topology and compute its deterministic names, subnet, and ports without accessing
 * Docker or persisted state. Runtime port/subnet conflict resolution still occurs during `up`.
 */
export function planNetwork(
  topology: Topology,
  options: LayoutOptions = {},
): NetworkLayout {
  const validated = validateTopology({
    name: topology.name,
    nodes: topology.nodes,
    channels: topology.channels.map((channel) => ({
      from: channel.from,
      to: channel.to,
      capacity_ckb: channel.capacityCkb,
    })),
    funding: { per_node_ckb: topology.funding.perNodeCkb },
  });
  return planLayout(validated, options);
}

/**
 * The supported high-level SDK contract. It operates only on local networks managed by Fiber
 * Forge; low-level Docker, key, chain, and raw Fiber RPC helpers remain internal.
 */
export interface FiberForge {
  up(topology: Topology, options?: UpOptions): Promise<NetworkLayout>;
  runScenario(
    net: string,
    scenario: Scenario | string,
    options?: ScenarioRunOptions,
  ): Promise<ScenarioReport>;
  exportBundle(
    net: string,
    options: ExportBundleOptions,
  ): Promise<ExportBundleResult>;
  inspectBundle(path: string): Promise<BundleInspection>;
  replayBundle(
    path: string,
    options: ReplayBundleOptions,
  ): Promise<ReplayBundleResult>;
  inspect(net: string): Promise<NetworkView>;
  inspectNode(net: string, node: string): Promise<NodeLifecycleReport>;
  stopNode(net: string, node: string): Promise<NodeLifecycleReport>;
  startNode(
    net: string,
    node: string,
    options?: NodeLifecycleOptions,
  ): Promise<NodeLifecycleReport>;
  restartNode(
    net: string,
    node: string,
    options?: NodeLifecycleOptions,
  ): Promise<NodeLifecycleReport>;
  applyFault(
    net: string,
    kind: FaultKind,
    target?: string,
  ): Promise<FaultReport>;
  faultStatus(net: string): Promise<FaultReport[]>;
  resetFault(
    net: string,
    kind: FaultKind,
    target?: string,
    options?: NodeLifecycleOptions,
  ): Promise<FaultReport>;
  resetAllFaults(
    net: string,
    options?: NodeLifecycleOptions,
  ): Promise<FaultReport[]>;
  mineBlocks(net: string, count?: number): Promise<MineReport>;
  down(net: string, options?: DownOptions): Promise<void>;
  downAll(options?: DownOptions): Promise<string[]>;
  list(): Promise<NetworkSummary[]>;
  createInvoice(
    net: string,
    node: string,
    amount: number,
    description?: string,
    udt?: boolean,
  ): Promise<string>;
  pay(
    net: string,
    from: string,
    to: string,
    amount: number,
    description?: string,
    udt?: boolean,
  ): Promise<PaymentReport>;
  payInvoice(
    net: string,
    from: string,
    invoice: string,
  ): Promise<PaymentReport>;
  issueUdt(net: string, node: string, amountUdt: number): Promise<string>;
  openChannelBetween(
    net: string,
    from: string,
    to: string,
    capacity: number,
    onProgress?: (message: string) => void,
    udt?: boolean,
  ): Promise<void>;
  closeChannel(net: string, node: string, channelId: string): Promise<void>;
  forceCloseChannel(
    net: string,
    node: string,
    channelId: string,
    options: ForceCloseOptions,
  ): Promise<ChannelSettlementReport>;
  inspectChannelSettlement(
    net: string,
    node: string,
    channelId: string,
  ): Promise<ChannelSettlementReport>;
  fund(net: string, node: string, amountCkb: number): Promise<string>;
  channels(net: string, node?: string): Promise<ChannelRow[]>;
  logs(
    net: string,
    node: string,
    tailLines?: number,
    level?: string,
  ): Promise<string>;
}

/** A narrow, stable error result suitable for logging or serialization across app boundaries. */
export type FiberForgeError = ForgeErrorDetails;

/** Create a Docker-backed client using the assets bundled with the installed package. */
export function createFiberForge(options: FiberForgeOptions = {}): FiberForge {
  const assetsDir = join(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "assets",
  );
  return new Orchestrator(new DockerEngine(), assetsDir, options.stateDir);
}
