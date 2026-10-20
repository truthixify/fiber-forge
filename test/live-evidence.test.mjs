import { afterEach, describe, expect, it } from "vitest";
import {
  assertImagePlatform,
  buildEvidence,
  imageGroupReferences,
  manifestPlatforms,
  normalizeArchitecture,
  sanitizeText,
} from "../scripts/live-evidence.mjs";

const originalJobStatus = process.env.FORGE_E2E_JOB_STATUS;

afterEach(() => {
  if (originalJobStatus === undefined) {
    delete process.env.FORGE_E2E_JOB_STATUS;
  } else {
    process.env.FORGE_E2E_JOB_STATUS = originalJobStatus;
  }
});

describe("live evidence sanitization", () => {
  it("redacts credentials, key material, hashes, and private paths", () => {
    const privatePath = "/tmp/fiber-forge-live-private";
    const input = [
      "token=visible-token",
      "password: visible-password",
      "Authorization: Bearer visible-auth",
      "FIBER_SECRET_KEY_PASSWORD=visible-env-secret",
      `private_key=${"a".repeat(64)}`,
      `payment=0x${"b".repeat(64)}`,
      `encoded=${"Q".repeat(64)}`,
      `state=${privatePath}/node/store`,
    ].join("\n");

    const sanitized = sanitizeText(input, { privatePaths: [privatePath] });

    expect(sanitized.text).not.toContain("visible-token");
    expect(sanitized.text).not.toContain("visible-password");
    expect(sanitized.text).not.toContain("visible-auth");
    expect(sanitized.text).not.toContain("visible-env-secret");
    expect(sanitized.text).not.toContain("b".repeat(64));
    expect(sanitized.text).not.toContain("Q".repeat(64));
    expect(sanitized.text).not.toContain(privatePath);
    expect(sanitized.redactions).toBeGreaterThanOrEqual(7);
  });

  it("bounds diagnostic text by bytes", () => {
    const sanitized = sanitizeText("ordinary log line\n".repeat(10_000), {
      maxBytes: 512,
    });

    expect(Buffer.byteLength(sanitized.text)).toBeLessThanOrEqual(512);
    expect(sanitized.truncated).toBe(true);
    expect(sanitized.text).toContain("[truncated]");
    expect(sanitized.text).toMatch(/^ordinary log line/);
    expect(sanitized.text).toMatch(/ordinary log line\n$/);
  });
});

describe("runtime image platform preflight", () => {
  it("keeps optional CCH images out of ordinary runtime pulls", () => {
    const packageJson = {
      fiberForge: {
        images: { ckb: "core-ckb", fiber: "core-fiber" },
        cchImages: {
          cch: "optional-cch",
          bitcoin: "optional-bitcoin",
          lnd: "optional-lnd",
        },
      },
    };

    expect(imageGroupReferences(packageJson, "images")).toEqual([
      "core-ckb",
      "core-fiber",
    ]);
    expect(imageGroupReferences(packageJson, "cchImages")).toEqual([
      "optional-cch",
      "optional-bitcoin",
      "optional-lnd",
    ]);
  });

  it("normalizes host and Docker architecture aliases", () => {
    expect(normalizeArchitecture("aarch64")).toBe("arm64");
    expect(normalizeArchitecture("x64")).toBe("amd64");
    expect(normalizeArchitecture("x86_64")).toBe("amd64");
  });

  it("reports deployable manifest platforms and ignores attestations", () => {
    const platforms = manifestPlatforms({
      manifests: [
        { platform: { os: "linux", architecture: "amd64" } },
        {
          platform: { os: "linux", architecture: "arm64", variant: "v8" },
        },
        { platform: { os: "unknown", architecture: "unknown" } },
      ],
    });

    expect(platforms).toEqual(["linux/amd64", "linux/arm64/v8"]);
    expect(() =>
      assertImagePlatform("example/image:tag", platforms, "linux", "aarch64"),
    ).not.toThrow();
  });

  it("rejects an image without a native daemon platform", () => {
    expect(() =>
      assertImagePlatform(
        "example/image:tag",
        ["linux/amd64", "linux/arm64/v8"],
        "linux",
        "s390x",
      ),
    ).toThrow(
      "image example/image:tag has no linux/s390x manifest (available: linux/amd64, linux/arm64/v8)",
    );
  });
});

describe("live evidence summary", () => {
  it("records a deliberate failure and successful cleanup without leaking its token", () => {
    delete process.env.FORGE_E2E_JOB_STATUS;
    const secret = "FORGE_EVIDENCE_PROBE_SECRET";
    const metadata = {
      run: { commit: "abc123", event: "workflow_dispatch" },
      package: { name: "@truthixify/fiber-forge", version: "0.2.9" },
      images: {
        ckb: { reference: "nervos/ckb:v0.201.0", architecture: "amd64" },
        fiber: {
          reference: "nervos/fiber:0.9.0-rc7",
          architecture: "amd64",
        },
      },
      host: {
        os: "Linux",
        release: "test",
        architecture: "x64",
        node: "v20.0.0",
        docker: "test",
      },
    };
    const run = {
      completedAt: "2026-01-01T00:00:00.000Z",
      phases: [
        { name: "build", status: "passed", durationMs: 10 },
        { name: "packed-artifact", status: "passed", durationMs: 20 },
        { name: "live-e2e", status: "failed", durationMs: 30 },
      ],
    };
    const vitest = {
      testResults: [
        {
          assertionResults: [
            {
              fullName:
                "live: trio multi-hop CKB payment routes between the endpoints without a direct channel",
              status: "failed",
              duration: 42,
              failureMessages: [
                `payment stage failed: token=${secret}; node forge-e2e-multihop-node-2\n${"ordinary node log\n".repeat(500)}`,
              ],
            },
          ],
        },
      ],
    };
    const cleanup = {
      result: "passed",
      durationMs: 5,
      resourcesChecked: ["e2e-multihop"],
      failures: [],
    };

    const evidence = buildEvidence({ metadata, run, vitest, cleanup });

    expect(evidence.summary.result).toBe("failed");
    expect(evidence.summary.cleanup.result).toBe("passed");
    expect(evidence.summary.tests[0]).toMatchObject({
      result: "failed",
      topology: "trio (3-node line)",
      durationMs: 42,
      diagnostics: ["diagnostics.log"],
    });
    expect(evidence.summary.paths).toContainEqual(
      expect.objectContaining({ id: "multi-hop-ckb", result: "failed" }),
    );
    expect(evidence.diagnostics).toContain("payment stage failed");
    expect(evidence.diagnostics).toContain("forge-e2e-multihop-node-2");
    expect(evidence.diagnostics).not.toContain(secret);
    expect(evidence.summary.diagnostics.redactions).toBeGreaterThan(0);
  });

  it("cannot pass when the live tests were skipped", () => {
    delete process.env.FORGE_E2E_JOB_STATUS;
    const evidence = buildEvidence({
      metadata: {
        run: { commit: "abc123" },
        package: { name: "fiber-forge", version: "test" },
        images: {},
        host: {},
      },
      run: {
        phases: [
          { name: "packed-artifact", status: "passed", durationMs: 1 },
          { name: "live-e2e", status: "passed", durationMs: 1 },
        ],
      },
      vitest: {
        testResults: [
          {
            assertionResults: [
              {
                fullName: "live: trio multi-hop CKB payment skipped",
                status: "skipped",
              },
            ],
          },
        ],
      },
      cleanup: {
        result: "passed",
        durationMs: 1,
        resourcesChecked: [],
        failures: [],
      },
    });

    expect(evidence.summary.result).toBe("failed");
    expect(evidence.summary.paths).toContainEqual(
      expect.objectContaining({ id: "multi-hop-ckb", result: "failed" }),
    );
  });
});
