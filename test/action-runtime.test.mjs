import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";

import { writeEnvironmentValue } from "../action/github.mjs";
import {
  assertManagedActionRoot,
  loadInstalledSdk,
  resolveTopologyFile,
  sanitizeText,
} from "../action/runtime.mjs";

describe("GitHub Action runtime", () => {
  it("writes multiline values without interpreting workflow commands", async () => {
    const root = await mkdtemp(join(tmpdir(), "forge-action-output-"));
    const output = join(root, "output");
    await writeEnvironmentValue(
      output,
      "connection-json",
      '{"value":"a\nb"}\n::error::not-a-command',
    );

    const value = await readFile(output, "utf8");
    expect(value).toMatch(/^connection-json<<fiber_forge_[a-f0-9]+\n/);
    expect(value).toContain('{"value":"a\nb"}\n::error::not-a-command\n');
  });

  it("rejects a topology symlink that escapes the workspace", async () => {
    const root = await mkdtemp(join(tmpdir(), "forge-action-topology-"));
    const workspace = join(root, "workspace");
    const outside = join(root, "outside.yml");
    await mkdir(workspace);
    await writeFile(outside, "name: escaped\n", "utf8");
    await symlink(outside, join(workspace, "network.yml"));

    await expect(
      resolveTopologyFile(join(workspace, "network.yml"), workspace),
    ).rejects.toThrow(/symlink/);
  });

  it("loads only the installed package's declared public SDK export", async () => {
    const root = await mkdtemp(join(tmpdir(), "forge-action-sdk-"));
    const packageDir = join(root, "node_modules", "@truthixify", "fiber-forge");
    await mkdir(join(packageDir, "dist"), { recursive: true });
    await writeFile(
      join(packageDir, "package.json"),
      JSON.stringify({
        name: "@truthixify/fiber-forge",
        version: "1.2.3-rc.1",
        type: "module",
        exports: { "./sdk": { import: "./dist/sdk.js" } },
      }),
      "utf8",
    );
    await writeFile(
      join(packageDir, "dist", "sdk.js"),
      [
        'export const version = "1.2.3-rc.1";',
        "export const createFiberForge = () => ({});",
        "export const parseTopology = () => ({});",
        "export const preset = () => ({});",
      ].join("\n"),
      "utf8",
    );

    const sdk = await loadInstalledSdk(root, "1.2.3-rc.1");
    expect(sdk.version).toBe("1.2.3-rc.1");
    await expect(loadInstalledSdk(root, "1.2.4")).rejects.toThrow(
      /identity mismatch/,
    );
  });

  it("redacts credentials, token-shaped values, private paths, and private keys", () => {
    const token = `github_${"pat"}_${"a".repeat(30)}`;
    const redacted = sanitizeText(
      `https://user:pass@example.test token=${token} /tmp/private 0x${"a".repeat(64)}`,
      ["/tmp/private"],
    );
    expect(redacted).not.toContain("user:pass");
    expect(redacted).not.toContain(token);
    expect(redacted).not.toContain("/tmp/private");
    expect(redacted).not.toContain("a".repeat(64));
  });

  it("accepts only managed action directories for recursive removal", () => {
    expect(
      assertManagedActionRoot(
        "/runner/temp/fiber-forge-action-123",
        "/runner/temp",
      ),
    ).toBe("/runner/temp/fiber-forge-action-123");
    expect(() =>
      assertManagedActionRoot("/runner/temp", "/runner/temp"),
    ).toThrow(/refusing/);
    expect(() =>
      assertManagedActionRoot("/runner/other", "/runner/temp"),
    ).toThrow(/refusing/);
  });

  it("declares a Node 24 main and unconditional post entry point", async () => {
    const metadata = parseYaml(
      await readFile(new URL("../action.yml", import.meta.url), "utf8"),
    );
    expect(metadata.runs).toEqual({
      using: "node24",
      main: "action/main.mjs",
      post: "action/post.mjs",
      "post-if": "always()",
    });
    expect(Object.keys(metadata.outputs)).toEqual([
      "network",
      "ckb-rpc",
      "nodes-json",
      "connection-json",
      "report-path",
      "startup-duration-ms",
    ]);
  });
});
