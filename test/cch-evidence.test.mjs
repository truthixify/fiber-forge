import { describe, expect, it } from "vitest";
import {
  buildCchEvidence,
  classifyDockerResourceInspection,
  renderCchEvidenceMarkdown,
} from "../scripts/cch-evidence.mjs";

function proof(net, offset = 0) {
  return {
    schemaVersion: 1,
    kind: "cch-transfer-proof",
    net,
    result: "passed",
    durationMs: 400 + offset,
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
    flows: [
      {
        direction: "fiber-to-lightning",
        paymentHash: `0x${"a".repeat(64)}`,
        deliveredAmountSats: "100000",
        incomingAmountSats: "100000",
        cchFeeSats: "0",
        routingFeeSats: "0",
        terminalOrderStatus: "Success",
        orderTransitions: [{ status: "Success", elapsedMs: 1 }],
        durationMs: 1,
        fiber: {
          asset: "simple_udt",
          unit: "base_units",
          user: change(200_000, 100_000),
          hub: change(0, 100_000),
          paymentStatus: "Success",
        },
        lightning: {
          asset: "regtest_btc",
          unit: "satoshis",
          user: change(0, 100_000),
          hub: change(996_530, 896_530),
          invoiceState: "SETTLED",
          paymentStatus: null,
        },
      },
      {
        direction: "lightning-to-fiber",
        paymentHash: `0x${"b".repeat(64)}`,
        deliveredAmountSats: "50000",
        incomingAmountSats: "50000",
        cchFeeSats: "0",
        routingFeeSats: "0",
        terminalOrderStatus: "Success",
        orderTransitions: [{ status: "Success", elapsedMs: 1 }],
        durationMs: 1,
        fiber: {
          asset: "simple_udt",
          unit: "base_units",
          user: change(100_000, 150_000),
          hub: change(100_000, 50_000),
          paymentStatus: null,
        },
        lightning: {
          asset: "regtest_btc",
          unit: "satoshis",
          user: change(100_000, 50_000),
          hub: change(896_530, 946_530),
          invoiceState: null,
          paymentStatus: "SUCCEEDED",
        },
      },
    ],
    trust: {
      scope: "local-development-only",
      rate: "1 wrapped base unit = 1 regtest satoshi",
      operatorTrusted: true,
      reserveProof: false,
      mainnetFunds: false,
    },
  };
}

function change(before, after) {
  return {
    before: String(before),
    after: String(after),
    delta: String(after - before),
  };
}

describe("CCH evidence", () => {
  it("distinguishes absent Docker resources from inspection failures", () => {
    expect(
      classifyDockerResourceInspection({ code: 0, stderr: "" }, "network"),
    ).toBe("present");
    expect(
      classifyDockerResourceInspection(
        { code: 1, stderr: "Error: No such network: forge-test" },
        "network",
      ),
    ).toBe("absent");
    expect(
      classifyDockerResourceInspection(
        {
          code: 1,
          stderr: "Error response from daemon: network forge-test not found",
        },
        "network",
      ),
    ).toBe("absent");
    expect(
      classifyDockerResourceInspection(
        { code: 1, stderr: "Error: No such volume: forge-test-data" },
        "volume",
      ),
    ).toBe("absent");
    expect(
      classifyDockerResourceInspection(
        { code: 1, stderr: "Cannot connect to the Docker daemon" },
        "volume",
      ),
    ).toBe("failed");
  });

  it("accepts exactly two clean packed-artifact runs and preserves separate timings", () => {
    const runs = [
      {
        mode: "cold-start",
        net: "cch-proof-1",
        startupMs: 10_000,
        proof: proof("cch-proof-1"),
        failure: null,
        cleanup: "passed",
      },
      {
        mode: "warm-start",
        net: "cch-proof-2",
        startupMs: 8_000,
        proof: proof("cch-proof-2", 1),
        failure: null,
        cleanup: "passed",
      },
    ];
    const summary = buildCchEvidence({
      runner: {
        schemaVersion: 1,
        source: "installed-packed-artifact",
        status: "passed",
        activeStage: null,
        stageJournal: [
          {
            sequence: 1,
            phase: "runner:finalize",
            status: "completed",
            at: "2026-11-12T00:00:00.000Z",
          },
        ],
        runs,
      },
      runnerExecution: {
        code: 0,
        signal: null,
        durationMs: 42_000,
        timedOut: false,
      },
      cleanup: {
        "cch-proof-1": { result: "passed" },
        "cch-proof-2": { result: "passed" },
      },
      package: { name: "@truthixify/fiber-forge", version: "test" },
      tarball: { filename: "fiber-forge.tgz", bytes: 42, sha256: "abc" },
      commit: "0123456789abcdef",
      host: {
        platform: "linux",
        release: "test",
        architecture: "x64",
        node: "v20",
        docker: "test",
      },
      installMs: 250,
      diagnostics: { file: "diagnostics.log", bytes: 0 },
    });

    expect(summary).toMatchObject({
      result: "passed",
      source: { packedArtifact: true },
      timings: { coldStartMs: 10_000, warmStartMs: 8_000 },
      runner: {
        status: "passed",
        process: { exitCode: 0, timedOut: false },
        lastStage: { phase: "runner:finalize", status: "completed" },
      },
    });
    expect(renderCchEvidenceMarkdown(summary)).toContain(
      "trusted local-development bridge",
    );
  });

  it("fails evidence when either cleanup is incomplete", () => {
    const runs = [
      {
        mode: "cold-start",
        net: "cch-proof-1",
        startupMs: 1,
        proof: proof("cch-proof-1"),
        failure: null,
        cleanup: "passed",
      },
      {
        mode: "warm-start",
        net: "cch-proof-2",
        startupMs: 1,
        proof: proof("cch-proof-2"),
        failure: null,
        cleanup: "passed",
      },
    ];
    const summary = buildCchEvidence({
      runner: {
        schemaVersion: 1,
        source: "installed-packed-artifact",
        runs,
      },
      cleanup: {
        "cch-proof-1": { result: "passed" },
        "cch-proof-2": { result: "failed" },
      },
      package: { name: "test", version: "test" },
      tarball: {},
      commit: "unknown",
      host: {},
      installMs: 1,
      diagnostics: {},
    });
    expect(summary.result).toBe("failed");
  });

  it("records an invalid proof as a safe failed result", () => {
    const contaminated = proof("cch-proof-1");
    contaminated.incoming_invoice = "lnbcrt-secret";
    const summary = buildCchEvidence({
      runner: {
        schemaVersion: 1,
        source: "installed-packed-artifact",
        status: "failed",
        stageJournal: [
          {
            sequence: 1,
            phase: "cold-start:proof",
            status: "failed",
            at: "2026-11-12T00:00:00.000Z",
            errorCode: "CCH_TRANSFER_FAILED",
          },
        ],
        runs: [
          {
            mode: "cold-start",
            net: "cch-proof-1",
            startupMs: 1,
            proof: contaminated,
            cleanup: "passed",
          },
          {
            mode: "warm-start",
            net: "cch-proof-2",
            startupMs: 1,
            proof: proof("cch-proof-2"),
            cleanup: "passed",
          },
        ],
      },
      runnerExecution: {
        code: 1,
        signal: null,
        durationMs: 2_000,
        timedOut: false,
      },
      cleanup: {
        "cch-proof-1": { result: "passed" },
        "cch-proof-2": { result: "passed" },
      },
      package: { name: "test", version: "test" },
      tarball: {},
      commit: "unknown",
      host: {},
      installMs: 1,
      diagnostics: {},
    });

    expect(summary.result).toBe("failed");
    expect(summary.runs[0]).toMatchObject({
      proof: null,
      failure: { code: "INVALID_PROOF_REPORT" },
    });
    expect(JSON.stringify(summary)).not.toContain("lnbcrt-secret");
  });

  it("redacts packed-runner failure details in the summary", () => {
    const summary = buildCchEvidence({
      runner: {
        schemaVersion: 1,
        source: "installed-packed-artifact",
        status: "failed",
        stageJournal: [
          {
            sequence: 1,
            phase: "cold-start:proof",
            status: "failed",
            at: "2026-11-12T00:00:00.000Z",
            errorCode: "CCH_TRANSFER_FAILED",
          },
        ],
        runs: [
          {
            mode: "cold-start",
            net: "cch-proof-1",
            startupMs: 1,
            proof: null,
            failure: {
              code: "CCH_TRANSFER_FAILED",
              message: "operator rejected request",
              detail: "token=definitely-sensitive-value",
            },
            cleanup: "passed",
          },
        ],
      },
      runnerExecution: {
        code: 1,
        signal: null,
        durationMs: 2_000,
        timedOut: false,
      },
      cleanup: { "cch-proof-1": { result: "passed" } },
      package: { name: "test", version: "test" },
      tarball: {},
      commit: "unknown",
      host: {},
      installMs: 1,
      diagnostics: {},
    });

    expect(summary.result).toBe("failed");
    expect(summary.runs[0].failure.detail).toBe("token=[REDACTED]");
    expect(summary.runner).toMatchObject({
      status: "failed",
      lastStage: {
        phase: "cold-start:proof",
        errorCode: "CCH_TRANSFER_FAILED",
      },
      lastFailedStage: {
        phase: "cold-start:proof",
        errorCode: "CCH_TRANSFER_FAILED",
      },
      process: { exitCode: 1 },
    });
  });

  it("retains process evidence when the runner report is missing", () => {
    const summary = buildCchEvidence({
      runner: null,
      runnerExecution: {
        code: 13,
        signal: null,
        durationMs: 3_102,
        timedOut: false,
      },
      cleanup: {},
      package: { name: "test", version: "test" },
      tarball: {},
      commit: "unknown",
      host: {},
      installMs: 1,
      diagnostics: {},
    });

    expect(summary).toMatchObject({
      result: "failed",
      runner: {
        status: "missing",
        activeStage: null,
        lastStage: null,
        process: { exitCode: 13, durationMs: 3_102, timedOut: false },
      },
    });
  });

  it("retains and sanitizes the last stage from a partial report", () => {
    const summary = buildCchEvidence({
      runner: {
        schemaVersion: 1,
        source: "installed-packed-artifact",
        status: "running",
        activeStage: "cold-start:provision token=secret-value",
        stageJournal: [
          {
            sequence: 1,
            phase: "cold-start:provision token=secret-value",
            status: "started",
            at: "2026-11-12T00:00:00.000Z",
          },
        ],
        runs: [
          {
            mode: "cold-start",
            net: "cch-proof-1",
            startupMs: null,
            proof: null,
            failure: null,
            cleanup: "pending",
          },
        ],
      },
      runnerExecution: {
        code: 13,
        signal: null,
        durationMs: 3_102,
        timedOut: false,
      },
      cleanup: { "cch-proof-1": { result: "passed" } },
      package: { name: "test", version: "test" },
      tarball: {},
      commit: "unknown",
      host: {},
      installMs: 1,
      diagnostics: {},
    });

    expect(summary.result).toBe("failed");
    expect(summary.runner.status).toBe("running");
    expect(summary.runner.activeStage).toBe(
      "cold-start:provision token=[REDACTED]",
    );
    expect(summary.runner.lastStage).toMatchObject({
      phase: "cold-start:provision token=[REDACTED]",
      status: "started",
    });
    expect(JSON.stringify(summary)).not.toContain("secret-value");
  });

  it("rejects evidence with an invalid runner schema or run mode", () => {
    const runs = [
      {
        mode: "cold-start",
        net: "cch-proof-1",
        startupMs: 1,
        proof: proof("cch-proof-1"),
        failure: null,
        cleanup: "passed",
      },
      {
        mode: "unexpected",
        net: "cch-proof-2",
        startupMs: 1,
        proof: proof("cch-proof-2"),
        failure: null,
        cleanup: "passed",
      },
    ];
    const summary = buildCchEvidence({
      runner: { schemaVersion: 2, source: "installed-packed-artifact", runs },
      cleanup: {
        "cch-proof-1": { result: "passed" },
        "cch-proof-2": { result: "passed" },
      },
      package: { name: "test", version: "test" },
      tarball: {},
      commit: "unknown",
      host: {},
      installMs: 1,
      diagnostics: {},
    });

    expect(summary.result).toBe("failed");
    expect(summary.runs[1].mode).toBe("invalid-mode");
  });
});
