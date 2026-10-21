/**
 * Typed FNN JSON-RPC client over an injectable transport, so the orchestrator's wiring logic is
 * testable against a fake without a live node. Method shapes follow the fnn source
 * (`crates/fiber-lib/src/rpc/*`): `connect_peer{address}`, `open_channel{pubkey, funding_amount}`,
 * `list_channels{pubkey?} -> {channels}`. Only the verified method set is exposed.
 */

import { type UdtScript } from "./ckb.js";

/** Carries out a single JSON-RPC call and returns its `result`. */
export interface RpcTransport {
  call(method: string, params: unknown[]): Promise<unknown>;
}

/** JSON-RPC 2.0 over HTTP (fetch). */
export class HttpTransport implements RpcTransport {
  constructor(
    private readonly url: string,
    private readonly timeoutMs = 10_000,
  ) {}

  async call(method: string, params: unknown[]): Promise<unknown> {
    const response = await fetch(this.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: 1, jsonrpc: "2.0", method, params }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) {
      throw new Error(`${method}: HTTP ${response.status}`);
    }
    const body = (await response.json()) as {
      result?: unknown;
      error?: unknown;
    };
    if (body.error !== undefined && body.error !== null) {
      throw new Error(`${method}: ${JSON.stringify(body.error)}`);
    }
    return body.result;
  }
}

export interface NodeInfo {
  pubkey: string;
  addresses: string[];
  chain_hash: string;
  node_name: string | null;
}

/** Fiber's structured channel state. Flag values are serialized as a `|`-separated string. */
export interface ChannelState {
  state_name: string;
  state_flags?: string;
}

/** A channel as returned by `list_channels`; older nodes may encode `state` as a string. */
export interface Channel {
  channel_id: string;
  /** The peer node's public key. */
  pubkey?: string;
  state: string | ChannelState;
  local_balance?: string;
  remote_balance?: string;
  latest_commitment_transaction_hash?: string | null;
  shutdown_transaction_hash?: string | null;
  [key: string]: unknown;
}

/** The channel's state name, tolerating both the string and object encodings. */
export function channelStateName(channel: Channel): string {
  return typeof channel.state === "string"
    ? channel.state
    : (channel.state?.state_name ?? "");
}

/** The flags attached to a structured Fiber channel state. */
export function channelStateFlags(channel: Channel): string[] {
  if (typeof channel.state === "string" || !channel.state?.state_flags) {
    return [];
  }
  return channel.state.state_flags
    .split("|")
    .map((flag) => flag.trim())
    .filter(Boolean);
}

/** Whether a channel has reached the usable `ChannelReady` state. */
export function isChannelReady(channel: Channel): boolean {
  return channelStateName(channel) === "ChannelReady";
}

export interface OpenChannelParams {
  /** The peer node's public key (its `node_info.pubkey`). */
  pubkey: string;
  /** Funding amount in shannons, `0x`-hex. */
  fundingAmount: string;
  /** Announce the channel to the network graph (needed for routing). */
  isPublic?: boolean;
  /** Open a UDT-denominated channel: the asset's type script (whitelisted on both nodes). */
  udtTypeScript?: UdtScript;
}

export interface BuildRouterParams {
  /** Payment amount in shannons or UDT base units, encoded as `0x` hex. */
  amount: string;
  /** Ordered hops after the source; the final entry is the payment target. */
  hops: { pubkey: string; channelOutpoint?: string }[];
  udtTypeScript?: UdtScript;
  finalTlcExpiryDelta?: string;
}

export interface FiberRpcRouterHop {
  target: string;
  channel_outpoint: string;
  amount_received: string;
  incoming_tlc_expiry: string;
}

/** The typed FNN client. */
export class FnnRpc {
  constructor(private readonly transport: RpcTransport) {}

  nodeInfo(): Promise<NodeInfo> {
    return this.transport.call("node_info", []) as Promise<NodeInfo>;
  }

  async connectPeer(address: string): Promise<void> {
    await this.transport.call("connect_peer", [{ address }]);
  }

  async openChannel(
    params: OpenChannelParams,
  ): Promise<{ temporary_channel_id: string }> {
    const result = await this.transport.call("open_channel", [
      {
        pubkey: params.pubkey,
        funding_amount: params.fundingAmount,
        public: params.isPublic ?? true,
        ...(params.udtTypeScript
          ? { funding_udt_type_script: params.udtTypeScript }
          : {}),
      },
    ]);
    return result as { temporary_channel_id: string };
  }

  async listPeers(): Promise<{ pubkey: string; address: string }[]> {
    const result = (await this.transport.call("list_peers", [])) as {
      peers: { pubkey: string; address: string }[];
    };
    return result.peers;
  }

  async listChannels(
    pubkey?: string,
    includeClosed = false,
  ): Promise<Channel[]> {
    const result = (await this.transport.call("list_channels", [
      {
        ...(pubkey ? { pubkey } : {}),
        ...(includeClosed ? { include_closed: true } : {}),
      },
    ])) as {
      channels: Channel[];
    };
    return result.channels;
  }

  async shutdownChannel(channelId: string, force = false): Promise<void> {
    await this.transport.call("shutdown_channel", [
      { channel_id: channelId, ...(force ? { force: true } : {}) },
    ]);
  }

  /** How many channels this node currently sees in the routing graph. Used to wait for gossip to
   * propagate after `up`, so the first cross-node payment does not fail with "no path found". */
  async graphChannelCount(): Promise<number> {
    const result = (await this.transport.call("graph_channels", [{}])) as {
      channels?: unknown[];
    };
    return result.channels?.length ?? 0;
  }

  /** Fetch one bounded raw node page. Callers must normalize the untrusted response shape. */
  graphNodes(limit: number): Promise<unknown> {
    return this.transport.call("graph_nodes", [
      { limit: `0x${BigInt(limit).toString(16)}` },
    ]);
  }

  /** Fetch one bounded raw channel page. Callers must normalize the untrusted response shape. */
  graphChannels(limit: number): Promise<unknown> {
    return this.transport.call("graph_channels", [
      { limit: `0x${BigInt(limit).toString(16)}` },
    ]);
  }

  /** Ask Fiber to validate and fully price an explicit ordered node path. */
  buildRouter(params: BuildRouterParams): Promise<unknown> {
    return this.transport.call("build_router", [
      {
        amount: params.amount,
        hops_info: params.hops.map((hop) => ({
          pubkey: hop.pubkey,
          ...(hop.channelOutpoint
            ? { channel_outpoint: hop.channelOutpoint }
            : {}),
        })),
        ...(params.udtTypeScript
          ? { udt_type_script: params.udtTypeScript }
          : {}),
        ...(params.finalTlcExpiryDelta
          ? { final_tlc_expiry_delta: params.finalTlcExpiryDelta }
          : {}),
      },
    ]);
  }

  /** Execute exactly the router previously returned by Fiber's `build_router`. */
  sendPaymentWithRouter(params: {
    invoice: string;
    router: FiberRpcRouterHop[];
    udtTypeScript?: UdtScript;
  }): Promise<{ payment_hash: string; status: string }> {
    return this.transport.call("send_payment_with_router", [
      {
        invoice: params.invoice,
        router: params.router,
        ...(params.udtTypeScript
          ? { udt_type_script: params.udtTypeScript }
          : {}),
      },
    ]) as Promise<{ payment_hash: string; status: string }>;
  }

  /**
   * Create an invoice. `amount` is a `0x`-hex shannons string; fiber-forge runs dev chains, whose
   * nodes require the `Fibd` currency (the node rejects any other). Verified live.
   */
  newInvoice(params: {
    amount: string;
    description?: string;
    currency?: string;
    udtTypeScript?: UdtScript;
    hashAlgorithm?: "sha256";
    paymentPreimage?: string;
  }): Promise<{
    invoice_address: string;
    invoice?: { data?: { payment_hash?: string } };
  }> {
    const { udtTypeScript, hashAlgorithm, paymentPreimage, ...rest } = params;
    return this.transport.call("new_invoice", [
      {
        currency: "Fibd",
        ...rest,
        ...(udtTypeScript ? { udt_type_script: udtTypeScript } : {}),
        ...(hashAlgorithm ? { hash_algorithm: hashAlgorithm } : {}),
        ...(paymentPreimage ? { payment_preimage: paymentPreimage } : {}),
      },
    ]) as Promise<{
      invoice_address: string;
      invoice?: { data?: { payment_hash?: string } };
    }>;
  }

  sendPayment(
    invoice: string,
  ): Promise<{ payment_hash: string; status: string }> {
    return this.transport.call("send_payment", [{ invoice }]) as Promise<{
      payment_hash: string;
      status: string;
    }>;
  }

  getPayment(paymentHash: string): Promise<{ status: string }> {
    return this.transport.call("get_payment", [
      { payment_hash: paymentHash },
    ]) as Promise<{
      status: string;
    }>;
  }
}

/** Payment lifecycle states from `send_payment`/`get_payment` (verified live). */
export type PaymentStatus = "Created" | "Inflight" | "Success" | "Failed";

/** Whether a payment has reached a terminal state. */
export function isPaymentSettled(status: string): boolean {
  return status === "Success" || status === "Failed";
}

/** CKB capacity (whole CKB) to a shannons `0x`-hex string (1 CKB = 1e8 shannons). */
export function ckbToShannonHex(ckb: number): string {
  return "0x" + (BigInt(ckb) * 100_000_000n).toString(16);
}

/** Shannons `0x`-hex (or undefined) to whole CKB, floored. */
export function shannonHexToCkb(shannonHex?: string): number {
  if (!shannonHex) {
    return 0;
  }
  return Number(BigInt(shannonHex) / 100_000_000n);
}

/** The tentacle PeerId from a node's announced addresses (the `/p2p/<id>` segment). */
export function peerIdOf(info: NodeInfo): string | undefined {
  for (const address of info.addresses) {
    const marker = "/p2p/";
    const at = address.indexOf(marker);
    if (at >= 0) {
      return address.slice(at + marker.length);
    }
  }
  return undefined;
}

/**
 * A dialable multiaddr for a peer. Announced addresses carry `0.0.0.0`, so the orchestrator
 * builds the address from the peer's known container IP and its announced PeerId.
 */
export function dialAddress(ip: string, peerId: string, port = 8228): string {
  return `/ip4/${ip}/tcp/${port}/p2p/${peerId}`;
}
