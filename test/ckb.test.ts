import { describe, expect, it } from "vitest";
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
