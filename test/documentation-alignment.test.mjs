import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoDir = fileURLToPath(new URL("..", import.meta.url));

async function text(path) {
  return readFile(join(repoDir, path), "utf8");
}

describe("shipped documentation", () => {
  it("records the merged upstream quick-start work", async () => {
    const spec = await text("docs/spec.md");

    expect(spec).toContain("https://github.com/nervosnetwork/fiber/pull/1262");
    expect(spec).toContain("Upstream Fiber merged");
    expect(spec).not.toContain("Core issue #1262");
    expect(spec).not.toContain("still open");
  });

  it("keeps completed work out of current roadmaps", async () => {
    const [readme, spec] = await Promise.all([
      text("README.md"),
      text("docs/spec.md"),
    ]);
    const readmeRoadmap = readme.slice(readme.indexOf("## Roadmap"));
    const pendingSpec = spec.slice(spec.indexOf("## 12. Pending work"));

    expect(readmeRoadmap).not.toContain(
      "force-close/on-chain settlement visibility",
    );
    expect(pendingSpec).not.toContain("headless CI mode as a GitHub Action");
    expect(pendingSpec).not.toContain("scenario marketplace");
    expect(pendingSpec).not.toContain("answer to fiber#1262");
    expect(spec).not.toContain("## 12. Roadmap (post-hackathon)");
  });

  it("keeps current release claims aligned across the primary guides", async () => {
    const [readme, guide] = await Promise.all([
      text("README.md"),
      text("docs/integration.md"),
    ]);

    for (const document of [readme, guide]) {
      expect(document).toContain("latest published npm package");
      expect(document).toContain("`0.4.1`");
      expect(document).not.toContain("not part of `0.4.0`");
    }
  });
});
