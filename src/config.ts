/**
 * Deterministic network layout (container names, static IPs, host ports, per-node passwords) and
 * fnn `config.yml` generation. Pure functions so a whole network's plan is testable without Docker.
 * The generated config mirrors the layout the live spike proved boots against a dev chain.
 */

import { type Topology } from "./topology";

export const FNN_RPC_PORT = 8227;
export const FNN_P2P_PORT = 8228;
export const CKB_RPC_PORT = 8114;

export interface NodeLayout {
  /** 1-based index. */
  index: number;
  /** The topology node name. */
  name: string;
  /** Container name `forge-<net>-node-<i>`. */
  container: string;
  /** Static private IP within the subnet. */
  ip: string;
  /** Host port mapped to the container's RPC port. */
  rpcHostPort: number;
  /** Per-node `FIBER_SECRET_KEY_PASSWORD`. */
  password: string;
}

export interface NetworkLayout {
  net: string;
  network: string;
  subnet: string;
  ckbContainer: string;
  ckbIp: string;
  ckbHostPort: number;
  nodes: NodeLayout[];
}

export interface LayoutOptions {
  /** Subnet prefix, default `172.30` → `172.30.0.0/16` (private, so fnn RPC needs no biscuit). */
  subnetPrefix?: string;
  /** CKB RPC host port, default 8114. */
  ckbHostPort?: number;
  /** First fnn RPC host port; nodes take base, base+1, … Default 8300 (avoids a user node on 8227). */
  rpcHostPortBase?: number;
}

/** Compute the full network layout from a validated topology. */
export function planLayout(
  topology: Topology,
  options: LayoutOptions = {},
): NetworkLayout {
  const prefix = options.subnetPrefix ?? "172.30";
  const base = options.rpcHostPortBase ?? 8300;
  const net = topology.name;
  const nodes: NodeLayout[] = topology.nodes.map((node, i) => ({
    index: i + 1,
    name: node.name,
    container: `forge-${net}-node-${i + 1}`,
    ip: `${prefix}.0.${11 + i}`,
    rpcHostPort: base + i,
    password: `forge-${net}-${node.name}`,
  }));
  return {
    net,
    network: `forge-${net}`,
    subnet: `${prefix}.0.0/16`,
    ckbContainer: `forge-${net}-ckb`,
    ckbIp: `${prefix}.0.2`,
    ckbHostPort: options.ckbHostPort ?? CKB_RPC_PORT,
    nodes,
  };
}

/** Render the devnet `config.yml` for one node (the shape the spike verified boots). */
export function fnnConfigYaml(layout: NetworkLayout, node: NodeLayout): string {
  return [
    "fiber:",
    "  chain: dev.toml",
    "  auto_announce_node: true",
    "  announce_private_addr: true",
    "rpc:",
    `  listening_addr: ${node.ip}:${FNN_RPC_PORT}`,
    "  enabled_modules: [channel, payment, graph, info, invoice, peer, dev]",
    "ckb:",
    `  rpc_url: http://${layout.ckbContainer}:${CKB_RPC_PORT}`,
    "services:",
    "  - fiber",
    "  - rpc",
    "  - ckb",
    "",
  ].join("\n");
}
