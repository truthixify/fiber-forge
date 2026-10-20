import { afterEach, describe, expect, it, vi } from "vitest";
import { DevChain } from "../src/ckb";

// Address derivation is deterministic and offline — a deliberately unreachable URL proves it does
// not touch the chain. Block generation, funding, and balance are exercised by the live E2E.
describe("DevChain.addressOfPrivateKey", () => {
  const chain = new DevChain("http://127.0.0.1:1");

  it("derives the deployer address", async () => {
    expect(
      await chain.addressOfPrivateKey(
        "0xd00c06bfd800d27397002dca6fb0993d5ba6399b4238b2f29ee9deb97593d2bc",
      ),
    ).toBe(
      "ckt1qzda0cr08m85hc8jlnfp3zer7xulejywt49kt2rr0vthywaa50xwsqwgx292hnvmn68xf779vmzrshpmm6epn4c0cgwga",
    );
  });

  it("derives a node's wallet address from its private key", async () => {
    expect(
      await chain.addressOfPrivateKey(
        "0xcccd5f7e693b60447623fb71a5983f15a426938c33699b1a81d1239cfa656cd1",
      ),
    ).toBe(
      "ckt1qzda0cr08m85hc8jlnfp3zer7xulejywt49kt2rr0vthywaa50xwsqgx5lf4pczpamsfam48evs0c8nvwqqa59qapt46f",
    );
  });
});

describe("DevChain.waitReady", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("honors its deadline when an RPC request never answers", async () => {
    let aborted = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string | URL | Request, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => {
              aborted = true;
              reject(init.signal?.reason);
            });
          }),
      ),
    );

    await expect(
      new DevChain("http://127.0.0.1:8114").waitReady(25),
    ).rejects.toThrow("did not become ready in 25ms");
    expect(aborted).toBe(true);
  });
});

describe("DevChain.transactionStatus", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("normalizes committed CKB transaction metadata", async () => {
    const fetchMock = vi.fn(
      async (_url: string | URL | Request, init?: RequestInit) => {
        expect(JSON.parse(String(init?.body))).toMatchObject({
          method: "get_transaction",
          params: ["0xtx", "0x1"],
        });
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            result: {
              tx_status: {
                status: "committed",
                block_hash: "0xblock",
                block_number: "0x2a",
                reason: null,
              },
            },
          }),
          { status: 200 },
        );
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      new DevChain("http://127.0.0.1:8114").transactionStatus("0xtx"),
    ).resolves.toEqual({
      status: "committed",
      blockHash: "0xblock",
      blockNumber: 42,
      reason: null,
    });
  });

  it("reports an unknown transaction without dropping its caller-owned hash", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: null })),
      ),
    );
    await expect(
      new DevChain("http://127.0.0.1:8114").transactionStatus("0xmissing"),
    ).resolves.toEqual({
      status: "unknown",
      blockHash: null,
      blockNumber: null,
      reason: null,
    });
  });
});
