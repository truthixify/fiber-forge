/**
 * Deterministic network layout (container names, static IPs, host ports, per-node passwords) and
 * fnn `config.yml` generation. Pure functions so a whole network's plan is testable without Docker.
 * The generated config mirrors the layout the live spike proved boots against a dev chain.
 */

import { type Topology } from "./topology.js";

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
  /**
   * The `/24` subnet base, e.g. `10.5.7` → `10.5.7.0/24` (private, so fnn RPC needs no biscuit).
   * Default: derived from the network name so distinct networks get distinct subnets and coexist.
   */
  subnetBase?: string;
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
  const net = topology.name;
  const subnetBase = options.subnetBase ?? hashSubnetBase(net);
  const portBase = options.rpcHostPortBase ?? 8300;
  const nodes: NodeLayout[] = topology.nodes.map((node, i) => ({
    index: i + 1,
    name: node.name,
    container: `forge-${net}-node-${i + 1}`,
    ip: `${subnetBase}.${11 + i}`,
    rpcHostPort: portBase + i,
    password: `forge-${net}-${node.name}`,
  }));
  return {
    net,
    network: `forge-${net}`,
    subnet: `${subnetBase}.0/24`,
    ckbContainer: `forge-${net}-ckb`,
    ckbIp: `${subnetBase}.2`,
    ckbHostPort: options.ckbHostPort ?? CKB_RPC_PORT,
    nodes,
  };
}

function fnv1a(text: string): number {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/** A `10.x.y` base for octets (x,y) drawn from a 16-bit index (x is never 0). */
function baseForIndex(index: number): string {
  const x = (index >>> 8) & 0xff || 1;
  const y = index & 0xff;
  return `10.${x}.${y}`;
}

/** A deterministic `/24` base in `10.0.0.0/8` for a network name. */
export function hashSubnetBase(net: string): string {
  return baseForIndex((fnv1a(net) >>> 8) & 0xffff);
}

function cidrRange(cidr: string): [number, number] {
  const [ip, bits] = cidr.split("/");
  const value = ip
    .split(".")
    .reduce((acc, octet) => acc * 256 + Number(octet), 0);
  const size = 2 ** (32 - Number(bits));
  const start = value - (value % size);
  return [start, start + size - 1];
}

function overlaps(a: string, b: string): boolean {
  try {
    const [aStart, aEnd] = cidrRange(a);
    const [bStart, bEnd] = cidrRange(b);
    return aStart <= bEnd && bStart <= aEnd;
  } catch {
    return false;
  }
}

/**
 * A free `/24` subnet base for a network: start from the name's deterministic base and probe
 * forward until one overlaps none of `usedCidrs` (existing docker networks). Same name + same
 * environment ⇒ same base, so re-running a network is stable.
 */
export function pickSubnetBase(
  net: string,
  usedCidrs: Iterable<string>,
): string {
  const used = [...usedCidrs];
  const start = (fnv1a(net) >>> 8) & 0xffff;
  for (let step = 0; step < 0x10000; step += 1) {
    const base = baseForIndex((start + step) & 0xffff);
    if (!used.some((cidr) => overlaps(`${base}.0/24`, cidr))) {
      return base;
    }
  }
  return hashSubnetBase(net);
}

/** Render the devnet `config.yml` for one node (the shape the spike verified boots). */
/** Genesis location + code hash of the dev UDT, so nodes can whitelist and route it. */
export interface UdtWhitelistInfo {
  codeHash: string;
  depTxHash: string;
  depIndex: number;
}

export interface FnnConfigOptions {
  /** CCH's store subscription requires the hub's pubsub RPC module. */
  pubsub?: boolean;
}

export function fnnConfigYaml(
  layout: NetworkLayout,
  node: NodeLayout,
  udt?: UdtWhitelistInfo,
  options: FnnConfigOptions = {},
): string {
  const modules = [
    "channel",
    "payment",
    "graph",
    "info",
    "invoice",
    "peer",
    "dev",
    ...(options.pubsub ? ["pubsub"] : []),
  ];
  const lines = [
    "fiber:",
    "  chain: dev.toml",
    "  auto_announce_node: true",
    "  announce_private_addr: true",
    "rpc:",
    `  listening_addr: ${node.ip}:${FNN_RPC_PORT}`,
    `  enabled_modules: [${modules.join(", ")}]`,
    "ckb:",
    `  rpc_url: http://${layout.ckbContainer}:${CKB_RPC_PORT}`,
  ];
  if (udt) {
    lines.push(
      "  udt_whitelist:",
      "    - name: simple_udt",
      "      script:",
      `        code_hash: ${udt.codeHash}`,
      "        hash_type: data1",
      '        args: "0x.*"',
      "      auto_accept_amount: 1",
      "      cell_deps:",
      "        - cell_dep:",
      "            out_point:",
      `              tx_hash: ${udt.depTxHash}`,
      `              index: "0x${udt.depIndex.toString(16)}"`,
      "            dep_type: code",
    );
  }
  lines.push("services:", "  - fiber", "  - rpc", "  - ckb", "");
  return lines.join("\n");
}
