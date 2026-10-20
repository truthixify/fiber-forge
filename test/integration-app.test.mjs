import { describe, expect, it, vi } from "vitest";

import {
  IntegrationError,
  assertMultiHopPayment,
  parseConnection,
} from "../examples/integration-app/src/payment.mjs";

const connection = {
  schemaVersion: 1,
  network: "example-trio",
  ckbRpc: "http://127.0.0.1:8114",
  nodes: [
    {
      name: "alice",
      pubkey: `02${"a".repeat(64)}`,
      rpc: "http://127.0.0.1:8300",
    },
    {
      name: "bob",
      pubkey: `03${"b".repeat(64)}`,
      rpc: "http://127.0.0.1:8301",
    },
    {
      name: "carol",
      pubkey: `02${"c".repeat(64)}`,
      rpc: "http://127.0.0.1:8302",
    },
  ],
};

function response(result, error) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ jsonrpc: "2.0", id: 1, result, error }),
  };
}

describe("external-style integration application", () => {
  it("uses structured endpoints to assert a successful multi-hop payment", async () => {
    const calls = [];
    const fetchImpl = vi.fn(async (url, init) => {
      const request = JSON.parse(init.body);
      calls.push({ url, method: request.method });
      if (request.method === "new_invoice") {
        return response({ invoice_address: "fibd1example" });
      }
      if (request.method === "send_payment") {
        return response({ payment_hash: "0xabc123", status: "Inflight" });
      }
      return response({ status: "Success" });
    });

    await expect(
      assertMultiHopPayment(connection, {
        fetchImpl,
        pollIntervalMs: 0,
        paymentTimeoutMs: 1_000,
      }),
    ).resolves.toEqual({
      schemaVersion: 1,
      network: "example-trio",
      from: "alice",
      to: "carol",
      amountCkb: 1,
      status: "Success",
      paymentHash: "0xabc123",
    });
    expect(calls).toEqual([
      { url: "http://127.0.0.1:8302", method: "new_invoice" },
      { url: "http://127.0.0.1:8300", method: "send_payment" },
      { url: "http://127.0.0.1:8300", method: "get_payment" },
    ]);
  });

  it("returns an actionable endpoint failure", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("connection refused");
    });
    await expect(
      assertMultiHopPayment(connection, { fetchImpl }),
    ).rejects.toMatchObject({
      code: "RPC_UNREACHABLE",
      message: expect.stringContaining("carol"),
      action: expect.stringContaining("connection-json"),
    });
  });

  it("rejects public RPC endpoints before sending a request", () => {
    expect(() =>
      parseConnection({
        ...connection,
        nodes: [
          ...connection.nodes.slice(0, 2),
          { ...connection.nodes[2], rpc: "https://fiber.example.test:8302" },
        ],
      }),
    ).toThrowError(IntegrationError);
  });

  it("supports a deliberate post-payment failure for cleanup tests", async () => {
    const fetchImpl = vi.fn(async (_url, init) => {
      const method = JSON.parse(init.body).method;
      if (method === "new_invoice") {
        return response({ invoice_address: "fibd1example" });
      }
      if (method === "send_payment") {
        return response({ payment_hash: "0xabc123", status: "Success" });
      }
      throw new Error(`unexpected ${method}`);
    });
    await expect(
      assertMultiHopPayment(connection, { fetchImpl, failAfterPayment: true }),
    ).rejects.toMatchObject({
      code: "DELIBERATE_ASSERTION_FAILURE",
      payment: { status: "Success", paymentHash: "0xabc123" },
    });
  });
});
