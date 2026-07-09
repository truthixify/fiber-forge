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

/** The `simple_udt` type-script code hash (its binary is baked into the dev-chain genesis). */
export const SIMPLE_UDT_CODE_HASH =
  "0xe1e354d6d643ad42724d40967e334984534e0367405c5ae42a9d7d63d77df419";

/** A CKB type script in the shape fnn's config and RPC expect (snake_case, string fields). */
export interface UdtScript {
  code_hash: string;
  hash_type: string;
  args: string;
}

/** An out point identifying the on-chain cell a script's code lives in. */
export interface OutPoint {
  txHash: string;
  index: number;
}

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
  private udtOutpoint?: OutPoint;
  private depGroupTxHash?: string;

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

  /** The current tip block number. */
  async tipBlock(): Promise<number> {
    return Number(await rawRpc(this.rpcUrl, "get_tip_block_number", []));
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
    this.depGroupTxHash = depGroupTxHash;
    const cellbase = genesis.transactions[0];
    for (let i = 0; i < cellbase.outputsData.length; i += 1) {
      if (ccc.hashCkb(cellbase.outputsData[i]) === SIMPLE_UDT_CODE_HASH) {
        this.udtOutpoint = { txHash: cellbase.hash(), index: i };
        break;
      }
    }
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

  /** The out point of the `simple_udt` code cell in genesis (fnn needs it as a cell dep). */
  async udtDep(): Promise<OutPoint> {
    await this.ensureDevScripts();
    if (!this.udtOutpoint) {
      throw new Error("simple_udt not found in the dev chain genesis");
    }
    return this.udtOutpoint;
  }

  /** The deployer's lock-script hash — the owner of every UDT this dev chain issues. */
  async udtOwnerLockHash(): Promise<string> {
    const signer = new ccc.SignerCkbPrivateKey(
      this.client,
      DEPLOYER_PRIVATE_KEY,
    );
    const script = (
      await ccc.Address.fromString(
        await signer.getRecommendedAddress(),
        this.client,
      )
    ).script;
    return script.hash();
  }

  /** The `simple_udt` type script owned by the deployer, in fnn's config/RPC shape. */
  async udtScript(): Promise<UdtScript> {
    return {
      code_hash: SIMPLE_UDT_CODE_HASH,
      hash_type: "data1",
      args: await this.udtOwnerLockHash(),
    };
  }

  /** A throwaway client (with the devnet secp dep override) so retries never reuse a stale cell cache. */
  private freshDeployerContext(): {
    client: ccc.ClientPublicTestnet;
    signer: ccc.SignerCkbPrivateKey;
  } {
    const client = new ccc.ClientPublicTestnet({ url: this.rpcUrl });
    const depGroupTxHash = this.depGroupTxHash!;
    const original = client.getKnownScript.bind(client);
    client.getKnownScript = async (script) => {
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
    return {
      client,
      signer: new ccc.SignerCkbPrivateKey(client, DEPLOYER_PRIVATE_KEY),
    };
  }

  /**
   * Mint `amount` base units of the dev UDT into `address`, returning once the recipient's balance
   * has actually risen by that amount. Right after `up`, the deployer's cells are still settling, so
   * an issuance can be accepted then silently evicted — checking the tx status alone gives false
   * positives. Each attempt mines to settle prior txs, builds against a fresh client (no stale cell
   * cache), and only succeeds once the on-chain balance confirms the mint landed.
   */
  async issueUdt(
    address: string,
    amount: bigint,
    attempts = 10,
  ): Promise<string> {
    const dep = await this.udtDep();
    const udtType = ccc.Script.from({
      codeHash: SIMPLE_UDT_CODE_HASH,
      hashType: "data1",
      args: await this.udtOwnerLockHash(),
    });
    const start = await this.udtBalanceOf(address);
    let lastError: unknown = new Error(`udt issuance to ${address} did not land`);
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        await this.generateBlocks(2);
        const { client, signer } = this.freshDeployerContext();
        const to = await ccc.Address.fromString(address, client);
        const tx = ccc.Transaction.from({
          outputs: [
            { lock: to.script, type: udtType, capacity: ccc.fixedPointFrom(200) },
          ],
          outputsData: [ccc.hexFrom(ccc.numLeToBytes(amount, 16))],
        });
        tx.cellDeps.push(
          ccc.CellDep.from({
            outPoint: { txHash: dep.txHash, index: dep.index },
            depType: "code",
          }),
        );
        await tx.completeInputsByCapacity(signer);
        await tx.completeFeeBy(signer, 1000);
        const hash = await signer.sendTransaction(tx);
        for (let block = 0; block < 10; block += 1) {
          await this.generateBlocks(1);
          if ((await this.udtBalanceOf(address)) >= start + amount) {
            return hash;
          }
        }
      } catch (error) {
        lastError = error;
      }
      await sleep(500);
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  /** Total dev-UDT base units held by `address`. A fresh client avoids a stale cell cache. */
  async udtBalanceOf(address: string): Promise<bigint> {
    const client = new ccc.ClientPublicTestnet({ url: this.rpcUrl });
    const lock = (await ccc.Address.fromString(address, client)).script;
    let total = 0n;
    for await (const cell of client.findCellsByLock(lock)) {
      if (cell.cellOutput.type?.codeHash === SIMPLE_UDT_CODE_HASH) {
        total += ccc.numLeFromBytes(
          ccc.bytesFrom(cell.outputData).slice(0, 16),
        );
      }
    }
    return total;
  }
}
