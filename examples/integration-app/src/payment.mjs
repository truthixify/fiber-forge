export class IntegrationError extends Error {
  constructor(code, message, action, options = {}) {
    super(message, options);
    this.name = "IntegrationError";
    this.code = code;
    this.action = action;
  }

  toJSON() {
    return {
      code: this.code,
      message: this.message,
      action: this.action,
      ...(this.payment ? { payment: this.payment } : {}),
    };
  }
}

function loopbackUrl(value, label) {
  let url;
  try {
    url = new URL(value);
  } catch (error) {
    throw new IntegrationError(
      "INVALID_CONNECTION",
      `${label} is not a valid URL`,
      "use the connection-json output produced by Fiber Forge",
      { cause: error },
    );
  }
  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    !url.port ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new IntegrationError(
      "INVALID_CONNECTION",
      `${label} must be a loopback HTTP endpoint with an explicit port`,
      "pass the Action connection-json unchanged instead of constructing public RPC URLs",
    );
  }
  return url.toString().replace(/\/$/, "");
}

export function parseConnection(value) {
  let raw;
  try {
    raw = typeof value === "string" ? JSON.parse(value) : value;
  } catch (error) {
    throw new IntegrationError(
      "INVALID_CONNECTION",
      "FIBER_FORGE_CONNECTION is not valid JSON",
      "pass steps.<id>.outputs.connection-json to the application step",
      { cause: error },
    );
  }
  if (raw?.schemaVersion !== 1 || !Array.isArray(raw.nodes)) {
    throw new IntegrationError(
      "INVALID_CONNECTION",
      "connection data must use schemaVersion 1 and include nodes",
      "use a compatible Fiber Forge Action or build the same documented connection shape",
    );
  }
  if (raw.nodes.length !== 3) {
    throw new IntegrationError(
      "INVALID_TOPOLOGY",
      `the example requires a trio but received ${raw.nodes.length} nodes`,
      "start the trio preset before running this assertion",
    );
  }
  const names = new Set();
  const nodes = raw.nodes.map((node, index) => {
    const name = String(node?.name ?? "");
    const pubkey = String(node?.pubkey ?? "");
    if (!/^[a-z][a-z0-9-]{0,29}$/.test(name) || names.has(name)) {
      throw new IntegrationError(
        "INVALID_CONNECTION",
        `node ${index + 1} has an invalid or duplicate name`,
        "use untouched node records from Fiber Forge connection-json",
      );
    }
    if (!/^(?:02|03)[0-9a-f]{64}$/i.test(pubkey)) {
      throw new IntegrationError(
        "INVALID_CONNECTION",
        `node ${name} has an invalid compressed public key`,
        "wait for Action setup to finish before reading its outputs",
      );
    }
    names.add(name);
    return { name, pubkey, rpc: loopbackUrl(node.rpc, `node ${name} RPC`) };
  });
  const network = String(raw.network ?? "");
  if (!/^[a-z0-9](?:[a-z0-9-]{0,28}[a-z0-9])?$/.test(network)) {
    throw new IntegrationError(
      "INVALID_CONNECTION",
      "connection data contains an invalid network name",
      "use the Action connection-json output without modifying its network field",
    );
  }
  return {
    schemaVersion: 1,
    network,
    ckbRpc: loopbackUrl(raw.ckbRpc, "CKB RPC"),
    nodes,
  };
}

async function callRpc(fetchImpl, node, method, params, timeoutMs) {
  let response;
  try {
    response = await fetchImpl(node.rpc, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw new IntegrationError(
      "RPC_UNREACHABLE",
      `${method} could not reach node ${node.name} at ${node.rpc}`,
      "confirm the Fiber Forge setup step is still running in this job and use its connection-json output",
      { cause: error },
    );
  }
  if (!response.ok) {
    throw new IntegrationError(
      "RPC_HTTP_ERROR",
      `${method} on node ${node.name} returned HTTP ${response.status}`,
      "inspect the bounded Action report and the named node's logs",
    );
  }
  let body;
  try {
    body = await response.json();
  } catch (error) {
    throw new IntegrationError(
      "RPC_INVALID_RESPONSE",
      `${method} on node ${node.name} returned invalid JSON`,
      "inspect the endpoint and verify it is a Fiber JSON-RPC service",
      { cause: error },
    );
  }
  if (body?.error != null) {
    throw new IntegrationError(
      "RPC_REJECTED",
      `${method} on node ${node.name} was rejected: ${JSON.stringify(body.error).slice(0, 500)}`,
      "inspect the payment parameters and the named node's bounded logs",
    );
  }
  return body?.result;
}

export async function assertMultiHopPayment(connectionValue, options = {}) {
  const connection = parseConnection(connectionValue);
  const fetchImpl = options.fetchImpl ?? fetch;
  const pollIntervalMs = options.pollIntervalMs ?? 500;
  const paymentTimeoutMs = options.paymentTimeoutMs ?? 60_000;
  const requestTimeoutMs = Math.min(
    options.requestTimeoutMs ?? 10_000,
    paymentTimeoutMs,
  );
  const sender = connection.nodes[0];
  const receiver = connection.nodes[2];

  const invoice = await callRpc(
    fetchImpl,
    receiver,
    "new_invoice",
    [
      {
        currency: "Fibd",
        amount: "0x5f5e100",
        description: "Fiber Forge application integration assertion",
      },
    ],
    requestTimeoutMs,
  );
  if (!/^fibd/i.test(String(invoice?.invoice_address ?? ""))) {
    throw new IntegrationError(
      "INVOICE_ASSERTION_FAILED",
      `node ${receiver.name} did not return a Fibd devnet invoice`,
      "verify the receiver is a ready devnet Fiber node",
    );
  }

  const submitted = await callRpc(
    fetchImpl,
    sender,
    "send_payment",
    [{ invoice: invoice.invoice_address }],
    requestTimeoutMs,
  );
  const paymentHash = String(submitted?.payment_hash ?? "");
  if (!/^0x[0-9a-f]+$/i.test(paymentHash)) {
    throw new IntegrationError(
      "PAYMENT_ASSERTION_FAILED",
      `node ${sender.name} did not return a payment hash`,
      "inspect the sender's payment response and channel readiness",
    );
  }

  let status = String(submitted.status ?? "");
  const deadline = Date.now() + paymentTimeoutMs;
  while (!new Set(["Success", "Failed"]).has(status) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    const payment = await callRpc(
      fetchImpl,
      sender,
      "get_payment",
      [{ payment_hash: paymentHash }],
      requestTimeoutMs,
    );
    status = String(payment?.status ?? "");
  }
  if (status !== "Success") {
    throw new IntegrationError(
      "PAYMENT_ASSERTION_FAILED",
      `multi-hop payment from ${sender.name} to ${receiver.name} ended with ${status || "Timeout"}`,
      "inspect both channels and the relay node's routing state, then retry",
    );
  }

  const result = {
    schemaVersion: 1,
    network: connection.network,
    from: sender.name,
    to: receiver.name,
    amountCkb: 1,
    status,
    paymentHash,
  };
  if (options.failAfterPayment) {
    const failure = new IntegrationError(
      "DELIBERATE_ASSERTION_FAILURE",
      "deliberate application failure after a successful payment",
      "remove --fail-after-payment after verifying teardown behavior",
    );
    failure.payment = result;
    throw failure;
  }
  return result;
}

export function errorResult(error) {
  if (error instanceof IntegrationError) return error.toJSON();
  return {
    code: "UNEXPECTED",
    message: error instanceof Error ? error.message : String(error),
    action: "inspect the preceding error and Fiber Forge report",
  };
}
