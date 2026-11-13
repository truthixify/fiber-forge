import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  assertReleaseVersion,
  installRegistryPackage,
  requiredLiquidityGuiMarkers,
  requiredRegistryFiles,
  verifyInstalledPackage,
} from "../scripts/verify-registry-artifact.mjs";

const success = { code: 0, stdout: "", stderr: "" };

function propagationMiss(version) {
  return {
    code: 1,
    stdout: "",
    stderr: [
      "npm error code ETARGET",
      `npm error notarget No matching version found for @truthixify/fiber-forge@${version}.`,
    ].join("\n"),
  };
}

async function withPackage(run) {
  const directory = await mkdtemp(
    join(tmpdir(), "fiber-forge-registry-fixture-"),
  );
  try {
    const metadata = {
      name: "@truthixify/fiber-forge",
      version: "1.2.3",
      bin: { "fiber-forge": "bin/fiber-forge.mjs" },
      exports: {
        "./sdk": { import: "./dist/sdk.js", types: "./dist/sdk.d.ts" },
      },
    };
    await writeFile(join(directory, "package.json"), JSON.stringify(metadata));
    for (const relativePath of requiredRegistryFiles) {
      const file = join(directory, relativePath);
      await mkdir(dirname(file), { recursive: true });
      await writeFile(
        file,
        relativePath === "assets/gui/index.html"
          ? requiredLiquidityGuiMarkers.join("\n")
          : "fixture",
      );
    }
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

describe("published registry artifact verification", () => {
  it("accepts exact stable and prerelease versions", () => {
    expect(() => assertReleaseVersion("1.2.3")).not.toThrow();
    expect(() => assertReleaseVersion("0.5.0-rc.1")).not.toThrow();
    expect(() => assertReleaseVersion("latest")).toThrow(/semantic version/);
  });

  it("checks package metadata, assets, and liquidity GUI markers", async () => {
    await withPackage(async (directory) => {
      await expect(verifyInstalledPackage(directory, "1.2.3")).resolves.toEqual(
        {
          name: "@truthixify/fiber-forge",
          version: "1.2.3",
          files: requiredRegistryFiles.length,
          guiMarkers: requiredLiquidityGuiMarkers.length,
        },
      );
    });
  });

  it("rejects a package without the merged liquidity interface", async () => {
    await withPackage(async (directory) => {
      await writeFile(join(directory, "assets/gui/index.html"), "old gui");
      await expect(verifyInstalledPackage(directory, "1.2.3")).rejects.toThrow(
        /published GUI is missing marker/,
      );
    });
  });

  it("retries only while the exact registry version is propagating", async () => {
    const results = [
      propagationMiss("1.2.3"),
      propagationMiss("1.2.3"),
      success,
    ];
    const waits = [];
    const retries = [];

    await expect(
      installRegistryPackage("1.2.3", "/unused", {
        attempts: 3,
        delayMs: 25,
        runCommand: async () => results.shift(),
        wait: async (delayMs) => waits.push(delayMs),
        onRetry: (retry) => retries.push(retry),
      }),
    ).resolves.toBeUndefined();

    expect(results).toHaveLength(0);
    expect(waits).toEqual([25, 25]);
    expect(retries).toEqual([
      { attempt: 1, attempts: 3, delayMs: 25 },
      { attempt: 2, attempts: 3, delayMs: 25 },
    ]);
  });

  it("fails immediately for unrelated registry errors", async () => {
    const runCommand = vi.fn().mockResolvedValue({
      code: 1,
      stdout: "",
      stderr: "npm error code E401\nnpm error authentication required",
    });
    const wait = vi.fn();

    await expect(
      installRegistryPackage("1.2.3", "/unused", {
        runCommand,
        wait,
        onRetry: vi.fn(),
      }),
    ).rejects.toThrow(/registry install failed with exit code 1/);
    expect(runCommand).toHaveBeenCalledTimes(1);
    expect(wait).not.toHaveBeenCalled();
  });

  it("does not retry an ETARGET for a different version", async () => {
    const runCommand = vi.fn().mockResolvedValue(propagationMiss("9.9.9"));
    const wait = vi.fn();

    await expect(
      installRegistryPackage("1.2.3", "/unused", {
        runCommand,
        wait,
        onRetry: vi.fn(),
      }),
    ).rejects.toThrow(/No matching version found/);
    expect(runCommand).toHaveBeenCalledTimes(1);
    expect(wait).not.toHaveBeenCalled();
  });

  it("stops after the bounded propagation window", async () => {
    const runCommand = vi.fn().mockResolvedValue(propagationMiss("1.2.3"));
    const wait = vi.fn();

    await expect(
      installRegistryPackage("1.2.3", "/unused", {
        attempts: 3,
        delayMs: 0,
        runCommand,
        wait,
        onRetry: vi.fn(),
      }),
    ).rejects.toThrow(/No matching version found/);
    expect(runCommand).toHaveBeenCalledTimes(3);
    expect(wait).toHaveBeenCalledTimes(2);
  });
});
