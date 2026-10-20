import { describe, expect, it } from "vitest";
import {
  DEFAULT_PROVISION_TIMEOUT_MS,
  ForgeError,
  errorDetails,
  planNetwork,
  preset,
} from "../src/sdk";

describe("public SDK helpers", () => {
  it("plans a validated topology without Docker access", () => {
    const layout = planNetwork(preset("trio")!, {
      subnetBase: "10.42.7",
      ckbHostPort: 19114,
      rpcHostPortBase: 19300,
    });

    expect(layout).toMatchObject({
      net: "trio",
      subnet: "10.42.7.0/24",
      ckbHostPort: 19114,
    });
    expect(layout.nodes.map((node) => node.rpcHostPort)).toEqual([
      19300, 19301, 19302,
    ]);
  });

  it("validates topology objects passed to the planner", () => {
    expect(() =>
      planNetwork({
        name: "invalid",
        nodes: [{ name: "only-one" }],
        channels: [],
        funding: { perNodeCkb: 1000 },
      }),
    ).toThrow(/nodes must have 2/);
  });

  it("exports stable structured lifecycle errors", () => {
    const error = new ForgeError("OPERATION_TIMEOUT", "timed out", {
      resource: "routing graph",
      action: "increase timeout",
    });

    expect(errorDetails(error)).toEqual({
      code: "OPERATION_TIMEOUT",
      message: "timed out",
      resource: "routing graph",
      action: "increase timeout",
    });
    expect(DEFAULT_PROVISION_TIMEOUT_MS).toBe(600_000);
  });
});
