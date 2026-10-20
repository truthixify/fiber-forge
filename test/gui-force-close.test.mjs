import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoDir = fileURLToPath(new URL("..", import.meta.url));

describe("GUI force-close settlement", () => {
  it("requires full-id confirmation and keeps request and settlement states distinct", async () => {
    const html = await readFile(join(repoDir, "assets/gui/index.html"), "utf8");

    expect(html).toContain('role="dialog" aria-modal="true"');
    expect(html).toContain('aria-label="Confirm full channel ID"');
    expect(html).toContain("S.forceCloseConfirm !== forceTarget.channelId");
    expect(html).toContain(
      "CLOSE REQUESTED · WAITING FOR FIBER AND CKB SETTLEMENT",
    );
    expect(html).toContain("SETTLEMENT COMPLETE");
    expect(html).toContain("REQUEST TIMED OUT · SETTLEMENT CONTINUES");
    expect(html).toContain("forceReport.finalState");
    expect(html).toContain("channelId: this.demoChannelId(j)");
    expect(html).toContain("document.getElementById('force-close-confirm')");
    expect(html).toContain("document.getElementById('force-close-trigger')");
  });

  it("uses the dedicated daemon routes and supports restart-safe refresh", async () => {
    const html = await readFile(join(repoDir, "assets/gui/index.html"), "utf8");

    expect(html).toContain("fetch('/api/channel/force-close'");
    expect(html).toContain("fetch('/api/channel/settlement' + query)");
    expect(html).toContain("confirmChannelId: this.state.forceCloseConfirm");
    expect(html).toContain("e.key === 'Escape' && this.state.forceCloseOpen");
    expect(html).not.toContain("window.confirm");
  });
});
