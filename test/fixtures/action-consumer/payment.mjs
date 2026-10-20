import assert from "node:assert/strict";

const connection = JSON.parse(process.env.FIBER_FORGE_CONNECTION ?? "null");
assert.equal(
  connection?.schemaVersion,
  1,
  "missing versioned Action connection data",
);
assert.equal(
  connection.nodes?.length,
  3,
  "the Action consumer requires a trio",
);

let requestId = 0;
async function rpc(url, method, params) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++requestId, method, params }),
    signal: AbortSignal.timeout(10_000),
  });
  assert.equal(response.ok, true, `${method} returned HTTP ${response.status}`);
  const body = await response.json();
  if (body.error) throw new Error(`${method}: ${JSON.stringify(body.error)}`);
  return body.result;
}

const sender = connection.nodes[0];
const receiver = connection.nodes[2];
const invoice = await rpc(receiver.rpc, "new_invoice", [
  {
    currency: "Fibd",
    amount: "0x5f5e100",
    description: "GitHub Action multi-hop assertion",
  },
]);
assert.match(
  invoice.invoice_address,
  /^fibd/i,
  "receiver did not create a Fibd devnet invoice",
);

const submitted = await rpc(sender.rpc, "send_payment", [
  { invoice: invoice.invoice_address },
]);
assert.match(
  submitted.payment_hash,
  /^0x[0-9a-f]+$/i,
  "sender returned no payment hash",
);

let status = submitted.status;
const deadline = Date.now() + 60_000;
while (!["Success", "Failed"].includes(status) && Date.now() < deadline) {
  await new Promise((resolve) => setTimeout(resolve, 500));
  status = (
    await rpc(sender.rpc, "get_payment", [
      { payment_hash: submitted.payment_hash },
    ])
  ).status;
}
assert.equal(
  status,
  "Success",
  `multi-hop payment ended with ${String(status)}`,
);

console.log(
  JSON.stringify({
    schemaVersion: 1,
    network: connection.network,
    from: sender.name,
    to: receiver.name,
    amountCkb: 1,
    status,
    paymentHash: submitted.payment_hash,
  }),
);

if (process.env.FIBER_FORGE_FAIL_AFTER_PAYMENT === "1") {
  throw new Error("deliberate consumer failure after successful payment");
}
