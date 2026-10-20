import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoDir = fileURLToPath(new URL("..", import.meta.url));

describe("GUI node lifecycle controls", () => {
  it("uses accessible controls with confirmation and complete request states", async () => {
    const html = await readFile(join(repoDir, "assets/gui/index.html"), "utf8");

    for (const action of ["Stop", "Start", "Restart"]) {
      expect(html).toContain(`aria-label="${action} {{ nName }}"`);
    }
    expect(html).toContain('class="ff-focus"');
    expect(html).toContain('disabled="{{ nodeStopDisabled }}"');
    expect(html).toContain('role="group" aria-label="Confirm node operation"');
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('role="alert"');
    expect(html).toContain("e.key === 'Escape'");
    expect(html).not.toContain("window.confirm");
  });

  it("calls the bounded daemon operation and exposes progress and recovery results", async () => {
    const html = await readFile(join(repoDir, "assets/gui/index.html"), "utf8");

    expect(html).toContain("fetch('/api/node/lifecycle'");
    expect(html).toContain("WAITING FOR RPC AND CHANNEL STATE");
    expect(html).toContain("CHANNEL ACTION REQUIRED");
    expect(html).toContain("report.nextAction");
    expect(html).toContain("fiber-forge node ' + action");
    expect(html).toContain("width:min(380px,100vw)");
  });
});
