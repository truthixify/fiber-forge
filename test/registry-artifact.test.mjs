import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  assertReleaseVersion,
  requiredLiquidityGuiMarkers,
  requiredRegistryFiles,
  verifyInstalledPackage,
} from "../scripts/verify-registry-artifact.mjs";

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
});
