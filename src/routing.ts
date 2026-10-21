import { type UdtScript } from "./ckb.js";

/** Public graph output is capped even though Fiber's graph RPC accepts an unbounded limit. */
export const DEFAULT_ROUTING_GRAPH_LIMIT = 100;
export const MAX_ROUTING_GRAPH_LIMIT = 250;
export const MAX_ROUTING_WARNINGS = 64;
export const MAX_ROUTE_HOPS = 8;
export const MAX_ROUTE_CANDIDATES = 8;
const MAX_ROUTE_SEARCH_STATES = 2_048;
export const ROUTING_FRESH_MS = 14 * 24 * 60 * 60 * 1_000;
export const ROUTING_FUTURE_TOLERANCE_MS = 60_000;

export type RoutingFreshness = "fresh" | "stale" | "future" | "unknown";
export type RoutingAssetKind = "ckb" | "udt" | "unknown";

export interface RoutingWarning {
  code: string;
  message: string;
  path?: string;
}

export interface RoutingNode {
  pubkey: string;
  name: string;
  announcedName: string | null;
  nameSource: "managed-layout" | "fiber.graph_nodes" | "fiber.graph_channels";
  source: "fiber.graph_nodes" | "managed-layout" | "fiber.graph_channels";
  graphAdvertised: boolean;
  version: string | null;
  addresses: string[];
  features: string[];
  chainHash: string | null;
  autoAcceptMinCkbFundingBaseUnits: string | null;
  updatedAtMs: string | null;
  ageMs: string | null;
  freshness: RoutingFreshness;
  degree: number;
  component: number;
  /** True when this node is not connected to the observing managed node. */
  disconnected: boolean;
}

export interface RoutingDirection {
  from: string;
  to: string;
  announcement: "present" | "missing";
  enabled: boolean | null;
  outboundLiquidityBaseUnits: string | null;
  feeRateMillionths: string | null;
  tlcExpiryDeltaMs: string | null;
  tlcMinimumBaseUnits: string | null;
  updatedAtMs: string | null;
  ageMs: string | null;
  freshness: RoutingFreshness;
}

export interface RoutingChannel {
  outpoint: string;
  node1: string;
  node2: string;
  capacityBaseUnits: string | null;
  chainHash: string | null;
  asset: {
    kind: RoutingAssetKind;
    typeScript: UdtScript | null;
  };
  createdAtMs: string | null;
  directions: [RoutingDirection, RoutingDirection];
}

export interface RoutingGraphSnapshot {
  schemaVersion: 1;
  kind: "fiber-routing-graph";
  net: string;
  source: "fiber.graph_nodes+fiber.graph_channels";
  observer: { name: string; pubkey: string };
  observedAt: string;
  limits: {
    requested: number;
    maximum: number;
    nodesReturned: number;
    channelsReturned: number;
    nodesTruncated: boolean;
    channelsTruncated: boolean;
  };
  nodes: RoutingNode[];
  channels: RoutingChannel[];
  summary: {
    components: number;
    isolatedNodes: number;
    unreachableNodes: number;
    incompleteDirections: number;
    staleDirections: number;
    disabledDirections: number;
  };
  warnings: RoutingWarning[];
}

export interface InferredRouteCandidate {
  source: "inferred-graph-connectivity";
  asset: "ckb" | "udt";
  nodePubkeys: string[];
  nodeNames: string[];
  channelOutpoints: string[];
  hopCount: number;
}

export interface FiberRouterHop {
  targetPubkey: string;
  targetName: string;
  channelOutpoint: string;
  amountReceivedBaseUnits: string;
  incomingTlcExpiryMs: string;
}

export interface FiberRouteTrace {
  source: "fiber.build_router";
  pathSource: "explicit";
  requestedPath: { name: string; pubkey: string }[];
  amountBaseUnits: string;
  totalFeeBaseUnits: string | null;
  hops: FiberRouterHop[];
}

export interface RouteInspectionReport {
  schemaVersion: 1;
  kind: "fiber-route-inspection";
  net: string;
  observer: { name: string; pubkey: string };
  asset: "ckb" | "udt";
  requestedAmount: number;
  attemptedRoute: FiberRouteTrace;
  /** Inspection does not execute a payment, so it can never claim a successful route. */
  finalSuccessfulRoute: null;
  warnings: RoutingWarning[];
}

export interface RoutedPaymentReport {
  schemaVersion: 1;
  kind: "fiber-routed-payment";
  net: string;
  from: string;
  to: string;
  asset: "ckb" | "udt";
  amount: number;
  paymentHash: string;
  status: string;
  attemptedRoute: FiberRouteTrace;
  /** Present only when Fiber reports terminal Success for the attempted route. */
  finalSuccessfulRoute: FiberRouteTrace | null;
  warnings: RoutingWarning[];
}

export interface RoutingGraphOptions {
  /** Managed node whose local gossip view is queried. Defaults to the first persisted node. */
  observer?: string;
  /** Maximum nodes and channels returned for rendering or JSON output. */
  limit?: number;
}

export interface ExplicitRouteOptions {
  /** Ordered intermediate managed node names. The sender and receiver are added automatically. */
  via?: string[];
  /** Build the route for the bundled dev UDT instead of CKB. */
  udt?: boolean;
  /** Optional final-hop TLC expiry delta in milliseconds. */
  finalTlcExpiryDeltaMs?: number;
}

interface NormalizeGraphInput {
  net: string;
  observer: { name: string; pubkey: string };
  knownNodes: readonly { name: string; pubkey: string }[];
  nodePage: unknown;
  channelPage: unknown;
  limit: number;
  observedAtMs?: number;
}

interface WarningCollector {
  warnings: RoutingWarning[];
  add(code: string, message: string, path?: string): void;
}

function warningCollector(): WarningCollector {
  const warnings: RoutingWarning[] = [];
  return {
    warnings,
    add(code, message, path) {
      if (warnings.length >= MAX_ROUTING_WARNINGS) return;
      warnings.push({ code, message, ...(path ? { path } : {}) });
    },
  };
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function unsigned(
  value: unknown,
  collector: WarningCollector,
  path: string,
  optional = false,
): bigint | null {
  if (value === undefined || value === null) {
    if (!optional)
      collector.add(
        "MISSING_UNSIGNED",
        "required unsigned value is missing",
        path,
      );
    return null;
  }
  if (typeof value !== "string" || !/^(?:0x[0-9a-f]+|[0-9]+)$/i.test(value)) {
    collector.add(
      "INVALID_UNSIGNED",
      "unsigned value was not valid hexadecimal or decimal text",
      path,
    );
    return null;
  }
  try {
    const parsed = BigInt(value);
    if (parsed < 0n) throw new Error("negative");
    return parsed;
  } catch {
    collector.add(
      "INVALID_UNSIGNED",
      "unsigned value was outside the supported range",
      path,
    );
    return null;
  }
}

function freshness(
  timestamp: bigint | null,
  observedAt: bigint,
): {
  updatedAtMs: string | null;
  ageMs: string | null;
  freshness: RoutingFreshness;
} {
  if (timestamp === null) {
    return { updatedAtMs: null, ageMs: null, freshness: "unknown" };
  }
  const age = observedAt - timestamp;
  if (age < -BigInt(ROUTING_FUTURE_TOLERANCE_MS)) {
    return {
      updatedAtMs: timestamp.toString(),
      ageMs: age.toString(),
      freshness: "future",
    };
  }
  return {
    updatedAtMs: timestamp.toString(),
    ageMs: (age < 0n ? 0n : age).toString(),
    freshness: age > BigInt(ROUTING_FRESH_MS) ? "stale" : "fresh",
  };
}

function stringArray(
  value: unknown,
  collector: WarningCollector,
  path: string,
  limit: number,
): string[] {
  if (!Array.isArray(value)) {
    if (value !== undefined && value !== null) {
      collector.add("INVALID_ARRAY", "value was not an array", path);
    }
    return [];
  }
  const result = value
    .filter((item): item is string => typeof item === "string")
    .slice(0, limit);
  if (result.length !== Math.min(value.length, limit)) {
    collector.add(
      "INVALID_ARRAY_ITEM",
      "non-string array entries were ignored",
      path,
    );
  }
  return result;
}

function typeScript(
  value: unknown,
  collector: WarningCollector,
  path: string,
): UdtScript | null {
  const raw = record(value);
  if (!raw) {
    collector.add("INVALID_TYPE_SCRIPT", "UDT type script was malformed", path);
    return null;
  }
  const codeHash = text(raw.code_hash);
  const hashType = text(raw.hash_type);
  const args = typeof raw.args === "string" ? raw.args : null;
  if (!codeHash || !hashType || args === null) {
    collector.add(
      "INVALID_TYPE_SCRIPT",
      "UDT type script fields were malformed",
      path,
    );
    return null;
  }
  return { code_hash: codeHash, hash_type: hashType, args };
}

function direction(
  value: unknown,
  from: string,
  to: string,
  observedAt: bigint,
  collector: WarningCollector,
  path: string,
): RoutingDirection {
  if (value === undefined || value === null) {
    return {
      from,
      to,
      announcement: "missing",
      enabled: null,
      outboundLiquidityBaseUnits: null,
      feeRateMillionths: null,
      tlcExpiryDeltaMs: null,
      tlcMinimumBaseUnits: null,
      ...freshness(null, observedAt),
    };
  }
  const raw = record(value);
  if (!raw) {
    collector.add(
      "INVALID_DIRECTION",
      "channel direction update was malformed",
      path,
    );
    return direction(null, from, to, observedAt, collector, path);
  }
  const timestamp = unsigned(raw.timestamp, collector, `${path}.timestamp`);
  const outbound = unsigned(
    raw.outbound_liquidity,
    collector,
    `${path}.outbound_liquidity`,
    true,
  );
  const fee = unsigned(raw.fee_rate, collector, `${path}.fee_rate`);
  const expiry = unsigned(
    raw.tlc_expiry_delta,
    collector,
    `${path}.tlc_expiry_delta`,
  );
  const minimum = unsigned(
    raw.tlc_minimum_value,
    collector,
    `${path}.tlc_minimum_value`,
  );
  if (typeof raw.enabled !== "boolean") {
    collector.add(
      "INVALID_ENABLED",
      "direction enabled flag was not boolean",
      `${path}.enabled`,
    );
  }
  return {
    from,
    to,
    announcement: "present",
    enabled: typeof raw.enabled === "boolean" ? raw.enabled : null,
    outboundLiquidityBaseUnits: outbound?.toString() ?? null,
    feeRateMillionths: fee?.toString() ?? null,
    tlcExpiryDeltaMs: expiry?.toString() ?? null,
    tlcMinimumBaseUnits: minimum?.toString() ?? null,
    ...freshness(timestamp, observedAt),
  };
}

/** Normalize two independently queried Fiber graph pages without trusting their runtime shape. */
export function normalizeRoutingGraph(
  input: NormalizeGraphInput,
): RoutingGraphSnapshot {
  const collector = warningCollector();
  const observedAtMs = input.observedAtMs ?? Date.now();
  const observedAt = BigInt(observedAtMs);
  const limit = clampRoutingGraphLimit(input.limit);
  const nodeRoot = record(input.nodePage);
  const channelRoot = record(input.channelPage);
  const rawNodes = Array.isArray(nodeRoot?.nodes) ? nodeRoot.nodes : [];
  const rawChannels = Array.isArray(channelRoot?.channels)
    ? channelRoot.channels
    : [];
  if (!Array.isArray(nodeRoot?.nodes)) {
    collector.add(
      "INVALID_NODE_PAGE",
      "graph_nodes did not return a nodes array",
      "graph_nodes.nodes",
    );
  }
  if (!Array.isArray(channelRoot?.channels)) {
    collector.add(
      "INVALID_CHANNEL_PAGE",
      "graph_channels did not return a channels array",
      "graph_channels.channels",
    );
  }

  const knownName = new Map(
    input.knownNodes.map((node) => [node.pubkey, node.name]),
  );
  const nodes = new Map<string, RoutingNode>();
  rawNodes.slice(0, limit).forEach((value, index) => {
    const path = `graph_nodes.nodes[${index}]`;
    const raw = record(value);
    const pubkey = text(raw?.pubkey);
    if (!raw || !pubkey) {
      collector.add(
        "INVALID_NODE",
        "graph node without a valid pubkey was ignored",
        path,
      );
      return;
    }
    const announcedName =
      typeof raw.node_name === "string" ? raw.node_name : null;
    const managedName = knownName.get(pubkey);
    const timestamp = unsigned(raw.timestamp, collector, `${path}.timestamp`);
    const autoAccept = unsigned(
      raw.auto_accept_min_ckb_funding_amount,
      collector,
      `${path}.auto_accept_min_ckb_funding_amount`,
    );
    nodes.set(pubkey, {
      pubkey,
      name: managedName ?? announcedName ?? shortPubkey(pubkey),
      announcedName,
      nameSource: managedName ? "managed-layout" : "fiber.graph_nodes",
      source: "fiber.graph_nodes",
      graphAdvertised: true,
      version: typeof raw.version === "string" ? raw.version : null,
      addresses: stringArray(raw.addresses, collector, `${path}.addresses`, 16),
      features: stringArray(raw.features, collector, `${path}.features`, 32),
      chainHash: text(raw.chain_hash),
      autoAcceptMinCkbFundingBaseUnits: autoAccept?.toString() ?? null,
      ...freshness(timestamp, observedAt),
      degree: 0,
      component: -1,
      disconnected: true,
    });
  });

  for (const known of input.knownNodes) {
    if (nodes.has(known.pubkey)) continue;
    nodes.set(known.pubkey, {
      pubkey: known.pubkey,
      name: known.name,
      announcedName: null,
      nameSource: "managed-layout",
      source: "managed-layout",
      graphAdvertised: false,
      version: null,
      addresses: [],
      features: [],
      chainHash: null,
      autoAcceptMinCkbFundingBaseUnits: null,
      ...freshness(null, observedAt),
      degree: 0,
      component: -1,
      disconnected: true,
    });
  }

  const channels: RoutingChannel[] = [];
  rawChannels.slice(0, limit).forEach((value, index) => {
    const path = `graph_channels.channels[${index}]`;
    const raw = record(value);
    const outpoint = text(raw?.channel_outpoint);
    const node1 = text(raw?.node1);
    const node2 = text(raw?.node2);
    if (!raw || !outpoint || !node1 || !node2) {
      collector.add(
        "INVALID_CHANNEL",
        "graph channel without endpoints or outpoint was ignored",
        path,
      );
      return;
    }
    for (const pubkey of [node1, node2]) {
      if (nodes.has(pubkey)) continue;
      nodes.set(pubkey, {
        pubkey,
        name: knownName.get(pubkey) ?? shortPubkey(pubkey),
        announcedName: null,
        nameSource: knownName.has(pubkey)
          ? "managed-layout"
          : "fiber.graph_channels",
        source: "fiber.graph_channels",
        graphAdvertised: false,
        version: null,
        addresses: [],
        features: [],
        chainHash: null,
        autoAcceptMinCkbFundingBaseUnits: null,
        ...freshness(null, observedAt),
        degree: 0,
        component: -1,
        disconnected: true,
      });
    }
    const capacity = unsigned(raw.capacity, collector, `${path}.capacity`);
    const created = unsigned(
      raw.created_timestamp,
      collector,
      `${path}.created_timestamp`,
    );
    const hasUdt =
      raw.udt_type_script !== undefined && raw.udt_type_script !== null;
    const script = hasUdt
      ? typeScript(raw.udt_type_script, collector, `${path}.udt_type_script`)
      : null;
    channels.push({
      outpoint,
      node1,
      node2,
      capacityBaseUnits: capacity?.toString() ?? null,
      chainHash: text(raw.chain_hash),
      asset: {
        kind: hasUdt ? (script ? "udt" : "unknown") : "ckb",
        typeScript: script,
      },
      createdAtMs: created?.toString() ?? null,
      directions: [
        direction(
          raw.update_info_of_node1,
          node1,
          node2,
          observedAt,
          collector,
          `${path}.update_info_of_node1`,
        ),
        direction(
          raw.update_info_of_node2,
          node2,
          node1,
          observedAt,
          collector,
          `${path}.update_info_of_node2`,
        ),
      ],
    });
  });

  const knownPubkeys = new Set(input.knownNodes.map((node) => node.pubkey));
  const boundedNodes = new Map(
    [...nodes.values()]
      .sort((a, b) => {
        const priority = (node: RoutingNode) =>
          node.pubkey === input.observer.pubkey
            ? 0
            : knownPubkeys.has(node.pubkey)
              ? 1
              : node.source === "fiber.graph_nodes"
                ? 2
                : 3;
        return (
          priority(a) - priority(b) ||
          `${a.name}/${a.pubkey}`.localeCompare(`${b.name}/${b.pubkey}`)
        );
      })
      .slice(0, limit)
      .map((node) => [node.pubkey, node] as const),
  );
  const components = annotateConnectivity(
    boundedNodes,
    channels,
    input.observer.pubkey,
  );
  const normalizedNodes = [...boundedNodes.values()].sort((a, b) =>
    `${a.name}/${a.pubkey}`.localeCompare(`${b.name}/${b.pubkey}`),
  );
  channels.sort((a, b) => a.outpoint.localeCompare(b.outpoint));
  const directions = channels.flatMap((channel) => channel.directions);
  return {
    schemaVersion: 1,
    kind: "fiber-routing-graph",
    net: input.net,
    source: "fiber.graph_nodes+fiber.graph_channels",
    observer: input.observer,
    observedAt: new Date(observedAtMs).toISOString(),
    limits: {
      requested: limit,
      maximum: MAX_ROUTING_GRAPH_LIMIT,
      nodesReturned: normalizedNodes.length,
      channelsReturned: channels.length,
      nodesTruncated: rawNodes.length > limit || nodes.size > limit,
      channelsTruncated: rawChannels.length > limit,
    },
    nodes: normalizedNodes,
    channels,
    summary: {
      components,
      isolatedNodes: normalizedNodes.filter((node) => node.degree === 0).length,
      unreachableNodes: normalizedNodes.filter((node) => node.disconnected)
        .length,
      incompleteDirections: directions.filter(
        (item) => item.announcement === "missing",
      ).length,
      staleDirections: directions.filter((item) => item.freshness === "stale")
        .length,
      disabledDirections: directions.filter((item) => item.enabled === false)
        .length,
    },
    warnings: collector.warnings,
  };
}

function annotateConnectivity(
  nodes: Map<string, RoutingNode>,
  channels: RoutingChannel[],
  observerPubkey: string,
): number {
  const adjacency = new Map<string, Set<string>>(
    [...nodes.keys()].map((pubkey) => [pubkey, new Set<string>()]),
  );
  for (const channel of channels) {
    const node1 = adjacency.get(channel.node1);
    const node2 = adjacency.get(channel.node2);
    if (!node1 || !node2) continue;
    node1.add(channel.node2);
    node2.add(channel.node1);
  }
  let component = 0;
  const visited = new Set<string>();
  for (const pubkey of [...nodes.keys()].sort()) {
    if (visited.has(pubkey)) continue;
    const queue = [pubkey];
    visited.add(pubkey);
    while (queue.length > 0) {
      const current = queue.shift()!;
      const node = nodes.get(current)!;
      node.degree = adjacency.get(current)?.size ?? 0;
      node.component = component;
      for (const next of [...(adjacency.get(current) ?? [])].sort()) {
        if (visited.has(next)) continue;
        visited.add(next);
        queue.push(next);
      }
    }
    component += 1;
  }
  const observerComponent = nodes.get(observerPubkey)?.component;
  for (const node of nodes.values()) {
    node.disconnected =
      observerComponent === undefined || node.component !== observerComponent;
  }
  return component;
}

/** Enumerate, but never rank or automatically select, bounded graph-connectivity candidates. */
export function enumerateRouteCandidates(
  graph: RoutingGraphSnapshot,
  fromPubkey: string,
  toPubkey: string,
  options: {
    asset?: "ckb" | "udt";
    maxPaths?: number;
    maxHops?: number;
  } = {},
): InferredRouteCandidate[] {
  const asset = options.asset ?? "ckb";
  const maxPaths = Math.max(
    1,
    Math.min(MAX_ROUTE_CANDIDATES, options.maxPaths ?? MAX_ROUTE_CANDIDATES),
  );
  const maxHops = Math.max(
    1,
    Math.min(MAX_ROUTE_HOPS, options.maxHops ?? MAX_ROUTE_HOPS),
  );
  if (
    fromPubkey === toPubkey ||
    !graph.nodes.some((node) => node.pubkey === fromPubkey)
  ) {
    return [];
  }
  const names = new Map(graph.nodes.map((node) => [node.pubkey, node.name]));
  const adjacency = new Map<string, { to: string; outpoint: string }[]>();
  for (const channel of graph.channels) {
    if (channel.asset.kind !== asset) continue;
    for (const item of channel.directions) {
      if (item.enabled !== true) continue;
      const edges = adjacency.get(item.from) ?? [];
      edges.push({ to: item.to, outpoint: channel.outpoint });
      adjacency.set(item.from, edges);
    }
  }
  for (const edges of adjacency.values()) {
    edges.sort((a, b) =>
      `${a.to}/${a.outpoint}`.localeCompare(`${b.to}/${b.outpoint}`),
    );
  }

  const result: InferredRouteCandidate[] = [];
  const queue: { nodes: string[]; channels: string[] }[] = [
    { nodes: [fromPubkey], channels: [] },
  ];
  let examined = 0;
  while (
    queue.length > 0 &&
    result.length < maxPaths &&
    examined < MAX_ROUTE_SEARCH_STATES
  ) {
    const current = queue.shift()!;
    examined += 1;
    const last = current.nodes.at(-1)!;
    if (last === toPubkey) {
      result.push({
        source: "inferred-graph-connectivity",
        asset,
        nodePubkeys: current.nodes,
        nodeNames: current.nodes.map(
          (pubkey) => names.get(pubkey) ?? shortPubkey(pubkey),
        ),
        channelOutpoints: current.channels,
        hopCount: current.channels.length,
      });
      continue;
    }
    if (current.channels.length >= maxHops) continue;
    for (const edge of adjacency.get(last) ?? []) {
      if (current.nodes.includes(edge.to)) continue;
      if (queue.length >= MAX_ROUTE_SEARCH_STATES) break;
      queue.push({
        nodes: [...current.nodes, edge.to],
        channels: [...current.channels, edge.outpoint],
      });
    }
  }
  return result;
}

/** Normalize the exact hop sequence returned by Fiber's `build_router`. */
export function normalizeFiberRoute(
  raw: unknown,
  requestedPath: { name: string; pubkey: string }[],
  amountBaseUnits: bigint,
): { route: FiberRouteTrace; warnings: RoutingWarning[] } {
  const collector = warningCollector();
  const root = record(raw);
  const values = Array.isArray(root?.router_hops) ? root.router_hops : [];
  if (!Array.isArray(root?.router_hops)) {
    collector.add(
      "INVALID_ROUTER",
      "build_router did not return a router_hops array",
      "router_hops",
    );
  }
  const names = new Map(requestedPath.map((node) => [node.pubkey, node.name]));
  const hops: FiberRouterHop[] = [];
  values.slice(0, MAX_ROUTE_HOPS).forEach((value, index) => {
    const path = `router_hops[${index}]`;
    const rawHop = record(value);
    const target = text(rawHop?.target);
    const outpoint = text(rawHop?.channel_outpoint);
    const amount = unsigned(
      rawHop?.amount_received,
      collector,
      `${path}.amount_received`,
    );
    const expiry = unsigned(
      rawHop?.incoming_tlc_expiry,
      collector,
      `${path}.incoming_tlc_expiry`,
    );
    if (!rawHop || !target || !outpoint || amount === null || expiry === null) {
      collector.add(
        "INVALID_ROUTER_HOP",
        "malformed Fiber router hop was ignored",
        path,
      );
      return;
    }
    hops.push({
      targetPubkey: target,
      targetName: names.get(target) ?? shortPubkey(target),
      channelOutpoint: outpoint,
      amountReceivedBaseUnits: amount.toString(),
      incomingTlcExpiryMs: expiry.toString(),
    });
  });
  if (values.length > MAX_ROUTE_HOPS) {
    collector.add(
      "ROUTER_TOO_LARGE",
      `router exceeded the ${MAX_ROUTE_HOPS}-hop output bound`,
      "router_hops",
    );
  }
  const first = hops[0] ? BigInt(hops[0].amountReceivedBaseUnits) : null;
  const last = hops.at(-1)
    ? BigInt(hops.at(-1)!.amountReceivedBaseUnits)
    : null;
  const amountsDecreaseTowardDestination = hops.every(
    (hop, index) =>
      index === 0 ||
      BigInt(hops[index - 1]!.amountReceivedBaseUnits) >=
        BigInt(hop.amountReceivedBaseUnits),
  );
  let totalFeeBaseUnits: string | null = null;
  if (
    first !== null &&
    last !== null &&
    first >= last &&
    amountsDecreaseTowardDestination
  ) {
    totalFeeBaseUnits = (first - last).toString();
  } else if (first !== null && last !== null) {
    collector.add(
      "INVALID_ROUTER_FEE",
      "route amounts increased toward the destination",
      "router_hops",
    );
  }
  return {
    route: {
      source: "fiber.build_router",
      pathSource: "explicit",
      requestedPath,
      amountBaseUnits: amountBaseUnits.toString(),
      totalFeeBaseUnits,
      hops,
    },
    warnings: collector.warnings,
  };
}

export function clampRoutingGraphLimit(value: number): number {
  if (!Number.isSafeInteger(value)) return DEFAULT_ROUTING_GRAPH_LIMIT;
  return Math.max(1, Math.min(MAX_ROUTING_GRAPH_LIMIT, value));
}

function shortPubkey(pubkey: string): string {
  return pubkey.length > 16
    ? `${pubkey.slice(0, 10)}...${pubkey.slice(-6)}`
    : pubkey;
}
