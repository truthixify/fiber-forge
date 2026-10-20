/** Two-direction, secret-safe proof of the local Fiber/CCH/Lightning value path. */

import { randomBytes } from "node:crypto";
import {
  type CchOrder,
  type CchOrderStatus,
  type CchTransferClient,
} from "./cch.js";
import { type UdtScript } from "./ckb.js";
import { ForgeError } from "./errors.js";
import {
  type LightningBackendController,
  type LightningBackendPlan,
  type LightningBackendStatus,
} from "./lightning.js";
import {
  type Channel,
  FnnRpc,
  channelStateName,
  isChannelReady,
} from "./rpc.js";

export const DEFAULT_CCH_PROOF_TIMEOUT_MS = 2 * 60_000;
export const DEFAULT_CCH_SEND_SATS = 100_000;
export const DEFAULT_CCH_RECEIVE_SATS = 50_000;

export interface CchProofOptions {
  sendSats?: number;
  receiveSats?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
}

export interface CchBalanceChange {
  before: string;
  after: string;
  delta: string;
}

export interface CchOrderTransition {
  status: CchOrderStatus;
  elapsedMs: number;
}

export interface CchTransferFlowReport {
  direction: "fiber-to-lightning" | "lightning-to-fiber";
  paymentHash: string;
  deliveredAmountSats: string;
  incomingAmountSats: string;
  cchFeeSats: string;
  routingFeeSats: string;
  terminalOrderStatus: "Success";
  orderTransitions: CchOrderTransition[];
  durationMs: number;
  fiber: {
    asset: "simple_udt";
    unit: "base_units";
    user: CchBalanceChange;
    hub: CchBalanceChange;
    paymentStatus: "Success" | null;
  };
  lightning: {
    asset: "regtest_btc";
    unit: "satoshis";
    user: CchBalanceChange;
    hub: CchBalanceChange;
    invoiceState: "SETTLED" | null;
    paymentStatus: "SUCCEEDED" | null;
  };
}

export interface CchTransferProofReport {
  schemaVersion: 1;
  kind: "cch-transfer-proof";
  net: string;
  result: "passed";
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  boundaryChecks: {
    ckbDevChain: "passed";
    bitcoinRegtest: "passed";
    fiber: "passed";
    cch: "passed";
    lightning: "passed";
  };
  chains: {
    ckb: { network: "devnet"; blockHeight: number };
    bitcoin: { network: "regtest"; blockHeight: number };
  };
  flows: [CchTransferFlowReport, CchTransferFlowReport];
  trust: {
    scope: "local-development-only";
    rate: "1 wrapped base unit = 1 regtest satoshi";
    operatorTrusted: true;
    reserveProof: false;
    mainnetFunds: false;
  };
}

export interface CchProofDependencies {
  net: string;
  wrappedTypeScript: UdtScript;
  wrappedChannelBaseUnits: string;
  ckbBlockHeight: number;
  cch: CchTransferClient;
  lightning: LightningBackendController;
  lightningPlan: LightningBackendPlan;
  user: { name: string; pubkey: string; rpc: FnnRpc };
  hub: { name: string; pubkey: string; rpc: FnnRpc };
}

interface FiberBalances {
  channelId: string;
  user: bigint;
  hub: bigint;
}

interface LightningBalances {
  user: bigint;
  hub: bigint;
  blockHeight: number;
}

class ProofGuard {
  readonly started = Date.now();
  private readonly deadline: number;

  constructor(
    private readonly net: string,
    private readonly timeoutMs: number,
    private readonly signal?: AbortSignal,
  ) {
    this.deadline = this.started + timeoutMs;
  }

  get abortSignal(): AbortSignal | undefined {
    return this.signal;
  }

  check(resource: string): void {
    if (this.signal?.aborted) {
      throw new ForgeError(
        "OPERATION_ABORTED",
        `CCH transfer proof for "${this.net}" was aborted at ${resource}`,
        {
          resource,
          action: "retry with a fresh AbortSignal against a ready CCH topology",
          cause: this.signal.reason,
        },
      );
    }
    if (Date.now() >= this.deadline) {
      throw new ForgeError(
        "OPERATION_TIMEOUT",
        `CCH transfer proof for "${this.net}" exceeded its ${this.timeoutMs}ms timeout at ${resource}`,
        {
          resource,
          action:
            "inspect the sanitized CCH evidence and retry without weakening settlement checks",
        },
      );
    }
  }

  async wait(resource: string, delayMs = 250): Promise<void> {
    this.check(resource);
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        clearTimeout(timer);
        reject(
          new ForgeError(
            "OPERATION_ABORTED",
            `CCH transfer proof for "${this.net}" was aborted at ${resource}`,
            { resource, action: "retry with a fresh AbortSignal" },
          ),
        );
      };
      const timer = setTimeout(() => {
        this.signal?.removeEventListener("abort", onAbort);
        resolve();
      }, delayMs);
      this.signal?.addEventListener("abort", onAbort, { once: true });
    });
    this.check(resource);
  }
}

export async function runCchTransferProof(
  dependencies: CchProofDependencies,
  options: CchProofOptions = {},
): Promise<CchTransferProofReport> {
  const sendSats = positiveAmount(
    options.sendSats ?? DEFAULT_CCH_SEND_SATS,
    "sendSats",
  );
  const receiveSats = positiveAmount(
    options.receiveSats ?? DEFAULT_CCH_RECEIVE_SATS,
    "receiveSats",
  );
  const timeoutMs = options.timeoutMs ?? DEFAULT_CCH_PROOF_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new ForgeError(
      "INVALID_TIMEOUT",
      "CCH proof timeout must be positive",
      {
        resource: "CchProofOptions.timeoutMs",
        action: "provide a positive timeout in milliseconds",
      },
    );
  }
  const guard = new ProofGuard(dependencies.net, timeoutMs, options.signal);
  const startedAt = new Date(guard.started).toISOString();
  const progress = options.onProgress ?? (() => {});

  try {
    const initialFiber = await readFiberBalances(dependencies, guard);
    const initialLightning = await readLightningBalances(dependencies, guard);
    assertProof(dependencies.ckbBlockHeight > 0, "CKB dev chain readiness");
    assertProof(
      initialLightning.blockHeight >= 113,
      "Bitcoin regtest readiness",
    );
    assertProof(
      initialFiber.user >= BigInt(sendSats),
      "Fiber user outgoing liquidity",
    );
    const reverseIncoming = BigInt(receiveSats) + expectedCchFee(receiveSats);
    assertProof(
      initialLightning.user + BigInt(sendSats) >= reverseIncoming,
      "Lightning user reverse liquidity after the first flow",
    );
    assertProof(
      initialFiber.hub + BigInt(sendSats) + expectedCchFee(sendSats) >=
        BigInt(receiveSats),
      "Fiber hub reverse liquidity after the first flow",
    );

    const first = await proveFiberToLightning(
      dependencies,
      guard,
      initialFiber,
      initialLightning,
      sendSats,
      progress,
    );
    const secondFiber = {
      channelId: initialFiber.channelId,
      user: BigInt(first.fiber.user.after),
      hub: BigInt(first.fiber.hub.after),
    };
    const secondLightning = {
      user: BigInt(first.lightning.user.after),
      hub: BigInt(first.lightning.hub.after),
      blockHeight: initialLightning.blockHeight,
    };
    const second = await proveLightningToFiber(
      dependencies,
      guard,
      secondFiber,
      secondLightning,
      receiveSats,
      progress,
    );
    const finished = Date.now();
    return {
      schemaVersion: 1,
      kind: "cch-transfer-proof",
      net: dependencies.net,
      result: "passed",
      startedAt,
      finishedAt: new Date(finished).toISOString(),
      durationMs: finished - guard.started,
      boundaryChecks: {
        ckbDevChain: "passed",
        bitcoinRegtest: "passed",
        fiber: "passed",
        cch: "passed",
        lightning: "passed",
      },
      chains: {
        ckb: { network: "devnet", blockHeight: dependencies.ckbBlockHeight },
        bitcoin: {
          network: "regtest",
          blockHeight: initialLightning.blockHeight,
        },
      },
      flows: [first, second],
      trust: {
        scope: "local-development-only",
        rate: "1 wrapped base unit = 1 regtest satoshi",
        operatorTrusted: true,
        reserveProof: false,
        mainnetFunds: false,
      },
    };
  } catch (error) {
    if (error instanceof ForgeError) throw error;
    throw new ForgeError(
      "CCH_TRANSFER_FAILED",
      `CCH transfer proof for "${dependencies.net}" failed before final settlement`,
      {
        resource: dependencies.net,
        action:
          "inspect the sanitized evidence and retry from a clean CCH topology",
        cause: error,
      },
    );
  }
}

async function proveFiberToLightning(
  dependencies: CchProofDependencies,
  guard: ProofGuard,
  fiberBefore: FiberBalances,
  lightningBefore: LightningBalances,
  deliveredSats: number,
  progress: (message: string) => void,
): Promise<CchTransferFlowReport> {
  const started = Date.now();
  const backend = dependencies.lightning;
  const invoice = await backend.createUserInvoice(
    dependencies.lightningPlan,
    deliveredSats,
    guard.abortSignal,
  );
  guard.check("fiber-to-lightning quote");
  const initialOrder = await dependencies.cch.sendBtc(invoice.paymentRequest);
  assertOrder(initialOrder, dependencies.wrappedTypeScript);
  assertProof(
    initialOrder.paymentHash === invoice.paymentHash,
    "CCH/Lightning payment hash",
  );
  assertProof(
    "Fiber" in initialOrder.incomingInvoice,
    "Fiber incoming invoice",
  );
  const fee = expectedCchFee(deliveredSats);
  const incoming = BigInt(deliveredSats) + fee;
  assertProof(BigInt(initialOrder.amountSats) === incoming, "CCH send amount");
  assertProof(BigInt(initialOrder.feeSats) === fee, "CCH send fee");
  progress("cch proof fiber-to-lightning accepted");

  const sent = await dependencies.user.rpc.sendPayment(
    initialOrder.incomingInvoice.Fiber,
  );
  assertProof(
    normalizeHash(sent.payment_hash) === initialOrder.paymentHash,
    "Fiber payment hash",
  );
  const transitions = [transition(initialOrder.status, started)];
  const terminal = await waitForOrder(
    dependencies.cch,
    initialOrder,
    transitions,
    started,
    guard,
    "fiber-to-lightning settlement",
  );
  const fiberPaymentStatus = await waitForFiberPayment(
    dependencies.user.rpc,
    terminal.paymentHash,
    guard,
  );
  const lightningInvoice = await waitForLightningInvoice(
    backend,
    dependencies.lightningPlan,
    terminal.paymentHash,
    guard,
  );
  assertProof(
    lightningInvoice.amountPaidSats === deliveredSats,
    "Lightning delivered amount",
  );

  const fiberAfter = await waitForFiberBalances(
    dependencies,
    {
      channelId: fiberBefore.channelId,
      user: fiberBefore.user - incoming,
      hub: fiberBefore.hub + incoming,
    },
    guard,
  );
  const lightningAfter = await waitForLightningBalances(
    dependencies,
    {
      user: lightningBefore.user + BigInt(deliveredSats),
      hub: lightningBefore.hub - BigInt(deliveredSats),
    },
    guard,
  );
  progress("cch proof fiber-to-lightning settled");

  return flowReport({
    direction: "fiber-to-lightning",
    order: terminal,
    deliveredSats: BigInt(deliveredSats),
    incomingSats: incoming,
    routingFeeSats: 0n,
    transitions,
    started,
    fiberBefore,
    fiberAfter,
    lightningBefore,
    lightningAfter,
    fiberPaymentStatus,
    lightningInvoiceState: "SETTLED",
    lightningPaymentStatus: null,
  });
}

async function proveLightningToFiber(
  dependencies: CchProofDependencies,
  guard: ProofGuard,
  fiberBefore: FiberBalances,
  lightningBefore: LightningBalances,
  deliveredSats: number,
  progress: (message: string) => void,
): Promise<CchTransferFlowReport> {
  const started = Date.now();
  const preimage = `0x${randomBytes(32).toString("hex")}`;
  const created = await dependencies.user.rpc.newInvoice({
    amount: `0x${BigInt(deliveredSats).toString(16)}`,
    description: "Fiber Forge CCH proof",
    udtTypeScript: dependencies.wrappedTypeScript,
    hashAlgorithm: "sha256",
    paymentPreimage: preimage,
  });
  const paymentHash = normalizeHash(created.invoice?.data?.payment_hash);
  assertProof(paymentHash !== null, "Fiber invoice payment hash");
  guard.check("lightning-to-fiber quote");
  const initialOrder = await dependencies.cch.receiveBtc(
    created.invoice_address,
  );
  assertOrder(initialOrder, dependencies.wrappedTypeScript);
  assertProof(
    initialOrder.paymentHash === paymentHash,
    "CCH/Fiber payment hash",
  );
  assertProof(
    "Lightning" in initialOrder.incomingInvoice,
    "Lightning incoming invoice",
  );
  const fee = expectedCchFee(deliveredSats);
  const incoming = BigInt(deliveredSats) + fee;
  assertProof(
    BigInt(initialOrder.amountSats) === BigInt(deliveredSats),
    "CCH receive amount",
  );
  assertProof(BigInt(initialOrder.feeSats) === fee, "CCH receive fee");
  progress("cch proof lightning-to-fiber accepted");

  const payment = await dependencies.lightning.payFromUser(
    dependencies.lightningPlan,
    initialOrder.incomingInvoice.Lightning,
    initialOrder.paymentHash,
    guard.abortSignal,
  );
  assertProof(
    payment.paymentHash === initialOrder.paymentHash,
    "Lightning payment hash",
  );
  assertProof(
    payment.status === "SUCCEEDED",
    "Lightning terminal payment state",
  );
  assertProof(
    BigInt(payment.valueSats) === incoming,
    "Lightning incoming amount",
  );
  const transitions = [transition(initialOrder.status, started)];
  const terminal = await waitForOrder(
    dependencies.cch,
    initialOrder,
    transitions,
    started,
    guard,
    "lightning-to-fiber settlement",
  );
  const routeFee = BigInt(payment.feeSats);
  const fiberAfter = await waitForFiberBalances(
    dependencies,
    {
      channelId: fiberBefore.channelId,
      user: fiberBefore.user + BigInt(deliveredSats),
      hub: fiberBefore.hub - BigInt(deliveredSats),
    },
    guard,
  );
  const lightningAfter = await waitForLightningBalances(
    dependencies,
    {
      user: lightningBefore.user - incoming - routeFee,
      hub: lightningBefore.hub + incoming,
    },
    guard,
  );
  progress("cch proof lightning-to-fiber settled");

  return flowReport({
    direction: "lightning-to-fiber",
    order: terminal,
    deliveredSats: BigInt(deliveredSats),
    incomingSats: incoming,
    routingFeeSats: routeFee,
    transitions,
    started,
    fiberBefore,
    fiberAfter,
    lightningBefore,
    lightningAfter,
    fiberPaymentStatus: null,
    lightningInvoiceState: null,
    lightningPaymentStatus: "SUCCEEDED",
  });
}

async function waitForOrder(
  cch: CchTransferClient,
  initial: CchOrder,
  transitions: CchOrderTransition[],
  started: number,
  guard: ProofGuard,
  resource: string,
): Promise<CchOrder & { status: "Success" }> {
  let order = initial;
  for (;;) {
    assertSameOrder(initial, order);
    appendTransition(transitions, order.status, started);
    if (order.status === "Success")
      return order as CchOrder & { status: "Success" };
    if (order.status === "Failed") {
      throw new ForgeError(
        "CCH_TRANSFER_FAILED",
        `${resource} reached Failed`,
        {
          resource,
          action:
            "inspect the sanitized order transitions and retry from clean state",
        },
      );
    }
    await guard.wait(resource);
    order = await cch.getOrder(initial.paymentHash);
  }
}

async function waitForFiberPayment(
  rpc: FnnRpc,
  paymentHash: string,
  guard: ProofGuard,
): Promise<"Success"> {
  for (;;) {
    const { status } = await rpc.getPayment(paymentHash);
    if (status === "Success") return "Success";
    if (status === "Failed") {
      throw new ForgeError(
        "CCH_TRANSFER_FAILED",
        "Fiber payment reached Failed",
        {
          resource: "fiber-to-lightning payment",
          action: "inspect the Fiber route and CCH order transitions",
        },
      );
    }
    await guard.wait("Fiber payment settlement");
  }
}

async function waitForLightningInvoice(
  backend: LightningBackendController,
  plan: LightningBackendPlan,
  paymentHash: string,
  guard: ProofGuard,
) {
  for (;;) {
    const invoice = await backend.userInvoice(
      plan,
      paymentHash,
      guard.abortSignal,
    );
    if (invoice.state === "SETTLED") return invoice;
    if (invoice.state === "CANCELED") {
      throw new ForgeError(
        "CCH_TRANSFER_FAILED",
        "Lightning invoice was canceled",
        {
          resource: "fiber-to-lightning invoice",
          action: "inspect the CCH order transitions",
        },
      );
    }
    await guard.wait("Lightning invoice settlement");
  }
}

async function readFiberBalances(
  dependencies: CchProofDependencies,
  guard: ProofGuard,
): Promise<FiberBalances> {
  guard.check("Fiber balance inspection");
  const [userChannels, hubChannels] = await Promise.all([
    dependencies.user.rpc.listChannels(dependencies.hub.pubkey),
    dependencies.hub.rpc.listChannels(dependencies.user.pubkey),
  ]);
  const userChannel = matchingChannel(
    userChannels,
    dependencies.wrappedTypeScript,
    dependencies.wrappedChannelBaseUnits,
  );
  const hubChannel = matchingChannel(
    hubChannels,
    dependencies.wrappedTypeScript,
    dependencies.wrappedChannelBaseUnits,
  );
  assertProof(
    Boolean(userChannel && hubChannel),
    "wrapped Fiber channel readiness",
  );
  assertProof(
    userChannel!.channel_id === hubChannel!.channel_id,
    "wrapped channel identity",
  );
  const user = channelAmount(userChannel!.local_balance, "Fiber user balance");
  const hub = channelAmount(hubChannel!.local_balance, "Fiber hub balance");
  assertProof(
    user ===
      channelAmount(hubChannel!.remote_balance, "Fiber hub remote balance") &&
      hub ===
        channelAmount(userChannel!.remote_balance, "Fiber user remote balance"),
    "Fiber channel balance agreement",
  );
  return { channelId: userChannel!.channel_id, user, hub };
}

async function readLightningBalances(
  dependencies: CchProofDependencies,
  guard: ProofGuard,
): Promise<LightningBalances> {
  guard.check("Lightning balance inspection");
  const status = await dependencies.lightning.status(
    dependencies.lightningPlan,
  );
  assertProof(
    status.state === "ready" && status.channel !== null,
    "Lightning backend readiness",
  );
  assertProof(status.bitcoin.blockHeight !== null, "Bitcoin regtest height");
  return lightningBalances(status);
}

async function waitForFiberBalances(
  dependencies: CchProofDependencies,
  expected: FiberBalances,
  guard: ProofGuard,
): Promise<FiberBalances> {
  for (;;) {
    const observed = await readFiberBalances(dependencies, guard);
    assertProof(
      observed.channelId === expected.channelId,
      "wrapped channel continuity",
    );
    if (observed.user === expected.user && observed.hub === expected.hub)
      return observed;
    await guard.wait("Fiber balance reconciliation");
  }
}

async function waitForLightningBalances(
  dependencies: CchProofDependencies,
  expected: Pick<LightningBalances, "user" | "hub">,
  guard: ProofGuard,
): Promise<LightningBalances> {
  for (;;) {
    const observed = await readLightningBalances(dependencies, guard);
    if (observed.user === expected.user && observed.hub === expected.hub)
      return observed;
    await guard.wait("Lightning balance reconciliation");
  }
}

function lightningBalances(status: LightningBackendStatus): LightningBalances {
  const channel = status.channel!;
  return {
    user: BigInt(channel.userLocalSats),
    hub: BigInt(channel.hubLocalSats),
    blockHeight: status.bitcoin.blockHeight!,
  };
}

function matchingChannel(
  channels: Channel[],
  script: UdtScript,
  capacity: string,
): Channel | undefined {
  return channels.find(
    (channel) =>
      isChannelReady(channel) &&
      channelStateName(channel) === "ChannelReady" &&
      scriptsEqual(channel.funding_udt_type_script, script) &&
      channelAmount(channel.local_balance, "wrapped local balance") +
        channelAmount(channel.remote_balance, "wrapped remote balance") ===
        BigInt(capacity),
  );
}

function flowReport(input: {
  direction: CchTransferFlowReport["direction"];
  order: CchOrder & { status: "Success" };
  deliveredSats: bigint;
  incomingSats: bigint;
  routingFeeSats: bigint;
  transitions: CchOrderTransition[];
  started: number;
  fiberBefore: FiberBalances;
  fiberAfter: FiberBalances;
  lightningBefore: LightningBalances;
  lightningAfter: LightningBalances;
  fiberPaymentStatus: "Success" | null;
  lightningInvoiceState: "SETTLED" | null;
  lightningPaymentStatus: "SUCCEEDED" | null;
}): CchTransferFlowReport {
  return {
    direction: input.direction,
    paymentHash: input.order.paymentHash,
    deliveredAmountSats: input.deliveredSats.toString(),
    incomingAmountSats: input.incomingSats.toString(),
    cchFeeSats: BigInt(input.order.feeSats).toString(),
    routingFeeSats: input.routingFeeSats.toString(),
    terminalOrderStatus: "Success",
    orderTransitions: input.transitions,
    durationMs: Date.now() - input.started,
    fiber: {
      asset: "simple_udt",
      unit: "base_units",
      user: balanceChange(input.fiberBefore.user, input.fiberAfter.user),
      hub: balanceChange(input.fiberBefore.hub, input.fiberAfter.hub),
      paymentStatus: input.fiberPaymentStatus,
    },
    lightning: {
      asset: "regtest_btc",
      unit: "satoshis",
      user: balanceChange(
        input.lightningBefore.user,
        input.lightningAfter.user,
      ),
      hub: balanceChange(input.lightningBefore.hub, input.lightningAfter.hub),
      invoiceState: input.lightningInvoiceState,
      paymentStatus: input.lightningPaymentStatus,
    },
  };
}

function balanceChange(before: bigint, after: bigint): CchBalanceChange {
  return {
    before: before.toString(),
    after: after.toString(),
    delta: (after - before).toString(),
  };
}

function transition(
  status: CchOrderStatus,
  started: number,
): CchOrderTransition {
  return { status, elapsedMs: Date.now() - started };
}

function appendTransition(
  transitions: CchOrderTransition[],
  status: CchOrderStatus,
  started: number,
): void {
  if (transitions.at(-1)?.status !== status) {
    transitions.push({ status, elapsedMs: Date.now() - started });
  }
}

function assertOrder(order: CchOrder, script: UdtScript): void {
  assertProof(
    scriptsEqual(order.wrappedTypeScript, script),
    "wrapped type script",
  );
  assertProof(normalizeHash(order.paymentHash) !== null, "CCH payment hash");
}

function assertSameOrder(expected: CchOrder, observed: CchOrder): void {
  assertProof(
    observed.paymentHash === expected.paymentHash,
    "CCH order payment hash continuity",
  );
  assertProof(
    observed.amountSats === expected.amountSats,
    "CCH order amount continuity",
  );
  assertProof(
    observed.feeSats === expected.feeSats,
    "CCH order fee continuity",
  );
  assertProof(
    scriptsEqual(observed.wrappedTypeScript, expected.wrappedTypeScript),
    "CCH order asset continuity",
  );
}

function expectedCchFee(amountSats: number): bigint {
  return BigInt(amountSats) / 1_000_000n;
}

function positiveAmount(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new ForgeError(
      "CCH_TRANSFER_FAILED",
      `${field} must be a positive safe integer`,
      {
        resource: field,
        action: "provide an exact positive satoshi amount",
      },
    );
  }
  return value;
}

function channelAmount(value: string | undefined, field: string): bigint {
  if (!value || !/^0x[0-9a-fA-F]+$/.test(value)) {
    throw new ForgeError("CCH_TRANSFER_FAILED", `${field} is malformed`, {
      resource: field,
      action: "verify the pinned Fiber image and recreate the topology",
    });
  }
  return BigInt(value);
}

function normalizeHash(value: unknown): string | null {
  return typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value)
    ? value.toLowerCase()
    : null;
}

function scriptsEqual(value: unknown, expected: UdtScript): boolean {
  if (typeof value !== "object" || value === null) return false;
  const script = value as Record<string, unknown>;
  return (
    script.code_hash === expected.code_hash &&
    script.hash_type === expected.hash_type &&
    script.args === expected.args
  );
}

function assertProof(condition: unknown, check: string): asserts condition {
  if (!condition) {
    throw new ForgeError("CCH_TRANSFER_FAILED", `${check} did not match`, {
      resource: check,
      action: "inspect the sanitized proof boundary and retry from clean state",
    });
  }
}
