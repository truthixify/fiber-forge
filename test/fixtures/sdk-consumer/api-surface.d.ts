import { type LayoutOptions, type NetworkLayout } from "./config.js";
import { type ForgeErrorDetails } from "./errors.js";
import {
  type ChannelRow,
  type DownOptions,
  type NetworkSummary,
  type NetworkView,
  type NodeLifecycleOptions,
  type NodeLifecycleReport,
  type PaymentReport,
  type UpOptions,
} from "./orchestrator.js";
import { type Topology } from "./topology.js";
export { version } from "./version.js";
export { ForgeError, errorDetails } from "./errors.js";
export type { ForgeErrorCode, ForgeErrorDetails } from "./errors.js";
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
export type { LayoutOptions, NetworkLayout, NodeLayout } from "./config.js";
export { DEFAULT_PROVISION_TIMEOUT_MS } from "./orchestrator.js";
export type {
  ChannelRow,
  DownOptions,
  NetworkState,
  NetworkSummary,
  NetworkView,
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
export declare function planNetwork(
  topology: Topology,
  options?: LayoutOptions,
): NetworkLayout;
/**
 * The supported high-level SDK contract. It operates only on local networks managed by Fiber
 * Forge; low-level Docker, key, chain, and raw Fiber RPC helpers remain internal.
 */
export interface FiberForge {
  up(topology: Topology, options?: UpOptions): Promise<NetworkLayout>;
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
export declare function createFiberForge(
  options?: FiberForgeOptions,
): FiberForge;
