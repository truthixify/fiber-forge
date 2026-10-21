import { describe, expect, it } from "vitest";
import {
  MAX_ROUTE_CANDIDATES,
  MAX_ROUTING_GRAPH_LIMIT,
  ROUTING_FRESH_MS,
  enumerateRouteCandidates,
  normalizeFiberRoute,
  normalizeRoutingGraph,
} from "../src/routing";

const observedAt = Date.UTC(2026, 9, 20, 12, 0, 0);
const hex = (value: number | bigint) => `0x${BigInt(value).toString(16)}`;

function node(pubkey: string, name: string, timestamp = observedAt - 1_000) {
  return {
    pubkey,
    node_name: name,
    version: "0.9.0-rc7",
    addresses: [`/ip4/10.0.0.1/tcp/8228/p2p/${name}`],
    features: ["basic_mpp"],
    timestamp: hex(timestamp),
    chain_hash: "0xchain",
    auto_accept_min_ckb_funding_amount: hex(100_000_000),
    udt_cfg_infos: [],
  };
}

function update(fromAgeMs = 1_000, enabled = true, outbound = 900_000_000) {
  return {
    timestamp: hex(observedAt - fromAgeMs),
    enabled,
    outbound_liquidity: hex(outbound),
    tlc_expiry_delta: hex(86_400_000),
    tlc_minimum_value: "0x1",
    fee_rate: "0x3e8",
  };
}

function channel(
  outpoint: string,
  node1: string,
  node2: string,
  first: unknown = update(),
  second: unknown = update(),
) {
  return {
    channel_outpoint: outpoint,
    node1,
    node2,
    created_timestamp: hex(observedAt - 10_000),
    update_info_of_node1: first,
    update_info_of_node2: second,
    capacity: hex(1_000_000_000),
    chain_hash: "0xchain",
    udt_type_script: null,
  };
}

describe("routing graph normalization", () => {
  it("keeps partial graph data usable and labels stale, future, missing, and disconnected state", () => {
    const graph = normalizeRoutingGraph({
      net: "trio",
      observer: { name: "alice", pubkey: "0xa" },
      knownNodes: [
        { name: "alice", pubkey: "0xa" },
        { name: "bob", pubkey: "0xb" },
        { name: "carol", pubkey: "0xc" },
        { name: "dora", pubkey: "0xd" },
      ],
      nodePage: {
        nodes: [
          node("0xa", "announced-alice"),
          node("0xb", "bob", observedAt - ROUTING_FRESH_MS - 1),
          node("0xc", "carol", observedAt + 60_001),
          { node_name: "missing-key" },
        ],
      },
      channelPage: {
        channels: [
          channel("0xab", "0xa", "0xb", update(), null),
          channel(
            "0xbc",
            "0xb",
            "0xc",
            update(ROUTING_FRESH_MS + 1),
            update(1_000, false),
          ),
          { channel_outpoint: "0xbad", node1: "0xa" },
        ],
      },
      limit: 20,
      observedAtMs: observedAt,
    });

    expect(graph).toMatchObject({
      schemaVersion: 1,
      source: "fiber.graph_nodes+fiber.graph_channels",
      observer: { name: "alice", pubkey: "0xa" },
      summary: {
        components: 2,
        isolatedNodes: 1,
        unreachableNodes: 1,
        incompleteDirections: 1,
        staleDirections: 1,
        disabledDirections: 1,
      },
    });
    expect(graph.nodes.find((item) => item.pubkey === "0xa")).toMatchObject({
      name: "alice",
      announcedName: "announced-alice",
      nameSource: "managed-layout",
      freshness: "fresh",
      disconnected: false,
    });
    expect(graph.nodes.find((item) => item.pubkey === "0xb")?.freshness).toBe(
      "stale",
    );
    expect(graph.nodes.find((item) => item.pubkey === "0xc")?.freshness).toBe(
      "future",
    );
    expect(graph.nodes.find((item) => item.pubkey === "0xd")).toMatchObject({
      source: "managed-layout",
      graphAdvertised: false,
      freshness: "unknown",
      disconnected: true,
    });
    expect(graph.channels[0].directions[1]).toMatchObject({
      from: "0xb",
      to: "0xa",
      announcement: "missing",
      enabled: null,
    });
    expect(graph.warnings.map((warning) => warning.code)).toEqual(
      expect.arrayContaining(["INVALID_NODE", "INVALID_CHANNEL"]),
    );
  });

  it("marks a non-isolated component unreachable from the selected observer", () => {
    const graph = normalizeRoutingGraph({
      net: "split",
      observer: { name: "alice", pubkey: "0xa" },
      knownNodes: [
        { name: "alice", pubkey: "0xa" },
        { name: "bob", pubkey: "0xb" },
        { name: "carol", pubkey: "0xc" },
        { name: "dora", pubkey: "0xd" },
      ],
      nodePage: {
        nodes: [
          node("0xa", "alice"),
          node("0xb", "bob"),
          node("0xc", "carol"),
          node("0xd", "dora"),
        ],
      },
      channelPage: {
        channels: [
          channel("0xab", "0xa", "0xb"),
          channel("0xcd", "0xc", "0xd"),
        ],
      },
      limit: 20,
      observedAtMs: observedAt,
    });

    expect(graph.summary).toMatchObject({
      components: 2,
      isolatedNodes: 0,
      unreachableNodes: 2,
    });
    expect(
      graph.nodes
        .filter((item) => item.disconnected)
        .map((item) => item.name)
        .sort(),
    ).toEqual(["carol", "dora"]);
  });

  it("bounds returned graph data independently of an oversized RPC response", () => {
    const graph = normalizeRoutingGraph({
      net: "large",
      observer: { name: "observer", pubkey: "0x0" },
      knownNodes: [],
      nodePage: {
        nodes: Array.from({ length: MAX_ROUTING_GRAPH_LIMIT + 5 }, (_, index) =>
          node(`0x${index}`, `node-${index}`),
        ),
      },
      channelPage: { channels: [] },
      limit: 99_999,
      observedAtMs: observedAt,
    });

    expect(graph.nodes).toHaveLength(MAX_ROUTING_GRAPH_LIMIT);
    expect(graph.limits).toMatchObject({
      requested: MAX_ROUTING_GRAPH_LIMIT,
      maximum: MAX_ROUTING_GRAPH_LIMIT,
      nodesTruncated: true,
    });
  });

  it("keeps managed and channel-only node injection inside the output cap", () => {
    const graph = normalizeRoutingGraph({
      net: "bounded",
      observer: { name: "alice", pubkey: "0xa" },
      knownNodes: [
        { name: "alice", pubkey: "0xa" },
        { name: "bob", pubkey: "0xb" },
      ],
      nodePage: { nodes: [node("0xexternal", "external")] },
      channelPage: {
        channels: [channel("0xcd", "0xc", "0xd")],
      },
      limit: 2,
      observedAtMs: observedAt,
    });

    expect(graph.nodes.map((item) => item.pubkey).sort()).toEqual([
      "0xa",
      "0xb",
    ]);
    expect(graph.channels).toHaveLength(1);
    expect(graph.limits).toMatchObject({
      nodesReturned: 2,
      nodesTruncated: true,
    });
  });

  it("fails soft when a future Fiber response changes the page shape", () => {
    const graph = normalizeRoutingGraph({
      net: "changed",
      observer: { name: "alice", pubkey: "0xa" },
      knownNodes: [{ name: "alice", pubkey: "0xa" }],
      nodePage: { peers: "new-shape" },
      channelPage: null,
      limit: 10,
      observedAtMs: observedAt,
    });

    expect(graph.nodes).toEqual([
      expect.objectContaining({ name: "alice", graphAdvertised: false }),
    ]);
    expect(graph.channels).toEqual([]);
    expect(graph.warnings.map((warning) => warning.code)).toEqual([
      "INVALID_NODE_PAGE",
      "INVALID_CHANNEL_PAGE",
    ]);
  });
});

describe("route candidates", () => {
  it("enumerates bounded directed alternatives without ranking or selecting one", () => {
    const graph = normalizeRoutingGraph({
      net: "diamond",
      observer: { name: "alice", pubkey: "0xa" },
      knownNodes: [
        { name: "alice", pubkey: "0xa" },
        { name: "bob", pubkey: "0xb" },
        { name: "carol", pubkey: "0xc" },
        { name: "dora", pubkey: "0xd" },
      ],
      nodePage: {
        nodes: [
          node("0xa", "alice"),
          node("0xb", "bob"),
          node("0xc", "carol"),
          node("0xd", "dora"),
        ],
      },
      channelPage: {
        channels: [
          channel("0xab", "0xa", "0xb"),
          channel("0xbd", "0xb", "0xd"),
          channel("0xac", "0xa", "0xc"),
          channel("0xcd", "0xc", "0xd"),
        ],
      },
      limit: 20,
      observedAtMs: observedAt,
    });

    const candidates = enumerateRouteCandidates(graph, "0xa", "0xd", {
      maxPaths: 20,
      maxHops: 2,
    });
    expect(candidates).toHaveLength(2);
    expect(candidates).toEqual([
      expect.objectContaining({
        source: "inferred-graph-connectivity",
        nodeNames: ["alice", "bob", "dora"],
        channelOutpoints: ["0xab", "0xbd"],
      }),
      expect.objectContaining({
        nodeNames: ["alice", "carol", "dora"],
        channelOutpoints: ["0xac", "0xcd"],
      }),
    ]);
    expect(candidates.length).toBeLessThanOrEqual(MAX_ROUTE_CANDIDATES);
  });
});

describe("Fiber route normalization", () => {
  it("preserves Fiber-selected channels and derives the total fee from exact hop amounts", () => {
    const normalized = normalizeFiberRoute(
      {
        router_hops: [
          {
            target: "0xb",
            channel_outpoint: "0xab",
            amount_received: hex(100_001_000),
            incoming_tlc_expiry: hex(100_000),
          },
          {
            target: "0xc",
            channel_outpoint: "0xbc",
            amount_received: hex(100_000_000),
            incoming_tlc_expiry: hex(50_000),
          },
        ],
      },
      [
        { name: "alice", pubkey: "0xa" },
        { name: "bob", pubkey: "0xb" },
        { name: "carol", pubkey: "0xc" },
      ],
      100_000_000n,
    );

    expect(normalized.warnings).toEqual([]);
    expect(normalized.route).toMatchObject({
      source: "fiber.build_router",
      pathSource: "explicit",
      totalFeeBaseUnits: "1000",
      hops: [
        { targetName: "bob", channelOutpoint: "0xab" },
        { targetName: "carol", channelOutpoint: "0xbc" },
      ],
    });
  });

  it("reports malformed route fields instead of manufacturing values", () => {
    const normalized = normalizeFiberRoute(
      { router_hops: [{ target: "0xb", amount_received: "not-hex" }] },
      [
        { name: "alice", pubkey: "0xa" },
        { name: "bob", pubkey: "0xb" },
      ],
      1n,
    );

    expect(normalized.route.hops).toEqual([]);
    expect(normalized.route.totalFeeBaseUnits).toBeNull();
    expect(normalized.warnings.map((warning) => warning.code)).toEqual(
      expect.arrayContaining(["INVALID_UNSIGNED", "INVALID_ROUTER_HOP"]),
    );
  });

  it("rejects a route whose amount increases at an intermediate hop", () => {
    const normalized = normalizeFiberRoute(
      {
        router_hops: [
          {
            target: "0xb",
            channel_outpoint: "0xab",
            amount_received: hex(100_001_000),
            incoming_tlc_expiry: hex(100_000),
          },
          {
            target: "0xc",
            channel_outpoint: "0xbc",
            amount_received: hex(100_002_000),
            incoming_tlc_expiry: hex(75_000),
          },
          {
            target: "0xd",
            channel_outpoint: "0xcd",
            amount_received: hex(100_000_000),
            incoming_tlc_expiry: hex(50_000),
          },
        ],
      },
      [
        { name: "alice", pubkey: "0xa" },
        { name: "bob", pubkey: "0xb" },
        { name: "carol", pubkey: "0xc" },
        { name: "dora", pubkey: "0xd" },
      ],
      100_000_000n,
    );

    expect(normalized.route.totalFeeBaseUnits).toBeNull();
    expect(normalized.warnings.map((warning) => warning.code)).toContain(
      "INVALID_ROUTER_FEE",
    );
  });
});
