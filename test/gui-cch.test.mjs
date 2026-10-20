import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoDir = fileURLToPath(new URL("..", import.meta.url));

describe("GUI CCH boundary", () => {
  it("keeps Fiber, the trusted operator, and Lightning visibly distinct", async () => {
    const html = await readFile(join(repoDir, "assets/gui/index.html"), "utf8");

    expect(html).toContain("CROSS-NETWORK BOUNDARY");
    expect(html).toContain("TRUSTED CCH OPERATOR");
    expect(html).toContain("LIGHTNING · REGTEST BTC");
    expect(html).toContain('role="status"');
    expect(html).toContain("cch.operator.rpcReady");
    expect(html).toContain("cch.lightning.state === 'ready'");
  });

  it("stacks the boundary and removes secondary chrome on narrow screens", async () => {
    const html = await readFile(join(repoDir, "assets/gui/index.html"), "utf8");

    expect(html).toContain("@media (max-width:600px)");
    expect(html).toContain("grid-template-columns:1fr!important");
    expect(html).toContain(
      ".floor-map,.floor-zoom,.floor-timeline{display:none!important}",
    );
  });
});
