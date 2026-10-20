import { assertMultiHopPayment, errorResult } from "./payment.mjs";

try {
  const result = await assertMultiHopPayment(
    process.env.FIBER_FORGE_CONNECTION,
    { failAfterPayment: process.env.FIBER_FORGE_FAIL_AFTER_PAYMENT === "1" },
  );
  console.log(JSON.stringify(result));
} catch (error) {
  console.error(JSON.stringify(errorResult(error)));
  process.exitCode = 1;
}
