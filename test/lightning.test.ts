import { describe, expect, it } from "vitest";
import {
  type ContainerExecOptions,
  type ContainerExecResult,
  type ContainerSpec,
  FakeEngine,
} from "../src/engine";
import {
  CCH_MACAROON_PATH,
  CCH_TLS_CERT_PATH,
  DEFAULT_BITCOIN_IMAGE,
  DEFAULT_LIGHTNING_CHANNEL_SATS,
  DEFAULT_LND_IMAGE,
  LightningBackend,
  bitcoinContainerSpec,
  lndContainerSpec,
  planLightningBackend,
} from "../src/lightning";

const userPublicKey = `02${"1".repeat(64)}`;
const sensitiveChannelPoint = `${"2".repeat(64)}:0`;

function result(
  stdout = "",
  overrides: Partial<ContainerExecResult> = {},
): ContainerExecResult {
  return {
    exitCode: 0,
    stdout,
    stderr: "",
    stdoutTruncated: false,
    stderrTruncated: false,
    ...overrides,
  };
}

function backendFixture(engine = new FakeEngine()) {
  const plan = planLightningBackend("cch-test", "forge-cch-test", "172.31.8");
  const commands: { container: string; command: readonly string[] }[] = [];
  engine.execHandler = async (container, command) => {
    commands.push({ container, command: [...command] });
    const operation = command.find((argument) =>
      [
        "getblockchaininfo",
        "createwallet",
        "getnewaddress",
        "generatetoaddress",
        "sendtoaddress",
        "getinfo",
        "listchannels",
        "newaddress",
        "bakemacaroon",
        "openchannel",
        "addinvoice",
        "lookupinvoice",
        "payinvoice",
        "listpayments",
        "cp",
      ].includes(argument),
    );
    if (operation === "getblockchaininfo") {
      return result(JSON.stringify({ blocks: 113 }));
    }
    if (operation === "createwallet") return result("{}");
    if (operation === "getnewaddress") {
      return result(`bcrt1q${"a".repeat(38)}\n`);
    }
    if (operation === "generatetoaddress") return result("[]");
    if (operation === "sendtoaddress") return result(`${"a".repeat(64)}\n`);
    if (operation === "getinfo") {
      return result(
        JSON.stringify({
          identity_pubkey: userPublicKey,
          block_height: "113",
          synced_to_chain: true,
        }),
      );
    }
    if (operation === "listchannels") {
      const localBalance = container === plan.containers.hub ? "1000000" : "0";
      return result(
        JSON.stringify({
          channels: [
            {
              active: true,
              capacity: String(DEFAULT_LIGHTNING_CHANNEL_SATS),
              local_balance: localBalance,
              remote_pubkey: userPublicKey,
              channel_point: sensitiveChannelPoint,
            },
          ],
        }),
      );
    }
    if (operation === "newaddress") {
      return result(JSON.stringify({ address: `bcrt1q${"b".repeat(38)}` }));
    }
    const proofHash = "3".repeat(64);
    const proofHashBase64 = Buffer.from(proofHash, "hex").toString("base64");
    if (operation === "addinvoice") {
      return result(
        JSON.stringify({
          payment_request: "lnbcrt-sensitive-payment-request",
          r_hash: proofHashBase64,
        }),
      );
    }
    if (operation === "lookupinvoice") {
      return result(
        JSON.stringify({
          r_hash: proofHashBase64,
          state: "SETTLED",
          amt_paid_sat: "100000",
        }),
      );
    }
    if (operation === "payinvoice") return result("{}");
    if (operation === "listpayments") {
      return result(
        JSON.stringify({
          payments: [
            {
              payment_hash: proofHash,
              status: "SUCCEEDED",
              value_sat: "50000",
              fee_sat: "0",
            },
          ],
        }),
      );
    }
    if (
      operation === "bakemacaroon" ||
      operation === "openchannel" ||
      operation === "cp"
    ) {
      return result("{}");
    }
    throw new Error(`unexpected test command: ${command[0] ?? "<empty>"}`);
  };
  return { engine, plan, commands, backend: new LightningBackend(engine) };
}

async function prepareNetwork(
  engine: FakeEngine,
  plan: ReturnType<typeof planLightningBackend>,
) {
  await engine.ensureNetwork(plan.network, plan.subnet, {
    labels: { "fiber-forge": plan.net },
  });
}

class FailingRunEngine extends FakeEngine {
  private runNumber = 0;

  constructor(private readonly failAt: number) {
    super();
  }

  override async run(spec: ContainerSpec): Promise<void> {
    this.runNumber += 1;
    if (this.runNumber === this.failAt) {
      throw new Error(`injected run failure ${this.failAt}`);
    }
    await super.run(spec);
  }
}

describe("Lightning backend planning", () => {
  it("uses private ports, digest-pinned images, and a read-only Bitcoin cookie mount", () => {
    const { plan } = backendFixture();
    const bitcoin = bitcoinContainerSpec(plan);
    const hub = lndContainerSpec(plan, "hub");

    expect(plan.images).toEqual({
      bitcoin: DEFAULT_BITCOIN_IMAGE,
      lnd: DEFAULT_LND_IMAGE,
    });
    expect(plan.images.bitcoin).toMatch(/@sha256:[0-9a-f]{64}$/);
    expect(plan.images.lnd).toMatch(/@sha256:[0-9a-f]{64}$/);
    expect(plan.ips).toEqual({
      bitcoin: "172.31.8.200",
      hub: "172.31.8.201",
      user: "172.31.8.202",
    });
    expect(bitcoin.ports).toBeUndefined();
    expect(hub.ports).toBeUndefined();
    expect(hub.cmd).toContain("--bitcoind.rpccookie=/bitcoin/regtest/.cookie");
    expect(hub.cmd?.join(" ")).not.toMatch(/rpcpass|rpcuser/);
    expect(hub.volumes).toContainEqual({
      source: plan.volumes.bitcoin,
      target: "/bitcoin",
      readOnly: true,
    });
    expect(hub.volumes).toContainEqual({
      source: plan.volumes.cchAuth,
      target: "/cch-auth",
    });
  });

  it("rejects mutable backend image references", () => {
    expect(() =>
      planLightningBackend("x", "forge-x", "172.31.9", {
        bitcoin: "bitcoin/bitcoin:27.0",
        lnd: DEFAULT_LND_IMAGE,
      }),
    ).toThrow(/pinned by sha256 digest/);
  });
});

describe("LightningBackend", () => {
  it("initializes regtest, funds LND, opens liquidity, and returns sanitized status", async () => {
    const { engine, plan, commands, backend } = backendFixture();
    await prepareNetwork(engine, plan);

    const status = await backend.start(plan);

    expect(status).toEqual({
      schemaVersion: 1,
      kind: "lightning-backend",
      net: plan.net,
      state: "ready",
      bitcoin: { container: "running", blockHeight: 113 },
      hub: {
        container: "running",
        syncedToChain: true,
        blockHeight: 113,
        activeChannels: 1,
        localBalanceSats: 1_000_000,
      },
      user: {
        container: "running",
        syncedToChain: true,
        blockHeight: 113,
        activeChannels: 1,
        localBalanceSats: 0,
      },
      channel: {
        active: true,
        capacitySats: 1_000_000,
        hubLocalSats: 1_000_000,
        userLocalSats: 0,
      },
      dataVolumesPresent: true,
    });

    const serialized = JSON.stringify(status);
    expect(serialized).not.toContain(userPublicKey);
    expect(serialized).not.toContain(sensitiveChannelPoint);
    const baked = commands.find(({ command }) =>
      command.includes("bakemacaroon"),
    )?.command;
    expect(baked).toEqual(
      expect.arrayContaining([
        `--save_to=${CCH_MACAROON_PATH}`,
        "invoices:read",
        "invoices:write",
        "offchain:read",
        "offchain:write",
      ]),
    );
    expect(baked?.join(" ")).not.toContain("admin");
    expect(
      commands.find(({ command }) => command[0] === "cp")?.command,
    ).toEqual(["cp", "/root/.lnd/tls.cert", CCH_TLS_CERT_PATH]);
    expect(
      commands.some(({ command }) => command.includes("sendtoaddress")),
    ).toBe(true);
    expect(
      commands.some(({ command }) => command.includes("openchannel")),
    ).toBe(true);
    expect(engine.log.join("\n")).not.toContain(CCH_MACAROON_PATH);
  });

  it("reports degraded partial state and absent state after deterministic teardown", async () => {
    const { engine, plan, backend } = backendFixture();
    await prepareNetwork(engine, plan);
    await engine.run(bitcoinContainerSpec(plan));

    expect(await backend.status(plan)).toMatchObject({
      state: "degraded",
      bitcoin: { container: "running", blockHeight: 113 },
      hub: { container: "absent" },
      dataVolumesPresent: true,
    });

    await backend.down(plan);
    expect(await backend.status(plan)).toMatchObject({
      state: "absent",
      dataVolumesPresent: false,
    });
    expect(await engine.networkExists(plan.network)).toBe(true);
  });

  it("creates, inspects, and pays user invoices through sanitized results", async () => {
    const { engine, plan, commands, backend } = backendFixture();
    await prepareNetwork(engine, plan);
    await backend.start(plan);
    const paymentHash = `0x${"3".repeat(64)}`;

    const invoice = await backend.createUserInvoice(plan, 100_000);
    expect(invoice).toEqual({
      paymentRequest: "lnbcrt-sensitive-payment-request",
      paymentHash,
    });
    await expect(backend.userInvoice(plan, paymentHash)).resolves.toEqual({
      paymentHash,
      state: "SETTLED",
      amountPaidSats: 100_000,
    });
    await expect(
      backend.payFromUser(
        plan,
        "lnbcrt-sensitive-payment-request",
        paymentHash,
      ),
    ).resolves.toEqual({
      paymentHash,
      status: "SUCCEEDED",
      valueSats: 50_000,
      feeSats: 0,
    });

    expect(
      commands.find(({ command }) => command.includes("addinvoice"))?.command,
    ).toContain("--amt=100000");
    expect(
      commands.find(({ command }) => command.includes("lookupinvoice"))
        ?.command,
    ).toContain(`--rhash=${"3".repeat(64)}`);
    expect(
      commands.find(({ command }) => command.includes("payinvoice"))?.command,
    ).toContain("--timeout=120s");
    expect(engine.log.join("\n")).not.toContain(
      "lnbcrt-sensitive-payment-request",
    );
  });

  it.each([1, 2, 3])(
    "rolls back every container and volume when container start %i fails",
    async (failAt) => {
      const fixture = backendFixture(new FailingRunEngine(failAt));
      await prepareNetwork(fixture.engine, fixture.plan);

      await expect(fixture.backend.start(fixture.plan)).rejects.toMatchObject({
        code: "PROVISION_FAILED",
      });
      expect(fixture.engine.containers.size).toBe(0);
      expect(fixture.engine.volumes.size).toBe(0);
      expect(await fixture.engine.networkExists(fixture.plan.network)).toBe(
        true,
      );
    },
  );

  it("rolls back after a channel setup failure without exposing command output", async () => {
    const { engine, plan, backend } = backendFixture();
    await prepareNetwork(engine, plan);
    const priorHandler = engine.execHandler!;
    const sensitiveFailure = "invoice-or-secret-output";
    engine.execHandler = async (container, command, options) => {
      if (command.includes("openchannel")) {
        return result("", { exitCode: 1, stderr: sensitiveFailure });
      }
      return priorHandler(container, command, options);
    };

    let failure: unknown;
    try {
      await backend.start(plan);
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ code: "PROVISION_FAILED" });
    expect(String((failure as Error).message)).not.toContain(sensitiveFailure);
    expect(engine.containers.size).toBe(0);
    expect(engine.volumes.size).toBe(0);
  });

  it("honors cancellation and completes rollback before rejecting", async () => {
    const { engine, plan, backend } = backendFixture();
    await prepareNetwork(engine, plan);
    const controller = new AbortController();
    const priorHandler = engine.execHandler!;
    engine.execHandler = async (
      container: string,
      command: readonly string[],
      options: ContainerExecOptions,
    ) => {
      const response = await priorHandler(container, command, options);
      if (command.includes("createwallet")) {
        controller.abort(new Error("test cancellation"));
      }
      return response;
    };

    await expect(
      backend.start(plan, { signal: controller.signal }),
    ).rejects.toMatchObject({ code: "OPERATION_ABORTED" });
    expect(engine.containers.size).toBe(0);
    expect(engine.volumes.size).toBe(0);
  });

  it("times out state polling and removes the partial backend", async () => {
    const { engine, plan, backend } = backendFixture();
    await prepareNetwork(engine, plan);
    engine.execHandler = async () =>
      result("", { exitCode: 1, stderr: "not ready" });

    await expect(backend.start(plan, { timeoutMs: 10 })).rejects.toMatchObject({
      code: "OPERATION_TIMEOUT",
      resource: expect.stringContaining("Bitcoin container"),
    });
    expect(engine.containers.size).toBe(0);
    expect(engine.volumes.size).toBe(0);
  });

  it("does not touch images or containers before an explicit start", async () => {
    const { engine, plan, backend } = backendFixture();
    await prepareNetwork(engine, plan);

    expect(await backend.status(plan)).toMatchObject({ state: "absent" });
    expect(engine.containers.size).toBe(0);
    expect(engine.log.some((entry) => entry.startsWith("run "))).toBe(false);
  });
});
