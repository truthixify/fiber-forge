import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type Channel,
  type NodeInfo,
  type RpcTransport,
  FnnRpc,
  HttpTransport,
  ckbToShannonHex,
  channelStateFlags,
  channelStateName,
  dialAddress,
  isChannelReady,
  isPaymentSettled,
  peerIdOf,
  shannonHexToCkb,
} from "../src/rpc";

class FakeTransport implements RpcTransport {
  readonly calls: { method: string; params: unknown[] }[] = [];
  constructor(
    private readonly responder: (method: string, params: unknown[]) => unknown,
  ) {}
  async call(method: string, params: unknown[]): Promise<unknown> {
    this.calls.push({ method, params });
    return this.responder(method, params);
  }
}

describe("HttpTransport", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("aborts an RPC request that never answers", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string | URL | Request, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => {
              reject(init.signal?.reason);
            });
          }),
      ),
    );

    await expect(
      new HttpTransport("http://127.0.0.1:8227", 10).call("node_info", []),
    ).rejects.toThrow(/timeout|aborted/i);
  });
});

describe("FnnRpc", () => {
  it("reads node_info", async () => {
    const rpc = new FnnRpc(
      new FakeTransport(() => ({
        pubkey: "0xab",
        addresses: [],
        chain_hash: "0xcd",
        node_name: null,
      })),
    );
    expect((await rpc.nodeInfo()).pubkey).toBe("0xab");
  });

  it("connects a peer by address", async () => {
    const t = new FakeTransport(() => null);
    await new FnnRpc(t).connectPeer("/ip4/172.30.0.12/tcp/8228/p2p/Qm");
    expect(t.calls[0]).toEqual({
      method: "connect_peer",
      params: [{ address: "/ip4/172.30.0.12/tcp/8228/p2p/Qm" }],
    });
  });

  it("opens a channel with pubkey + funding amount", async () => {
    const t = new FakeTransport(() => ({ temporary_channel_id: "0xtmp" }));
    const res = await new FnnRpc(t).openChannel({
      pubkey: "0xpeer",
      fundingAmount: ckbToShannonHex(500),
    });
    expect(t.calls[0].params).toEqual([
      { pubkey: "0xpeer", funding_amount: "0xba43b7400", public: true },
    ]);
    expect(res.temporary_channel_id).toBe("0xtmp");
  });

  it("lists channels", async () => {
    const t = new FakeTransport(() => ({
      channels: [{ channel_id: "0x1", state: "ChannelReady" }],
    }));
    const channels = await new FnnRpc(t).listChannels("0xpeer");
    expect(channels).toHaveLength(1);
    expect(t.calls[0].params).toEqual([{ pubkey: "0xpeer" }]);
  });

  it("includes closed channels only when requested", async () => {
    const t = new FakeTransport(() => ({ channels: [] }));
    await new FnnRpc(t).listChannels(undefined, true);
    expect(t.calls[0]).toEqual({
      method: "list_channels",
      params: [{ include_closed: true }],
    });
  });

  it("keeps cooperative and force shutdown payloads distinct", async () => {
    const t = new FakeTransport(() => null);
    const rpc = new FnnRpc(t);
    await rpc.shutdownChannel("0xcooperative");
    await rpc.shutdownChannel("0xforce", true);
    expect(t.calls).toEqual([
      {
        method: "shutdown_channel",
        params: [{ channel_id: "0xcooperative" }],
      },
      {
        method: "shutdown_channel",
        params: [{ channel_id: "0xforce", force: true }],
      },
    ]);
  });

  it("surfaces JSON-RPC errors", async () => {
    const rpc = new FnnRpc(
      new FakeTransport(() => {
        throw new Error("node_info: boom");
      }),
    );
    await expect(rpc.nodeInfo()).rejects.toThrow("boom");
  });
});

describe("channel state helpers", () => {
  it("reads the state name from string and object encodings", () => {
    expect(
      channelStateName({ channel_id: "1", state: "ChannelReady" } as Channel),
    ).toBe("ChannelReady");
    expect(
      channelStateName({
        channel_id: "1",
        state: { state_name: "NegotiatingFunding" },
      } as Channel),
    ).toBe("NegotiatingFunding");
  });

  it("detects readiness", () => {
    expect(
      isChannelReady({ channel_id: "1", state: "ChannelReady" } as Channel),
    ).toBe(true);
    expect(
      isChannelReady({
        channel_id: "1",
        state: "NegotiatingFunding",
      } as Channel),
    ).toBe(false);
  });

  it("parses structured state flags", () => {
    expect(
      channelStateFlags({
        channel_id: "1",
        state: {
          state_name: "Closed",
          state_flags: "UNCOOPERATIVE_LOCAL|WAITING_ONCHAIN_SETTLEMENT",
        },
      } as Channel),
    ).toEqual(["UNCOOPERATIVE_LOCAL", "WAITING_ONCHAIN_SETTLEMENT"]);
  });
});

describe("ckbToShannonHex", () => {
  it("converts whole CKB to shannons hex", () => {
    expect(ckbToShannonHex(500)).toBe("0xba43b7400");
    expect(ckbToShannonHex(1)).toBe("0x5f5e100");
  });
});

describe("peer address helpers", () => {
  it("extracts the PeerId from announced addresses", () => {
    const info: NodeInfo = {
      pubkey: "0xab",
      chain_hash: "0xcd",
      node_name: null,
      addresses: [
        "/ip4/0.0.0.0/tcp/8228/p2p/QmPeer",
        "/ip4/0.0.0.0/tcp/8228/ws/p2p/QmPeer",
      ],
    };
    expect(peerIdOf(info)).toBe("QmPeer");
    expect(peerIdOf({ ...info, addresses: [] })).toBeUndefined();
  });

  it("builds a dialable multiaddr from ip + peer id", () => {
    expect(dialAddress("172.30.0.12", "QmPeer")).toBe(
      "/ip4/172.30.0.12/tcp/8228/p2p/QmPeer",
    );
  });
});

describe("amount + payment helpers", () => {
  it("converts shannons hex back to whole CKB", () => {
    expect(shannonHexToCkb("0xba43b7400")).toBe(500);
    expect(shannonHexToCkb("0x0")).toBe(0);
    expect(shannonHexToCkb(undefined)).toBe(0);
  });

  it("recognizes settled payment states", () => {
    expect(isPaymentSettled("Success")).toBe(true);
    expect(isPaymentSettled("Failed")).toBe(true);
    expect(isPaymentSettled("Inflight")).toBe(false);
    expect(isPaymentSettled("Created")).toBe(false);
  });
});
