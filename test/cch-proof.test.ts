import { describe, expect, it } from "vitest";
import {
  runCchTransferProof,
  type CchProofDependencies,
} from "../src/cch-proof";
import { type CchOrder, type CchTransferClient } from "../src/cch";
import {
  type LightningBackendController,
  type LightningBackendStatus,
  planLightningBackend,
} from "../src/lightning";
import { FnnRpc, type RpcTransport } from "../src/rpc";

const script = {
  code_hash: `0x${"1".repeat(64)}`,
  hash_type: "data1",
  args: `0x${"2".repeat(64)}`,
};
const firstHash = `0x${"a".repeat(64)}`;
const secondHash = `0x${"b".repeat(64)}`;
const fiberInvoice = "fiber-invoice-private";
const lightningInvoice = "lightning-invoice-private";

function order(
  direction: "send" | "receive",
  status: CchOrder["status"] = "Pending",
): CchOrder {
  return {
    timestamp: "0x1",
    expiryDeltaSeconds: "0xe10",
    wrappedTypeScript: script,
    incomingInvoice:
      direction === "send"
        ? { Fiber: fiberInvoice }
        : { Lightning: lightningInvoice },
    outgoingPayRequest: "private-outgoing-request",
    paymentHash: direction === "send" ? firstHash : secondHash,
    amountSats: direction === "send" ? "0x186a0" : "0xc350",
    feeSats: "0x0",
    status,
  };
}

function fixture(
  options: { failFirst?: boolean; pendingForever?: boolean } = {},
) {
  const balances = {
    fiberUser: 200_000n,
    fiberHub: 0n,
    lightningUser: 0,
    lightningHub: 996_530,
  };
  let activeDirection: "send" | "receive" = "send";
  let capturedInvoiceParams: Record<string, unknown> | undefined;
  const userTransport: RpcTransport = {
    async call(method, params) {
      if (method === "list_channels") {
        return {
          channels: [channel("0xhub", balances.fiberUser, balances.fiberHub)],
        };
      }
      if (method === "send_payment") {
        balances.fiberUser -= 100_000n;
        balances.fiberHub += 100_000n;
        balances.lightningUser += 100_000;
        balances.lightningHub -= 100_000;
        return { payment_hash: firstHash, status: "Inflight" };
      }
      if (method === "get_payment") return { status: "Success" };
      if (method === "new_invoice") {
        capturedInvoiceParams = params[0] as Record<string, unknown>;
        return {
          invoice_address: "fiber-receive-invoice-private",
          invoice: { data: { payment_hash: secondHash } },
        };
      }
      throw new Error(`unexpected user RPC ${method}`);
    },
  };
  const hubTransport: RpcTransport = {
    async call(method) {
      if (method === "list_channels") {
        return {
          channels: [channel("0xuser", balances.fiberHub, balances.fiberUser)],
        };
      }
      throw new Error(`unexpected hub RPC ${method}`);
    },
  };
  const lightningPlan = planLightningBackend(
    "proof-test",
    "forge-proof-test",
    "172.31.9",
  );
  const lightningStatus = (): LightningBackendStatus => ({
    schemaVersion: 1,
    kind: "lightning-backend",
    net: "proof-test",
    state: "ready",
    bitcoin: { container: "running", blockHeight: 113 },
    hub: {
      container: "running",
      syncedToChain: true,
      blockHeight: 113,
      activeChannels: 1,
      localBalanceSats: balances.lightningHub,
    },
    user: {
      container: "running",
      syncedToChain: true,
      blockHeight: 113,
      activeChannels: 1,
      localBalanceSats: balances.lightningUser,
    },
    channel: {
      active: true,
      capacitySats: 1_000_000,
      hubLocalSats: balances.lightningHub,
      userLocalSats: balances.lightningUser,
    },
    dataVolumesPresent: true,
  });
  const lightning: LightningBackendController = {
    start: async () => lightningStatus(),
    status: async () => lightningStatus(),
    createUserInvoice: async () => ({
      paymentRequest: "lightning-send-invoice-private",
      paymentHash: firstHash,
    }),
    userInvoice: async () => ({
      paymentHash: firstHash,
      state: "SETTLED",
      amountPaidSats: 100_000,
    }),
    payFromUser: async () => {
      balances.lightningUser -= 50_000;
      balances.lightningHub += 50_000;
      balances.fiberUser += 50_000n;
      balances.fiberHub -= 50_000n;
      return {
        paymentHash: secondHash,
        status: "SUCCEEDED",
        valueSats: 50_000,
        feeSats: 0,
      };
    },
    down: async () => {},
  };
  const cch: CchTransferClient = {
    ready: async () => true,
    sendBtc: async () => {
      activeDirection = "send";
      return order("send");
    },
    receiveBtc: async () => {
      activeDirection = "receive";
      return order("receive");
    },
    getOrder: async () =>
      order(
        activeDirection,
        options.pendingForever
          ? "Pending"
          : options.failFirst && activeDirection === "send"
            ? "Failed"
            : "Success",
      ),
  };
  const dependencies: CchProofDependencies = {
    net: "proof-test",
    wrappedTypeScript: script,
    wrappedChannelBaseUnits: "200000",
    ckbBlockHeight: 42,
    cch,
    lightning,
    lightningPlan,
    user: { name: "user", pubkey: "0xuser", rpc: new FnnRpc(userTransport) },
    hub: { name: "hub", pubkey: "0xhub", rpc: new FnnRpc(hubTransport) },
  };
  return { dependencies, getInvoiceParams: () => capturedInvoiceParams };
}

function channel(pubkey: string, local: bigint, remote: bigint) {
  return {
    channel_id: "0xwrapped",
    pubkey,
    state: "ChannelReady",
    local_balance: `0x${local.toString(16)}`,
    remote_balance: `0x${remote.toString(16)}`,
    funding_udt_type_script: script,
  };
}

describe("CCH transfer proof", () => {
  it("requires terminal settlement and records exact two-direction deltas", async () => {
    const setup = fixture();
    const report = await runCchTransferProof(setup.dependencies);

    expect(report).toMatchObject({
      result: "passed",
      boundaryChecks: {
        ckbDevChain: "passed",
        bitcoinRegtest: "passed",
        fiber: "passed",
        cch: "passed",
        lightning: "passed",
      },
      chains: {
        ckb: { network: "devnet", blockHeight: 42 },
        bitcoin: { network: "regtest", blockHeight: 113 },
      },
    });
    expect(report.flows).toEqual([
      expect.objectContaining({
        direction: "fiber-to-lightning",
        paymentHash: firstHash,
        deliveredAmountSats: "100000",
        incomingAmountSats: "100000",
        cchFeeSats: "0",
        terminalOrderStatus: "Success",
        fiber: expect.objectContaining({
          user: { before: "200000", after: "100000", delta: "-100000" },
          hub: { before: "0", after: "100000", delta: "100000" },
          paymentStatus: "Success",
        }),
        lightning: expect.objectContaining({
          user: { before: "0", after: "100000", delta: "100000" },
          invoiceState: "SETTLED",
        }),
      }),
      expect.objectContaining({
        direction: "lightning-to-fiber",
        paymentHash: secondHash,
        deliveredAmountSats: "50000",
        incomingAmountSats: "50000",
        cchFeeSats: "0",
        routingFeeSats: "0",
        terminalOrderStatus: "Success",
        fiber: expect.objectContaining({
          user: { before: "100000", after: "150000", delta: "50000" },
          hub: { before: "100000", after: "50000", delta: "-50000" },
        }),
        lightning: expect.objectContaining({
          user: { before: "100000", after: "50000", delta: "-50000" },
          paymentStatus: "SUCCEEDED",
        }),
      }),
    ]);
    expect(report.flows.map((flow) => flow.orderTransitions)).toEqual([
      [
        expect.objectContaining({ status: "Pending" }),
        expect.objectContaining({ status: "Success" }),
      ],
      [
        expect.objectContaining({ status: "Pending" }),
        expect.objectContaining({ status: "Success" }),
      ],
    ]);
    expect(setup.getInvoiceParams()).toMatchObject({
      amount: "0xc350",
      hash_algorithm: "sha256",
      payment_preimage: expect.stringMatching(/^0x[0-9a-f]{64}$/),
      udt_type_script: script,
    });
    const serialized = JSON.stringify(report);
    expect(serialized).not.toMatch(/invoice-private|payment_preimage|pay_req/i);
  });

  it("rejects a terminal Failed order", async () => {
    const setup = fixture({ failFirst: true });
    await expect(runCchTransferProof(setup.dependencies)).rejects.toMatchObject(
      {
        code: "CCH_TRANSFER_FAILED",
        resource: "fiber-to-lightning settlement",
      },
    );
  });

  it("honors cancellation while an order remains pending", async () => {
    const setup = fixture({ pendingForever: true });
    const controller = new AbortController();
    setTimeout(() => controller.abort("test"), 10);
    await expect(
      runCchTransferProof(setup.dependencies, { signal: controller.signal }),
    ).rejects.toMatchObject({ code: "OPERATION_ABORTED" });
  });
});
