import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { buildBundleArchive, inspectBundleFile } from "../src/bundle";
import { parseScenario } from "../src/scenario";
import { parseTopology } from "../src/topology";

const repoDir = fileURLToPath(new URL("..", import.meta.url));
const sampleDir = join(repoDir, "docs", "examples", "export-v1");
const allowedSampleFiles = [
  "failure.ffbundle",
  "manifest.json",
  "report.json",
  "scenario.json",
  "topology.json",
];

async function json(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

function digest(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

describe("export bundle design", () => {
  it("records the accepted levels, exact-state boundary, and import threat controls", async () => {
    const design = await readFile(
      join(repoDir, "docs", "export-bundles.md"),
      "utf8",
    );

    expect(design).toContain("Recipe bundle");
    expect(design).toContain("Diagnostic bundle");
    expect(design).toContain("Stateful archive");
    expect(design).toContain("Rejected and unsupported");
    expect(design).toContain("There is no recorded user approval");
    expect(design).toMatch(/path traversal/i);
    expect(design).toContain("symlinks");
    expect(design).toContain("2 MiB uncompressed limit");
    expect(design).toContain("Unknown major or newer minor is rejected");
    expect(design).toMatch(/exact (?:channel-state|state\/channel) restor/i);
  });

  it("publishes a closed version-1 manifest schema", async () => {
    const schema = await json(
      join(repoDir, "docs", "schema", "export-manifest-v1.schema.json"),
    );

    expect(schema).toMatchObject({
      type: "object",
      additionalProperties: false,
      properties: {
        format: { const: "fiber-forge-export" },
        schema: {
          additionalProperties: false,
          properties: { major: { const: 1 }, minor: { const: 0 } },
        },
        capabilities: {
          properties: {
            exactStateRestore: { const: false },
            containsSecrets: { const: false },
          },
        },
      },
    });
    expect(schema.$defs.artifact.additionalProperties).toBe(false);
    expect(schema.$defs.artifact.properties.role.enum).toEqual(
      expect.arrayContaining([
        "topology",
        "scenario",
        "scenario-report",
        "node-log",
      ]),
    );
    expect(schema.properties.artifacts.allOf).toHaveLength(3);
    expect(schema.$defs.artifact.allOf).toHaveLength(8);
    expect(schema.$defs.artifact.allOf).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          if: { properties: { role: { const: "topology" } } },
          then: {
            properties: {
              path: { const: "topology.json" },
              mediaType: { const: "application/json" },
            },
          },
        }),
        expect.objectContaining({
          if: { properties: { role: { const: "ckb-log" } } },
          then: {
            properties: {
              path: { const: "diagnostics/logs/ckb.log" },
              mediaType: { const: "text/plain" },
            },
          },
        }),
      ]),
    );
    const allowedPath = new RegExp(
      schema.$defs.artifact.properties.path.pattern,
    );
    expect(allowedPath.test("topology.json")).toBe(true);
    expect(allowedPath.test("diagnostics/logs/node-alice.log")).toBe(true);
    for (const path of [
      "../topology.json",
      "/topology.json",
      "diagnostics/../../fiber/sk",
      "diagnostics/logs/alice/extra.log",
      "Dockerfile",
    ]) {
      expect(allowedPath.test(path)).toBe(false);
    }
  });

  it("verifies every sample artifact and its stable recipe digest", async () => {
    const [manifest, packageMetadata] = await Promise.all([
      json(join(sampleDir, "manifest.json")),
      json(join(repoDir, "package.json")),
    ]);
    expect(manifest).toMatchObject({
      format: "fiber-forge-export",
      schema: { major: 1, minor: 0 },
      level: "recipe",
      generator: {
        package: packageMetadata.name,
        version: packageMetadata.version,
      },
      runtime: { images: packageMetadata.fiberForge.images },
      capabilities: { exactStateRestore: false, containsSecrets: false },
    });

    const paths = manifest.artifacts.map((artifact) => artifact.path);
    expect(paths).toEqual([...paths].sort());
    for (const artifact of manifest.artifacts) {
      const bytes = await readFile(join(sampleDir, artifact.path));
      expect(bytes.byteLength).toBe(artifact.bytes);
      expect(digest(bytes)).toBe(artifact.sha256);
    }

    const artifacts = new Map(
      manifest.artifacts.map((artifact) => [artifact.role, artifact.sha256]),
    );
    const recipeIdentity = canonicalJson({
      schemaMajor: manifest.schema.major,
      images: manifest.runtime.images,
      topology: artifacts.get("topology"),
      scenario: artifacts.get("scenario"),
    });
    expect(digest(recipeIdentity)).toBe(manifest.recipeDigest);

    const artifactFiles = new Map(
      await Promise.all(
        manifest.artifacts.map(async (artifact) => [
          artifact.path,
          await readFile(join(sampleDir, artifact.path)),
        ]),
      ),
    );
    const checkedArchive = await readFile(join(sampleDir, "failure.ffbundle"));
    const rebuiltArchive = buildBundleArchive(manifest, artifactFiles);
    expect(gunzipSync(checkedArchive).equals(gunzipSync(rebuiltArchive))).toBe(
      true,
    );
    await expect(
      inspectBundleFile(join(sampleDir, "failure.ffbundle")),
    ).resolves.toMatchObject({
      integrity: "verified",
      redaction: "verified",
      recipe: { network: "bundle-sample", expectedPassed: true },
    });

    const topology = parseTopology(
      await readFile(join(sampleDir, "topology.json"), "utf8"),
    );
    expect(topology.name).toBe("bundle-sample");
    expect(topology.nodes.map((node) => node.name)).toEqual([
      "alice",
      "bob",
      "carol",
    ]);
    expect(
      parseScenario(await readFile(join(sampleDir, "scenario.json"), "utf8")),
    ).toMatchObject({ version: 1, legacy: false, loop: 1 });
  });

  it("finds no secret-bearing state or unexpected entry in the sample export", async () => {
    const entries = await readdir(sampleDir, { withFileTypes: true });
    expect(entries.map((entry) => entry.name).sort()).toEqual(
      allowedSampleFiles,
    );

    for (const entry of entries) {
      const path = join(sampleDir, entry.name);
      const info = await lstat(path);
      expect(entry.isFile()).toBe(true);
      expect(info.isSymbolicLink()).toBe(false);
      expect(info.size).toBeLessThanOrEqual(64 * 1024);

      const raw = await readFile(path, "utf8");
      const withoutDigests = raw.replace(
        /sha256:[0-9a-f]{64}/g,
        "sha256:[digest]",
      );
      expect(withoutDigests).not.toMatch(/-----BEGIN [^-\n]*PRIVATE KEY-----/i);
      expect(withoutDigests).not.toMatch(/FIBER_SECRET_KEY_PASSWORD/i);
      expect(withoutDigests).not.toMatch(
        /"(?:password|privateKey|seed|token)"\s*:/i,
      );
      expect(withoutDigests).not.toMatch(
        /\b(?:gh[pousr]|github_pat)_[A-Za-z0-9_]{12,}\b/,
      );
      expect(withoutDigests).not.toMatch(/\b0x[0-9a-f]{64}\b/i);
      expect(withoutDigests).not.toMatch(
        /\/(?:Users|home|var\/lib|run\/user)\//,
      );
      expect(withoutDigests).not.toMatch(/(?:ckb\/key|fiber\/sk|fiber\/store)/);
    }
  });
});
