import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoDir = fileURLToPath(new URL("..", import.meta.url));
const releaseImplementationSha = "9300bea5f9ec5e72bfdec30b6648a8e79325063d";

async function text(path) {
  return readFile(join(repoDir, path), "utf8");
}

describe("integration documentation", () => {
  it("documents the stable integration release with an immutable implementation pin", async () => {
    const guide = await text("docs/integration.md");

    expect(guide).toContain("is the latest npm release");
    expect(guide).toContain(
      "https://www.npmjs.com/package/@truthixify/fiber-forge/v/0.4.0",
    );
    expect(guide).toContain(releaseImplementationSha);
    expect(guide).not.toContain("not yet an npm release");
    expect(guide).not.toMatch(/@(?:latest|main)\b/);

    const installAt = guide.indexOf("npm ci");
    const buildAt = guide.indexOf("npm run build", installAt);
    const packageAt = guide.indexOf("npm run test:package", buildAt);
    expect(installAt).toBeGreaterThan(-1);
    expect(buildAt).toBeGreaterThan(installAt);
    expect(packageAt).toBeGreaterThan(buildAt);
  });

  it("pins Action trust and package inputs and documents automatic cleanup", async () => {
    const [guide, actionGuide, example] = await Promise.all([
      text("docs/integration.md"),
      text("docs/github-action.md"),
      text("examples/integration-app/README.md"),
    ]);

    for (const document of [guide, actionGuide, example]) {
      expect(document).toContain(
        `uses: truthixify/fiber-forge@${releaseImplementationSha}`,
      );
      expect(document).toContain("package-version: 0.4.0");
    }
    expect(actionGuide).not.toContain("not yet published on npm");
    expect(actionGuide).toContain("post hook");
  });

  it("keeps the release version synchronized and protects npm dist-tags", async () => {
    const [rootPackage, examplePackage, workflow] = await Promise.all([
      text("package.json").then(JSON.parse),
      text("examples/integration-app/package.json").then(JSON.parse),
      text(".github/workflows/publish.yml"),
    ]);

    expect(rootPackage.version).toBe("0.4.0");
    expect(examplePackage.dependencies[rootPackage.name]).toBe(
      rootPackage.version,
    );
    expect(workflow).toContain("version !== tagVersion");
    expect(workflow).toContain('version.includes("-") ? "next" : "latest"');
    expect(workflow).toContain(
      'npm publish --tag "${{ steps.release.outputs.npm-tag }}"',
    );
  });

  it("uses only the public SDK import in the canonical sample", async () => {
    const guide = await text("docs/integration.md");
    const sdkBlock = guide.slice(
      guide.indexOf("## SDK application"),
      guide.indexOf("## GitHub Action"),
    );

    expect(sdkBlock).toContain('from "@truthixify/fiber-forge/sdk"');
    expect(sdkBlock).not.toMatch(/from ["'][^"']*(?:src|dist)\//);
    expect(sdkBlock).toContain("finally");
    expect(sdkBlock).toContain("purge: true");
  });

  it("keeps every relative guide and evidence link resolvable", async () => {
    const guide = await text("docs/integration.md");
    const relativeLinks = [
      ...guide.matchAll(/\]\((?!https?:)([^)#]+)(?:#[^)]+)?\)/g),
    ].map((match) => match[1]);

    expect(relativeLinks.length).toBeGreaterThan(0);
    for (const link of relativeLinks) {
      await expect(
        access(join(repoDir, "docs", link)),
      ).resolves.toBeUndefined();
    }
  });

  it("records a bounded sandbox proof without claiming hosted validation", async () => {
    const evidence = JSON.parse(
      await text("docs/evidence/sandbox-macos-arm64-2026-10-20.json"),
    );

    expect(evidence).toMatchObject({
      schemaVersion: 1,
      result: "passed",
      candidate: { published: false },
      paths: {
        automaticStart: "passed",
        multiHopPayment: "passed",
        loopbackGui: "passed",
        reset: "passed",
        cleanupAbsenceVerification: "passed",
        hostDependencyIsolation: "passed",
      },
    });
    expect(evidence.notes.join(" ")).toContain(
      "No GitHub Codespace or paid infrastructure was created",
    );
    expect(evidence.notes.join(" ")).toContain(
      "private forwarding behavior is documented but was not exercised",
    );
  });
});
