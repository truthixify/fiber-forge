import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { describe, expect, it } from "vitest";
import {
  CCH_RPC_PORT,
  CchOperator,
  CchRpc,
  DEFAULT_CCH_IMAGE,
  cchConfigYaml,
  cchContainerSpec,
  planCchOperator,
} from "../src/cch";
import { FakeEngine } from "../src/engine";
import { type RpcTransport } from "../src/rpc";

const wrappedTypeScript = {
  code_hash: `0x${"1".repeat(64)}`,
  hash_type: "data1",
  args: `0x${"2".repeat(64)}`,
};

function plan() {
  return planCchOperator({
    net: "cch-test",
    network: "forge-cch-test",
    subnetBase: "172.31.8",
    rpcHostPort: 18400,
    hubFiberIp: "172.31.8.12",
    wrappedTypeScript,
  });
}

describe("CCH operator planning", () => {
  it("uses the reserved private address, immutable image, and isolated credentials", () => {
    const operator = plan();
    const spec = cchContainerSpec(operator, "/tmp/public-cch-config");

    expect(operator.image).toBe(DEFAULT_CCH_IMAGE);
    expect(operator.image).toMatch(/@sha256:[0-9a-f]{64}$/);
    expect(operator.ip).toBe("172.31.8.203");
    expect(spec.ports).toEqual([{ host: 18400, container: CCH_RPC_PORT }]);
    expect(spec.env).toBeUndefined();
    expect(spec.entrypoint).toEqual(["/usr/local/bin/fnn"]);
    expect(spec.volumes).toContainEqual({
      source: "forge-cch-test-cch-auth",
      target: "/cch-auth",
      readOnly: true,
    });
  });

  it("renders standalone CCH config without embedding credentials", () => {
    const config = cchConfigYaml(plan());
    const parsed = parseYaml(config) as Record<string, any>;

    expect(parsed.services).toEqual(["rpc", "cch"]);
    expect(parsed.rpc.enabled_modules).toEqual(["cch"]);
    expect(parsed.cch.fiber_rpc_url).toBe("http://172.31.8.12:8227");
    expect(parsed.cch.lnd_rpc_url).toBe("https://forge-cch-test-lnd-hub:10009");
    expect(JSON.parse(parsed.cch.wrapped_btc_type_script)).toEqual(
      wrappedTypeScript,
    );
    expect(config).not.toMatch(/password|admin\.macaroon|private[_-]?key/i);
  });

  it("rejects mutable operator images", () => {
    expect(() =>
      planCchOperator({
        net: "x",
        network: "forge-x",
        subnetBase: "10.1.2",
        rpcHostPort: 18400,
        hubFiberIp: "10.1.2.12",
        wrappedTypeScript,
        image: "nervos/fiber:latest",
      }),
    ).toThrow(/pinned by sha256 digest/);
  });
});

describe("CchRpc", () => {
  const validOrder = {
    timestamp: "0x1",
    expiry_delta_seconds: "0xe10",
    wrapped_btc_type_script: wrappedTypeScript,
    incoming_invoice: { Fiber: "fiber-invoice-private" },
    outgoing_pay_req: "lightning-invoice-private",
    payment_hash: `0x${"a".repeat(64)}`,
    amount_sats: "0x186a0",
    fee_sats: "0x0",
    status: "Pending",
  };

  it("treats the release's unknown-order response as transport readiness", async () => {
    const calls: string[] = [];
    const transport: RpcTransport = {
      async call(method) {
        calls.push(method);
        throw new Error("get_cch_order: Key not found");
      },
    };

    await expect(new CchRpc(transport).ready()).resolves.toBe(true);
    expect(calls).toEqual(["get_cch_order"]);
  });

  it("does not hide unrelated RPC failures", async () => {
    const transport: RpcTransport = {
      async call() {
        throw new Error("connection refused");
      },
    };
    await expect(new CchRpc(transport).ready()).resolves.toBe(false);
  });

  it("maps all transfer calls and returns validated orders", async () => {
    const calls: { method: string; params: unknown[] }[] = [];
    const transport: RpcTransport = {
      async call(method, params) {
        calls.push({ method, params });
        return validOrder;
      },
    };
    const rpc = new CchRpc(transport);

    await expect(rpc.sendBtc("lnbcrt-private")).resolves.toMatchObject({
      paymentHash: validOrder.payment_hash,
      amountSats: "0x186a0",
      status: "Pending",
      incomingInvoice: { Fiber: "fiber-invoice-private" },
    });
    await rpc.receiveBtc("fiber-private");
    await rpc.getOrder(validOrder.payment_hash);

    expect(calls).toEqual([
      {
        method: "send_btc",
        params: [{ btc_pay_req: "lnbcrt-private", currency: "Fibd" }],
      },
      {
        method: "receive_btc",
        params: [{ fiber_pay_req: "fiber-private" }],
      },
      {
        method: "get_cch_order",
        params: [{ payment_hash: validOrder.payment_hash }],
      },
    ]);
  });

  it("fails closed on malformed order fields without exposing invoices", async () => {
    const transport: RpcTransport = {
      async call() {
        return { ...validOrder, amount_sats: "100000" };
      },
    };

    let failure: unknown;
    try {
      await new CchRpc(transport).sendBtc("lnbcrt-private");
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ code: "CCH_TRANSFER_FAILED" });
    expect(String((failure as Error).message)).not.toMatch(/invoice-private/);
  });

  it("normalizes payment hashes before correlating order state", async () => {
    const transport: RpcTransport = {
      async call() {
        return {
          ...validOrder,
          payment_hash: `0x${"A".repeat(64)}`,
        };
      },
    };

    await expect(
      new CchRpc(transport).sendBtc("lnbcrt-private"),
    ).resolves.toMatchObject({ paymentHash: `0x${"a".repeat(64)}` });
  });
});

describe("CchOperator", () => {
  it("writes public config, reaches RPC readiness, and tears down cleanly", async () => {
    const engine = new FakeEngine();
    const operatorPlan = plan();
    const configDir = await mkdtemp(join(tmpdir(), "forge-cch-config-"));
    let probes = 0;
    const operator = new CchOperator(engine, () => ({
      ready: async () => (probes += 1) >= 2,
    }));
    await engine.ensureNetwork(operatorPlan.network, "172.31.8.0/24");

    try {
      const status = await operator.start(operatorPlan, configDir);
      expect(status).toEqual({
        container: "running",
        rpcReady: true,
        dataVolumePresent: true,
      });
      expect(await readFile(join(configDir, "config.yml"), "utf8")).toContain(
        "wrapped_btc_type_script",
      );

      await operator.down(operatorPlan);
      expect(await engine.status(operatorPlan.container)).toBe("absent");
      expect(await engine.volumeExists(operatorPlan.dataVolume)).toBe(false);
    } finally {
      await rm(configDir, { recursive: true, force: true });
    }
  });

  it("rolls back an interrupted start without leaving runtime resources", async () => {
    const engine = new FakeEngine();
    const operatorPlan = plan();
    const parent = await mkdtemp(join(tmpdir(), "forge-cch-abort-"));
    const configDir = join(parent, "config");
    const controller = new AbortController();
    const operator = new CchOperator(engine, () => ({
      ready: async () => true,
    }));
    await engine.ensureNetwork(operatorPlan.network, "172.31.8.0/24");
    controller.abort("test abort");

    try {
      await expect(
        operator.start(operatorPlan, configDir, {
          signal: controller.signal,
        }),
      ).rejects.toMatchObject({ code: "OPERATION_ABORTED" });
      expect(await engine.status(operatorPlan.container)).toBe("absent");
      expect(await engine.volumeExists(operatorPlan.dataVolume)).toBe(false);
      await expect(
        readFile(join(configDir, "config.yml"), "utf8"),
      ).rejects.toThrow();
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });
});
