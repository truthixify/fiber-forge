import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoDir = fileURLToPath(new URL("..", import.meta.url));

async function text(path) {
  return readFile(join(repoDir, path), "utf8");
}

describe("runtime dependency security contract", () => {
  it("keeps the reviewed CCC and residual advisory graph explicit", async () => {
    const [lock, guide] = await Promise.all([
      text("package-lock.json").then(JSON.parse),
      text("docs/verification.md"),
    ]);

    expect(lock.packages[""].dependencies["@ckb-ccc/core"]).toBe("^1.23.0");
    expect(lock.packages["node_modules/@ckb-ccc/core"].version).toBe("1.23.0");
    expect(lock.packages["node_modules/@joyid/ckb"].version).toBe("1.1.4");
    expect(
      lock.packages["node_modules/@nervosnetwork/ckb-sdk-utils"].version,
    ).toBe("0.109.5");
    expect(lock.packages["node_modules/elliptic"].version).toBe("6.6.1");

    expect(guide).toContain("GHSA-848j-6mx2-7j84");
    expect(guide).toContain("currently lists no patched version");
    expect(guide).toContain("SignerCkbPrivateKey");
    expect(guide).toContain("The dependency remains installed");
  });

  it("blocks new high-severity production findings in source CI", async () => {
    const workflow = await text(".github/workflows/ci.yml");
    expect(workflow).toContain("npm audit --omit=dev --audit-level=high");
  });
});
