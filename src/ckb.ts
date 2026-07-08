/**
 * The CKB dev chain: readiness, on-demand block generation, and funding node wallets from the
 * genesis deployer key. Funding builds a transfer with `@ckb-ccc/core`, overriding the
 * secp256k1 cell dep to the devnet genesis dep group (CCC's built-in dep is testnet's). This flow
 * is proven live: it funds a node's address to a spendable balance.
 */

import { ccc } from "@ckb-ccc/core";

/**
 * The dev-chain genesis deployer/treasury key (a public test key). It holds the genesis issuance
 * and is the block assembler, so it funds every node. See `docs/devnet-recipe.md`.
 */
export const DEPLOYER_PRIVATE_KEY =
  "0xd00c06bfd800d27397002dca6fb0993d5ba6399b4238b2f29ee9deb97593d2bc";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function rawRpc(
  url: string,
  method: string,
  params: unknown[],
): Promise<unknown> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: 1, jsonrpc: "2.0", method, params }),
  });
  const body = (await response.json()) as { result?: unknown; error?: unknown };
  if (body.error !== undefined && body.error !== null) {
    throw new Error(`${method}: ${JSON.stringify(body.error)}`);
  }
  return body.result;
}

export class DevChain {
  private readonly client: ccc.ClientPublicTestnet;
  private devScriptsReady = false;

  constructor(private readonly rpcUrl: string) {
    this.client = new ccc.ClientPublicTestnet({ url: rpcUrl });
  }

  /** Wait until the chain answers `get_tip_block_number`. */
  async waitReady(timeoutMs = 60_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      try {
        if (await rawRpc(this.rpcUrl, "get_tip_block_number", [])) {
          return;
        }
      } catch {
        // not up yet
      }
      if (Date.now() > deadline) {
        throw new Error("ckb dev chain did not become ready in time");
      }
      await sleep(500);
    }
  }

  /** Mint `count` blocks on demand (Dummy PoW dev chain). */
  async generateBlocks(count = 1): Promise<void> {
    for (let i = 0; i < count; i += 1) {
      await rawRpc(this.rpcUrl, "generate_block", []);
    }
  }

  /** The secp256k1 CKB address for a raw private key (the node's on-chain wallet). */
  async addressOfPrivateKey(privateKeyHex: string): Promise<string> {
    return new ccc.SignerCkbPrivateKey(
      this.client,
      privateKeyHex,
    ).getRecommendedAddress();
  }

  /** The secp256k1 CKB address for a public key (a node's wallet, derived from its `node_info`). */
  async addressOfPubkey(pubkeyHex: string): Promise<string> {
    const args = ccc.hashCkb(pubkeyHex).slice(0, 42);
    const script = await ccc.Script.fromKnownScript(
      this.client,
      ccc.KnownScript.Secp256k1Blake160,
      args,
    );
    return ccc.Address.fromScript(script, this.client).toString();
  }

  /** Transfer `ckb` whole CKB from the deployer to `address`; returns the funding tx hash. */
  async fund(address: string, ckb: number): Promise<string> {
    await this.ensureDevScripts();
    const signer = new ccc.SignerCkbPrivateKey(
      this.client,
      DEPLOYER_PRIVATE_KEY,
    );
    const to = await ccc.Address.fromString(address, this.client);
    const tx = ccc.Transaction.from({
      outputs: [{ lock: to.script, capacity: ccc.fixedPointFrom(ckb) }],
    });
    await tx.completeInputsByCapacity(signer);
    await tx.completeFeeBy(signer, 1000);
    return signer.sendTransaction(tx);
  }

  /** On-chain balance of an address, in whole CKB. */
  async balanceOf(address: string): Promise<bigint> {
    const lock = (await ccc.Address.fromString(address, this.client)).script;
    let total = 0n;
    for await (const cell of this.client.findCellsByLock(lock)) {
      total += cell.cellOutput.capacity;
    }
    return total / 100_000_000n;
  }

  private async ensureDevScripts(): Promise<void> {
    if (this.devScriptsReady) {
      return;
    }
    const genesis = await this.client.getBlockByNumber(0n);
    if (!genesis) {
      throw new Error("could not read the dev chain genesis block");
    }
    const depGroupTxHash = genesis.transactions[1].hash();
    const original = this.client.getKnownScript.bind(this.client);
    this.client.getKnownScript = async (script) => {
      const info = await original(script);
      if (script === ccc.KnownScript.Secp256k1Blake160) {
        info.cellDeps = [
          ccc.CellDepInfo.from({
            cellDep: {
              outPoint: { txHash: depGroupTxHash, index: 0 },
              depType: "depGroup",
            },
          }),
        ];
      }
      return info;
    };
    this.devScriptsReady = true;
  }
}
