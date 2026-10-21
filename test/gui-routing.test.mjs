import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoDir = fileURLToPath(new URL("..", import.meta.url));

describe("GUI routing inspector", () => {
  it("labels live, inferred, attempted, and successful route data distinctly", async () => {
    const html = await readFile(join(repoDir, "assets/gui/index.html"), "utf8");

    expect(html).toContain("Routing inspector");
    expect(html).toContain("GRAPH_NODES + GRAPH_CHANNELS");
    expect(html).toContain("VIA · INFERRED PREFILL");
    expect(html).toContain("ATTEMPTED ROUTE");
    expect(html).toContain("FIBER · BUILD_ROUTER");
    expect(html).toContain("FINAL · {{ routingFinalLabel }}");
    expect(html).toContain("TOPOLOGY PREVIEW · INFERRED");
    expect(html).toContain("routingReport.finalSuccessfulRoute");
    expect(html).toContain("{{ routingSelectedCapacity }}");
    expect(html).toContain("{{ hop.channel }}");
    expect(html).toContain("Preview topology is inferred only");
  });

  it("uses separate bounded graph and explicit route endpoints", async () => {
    const html = await readFile(join(repoDir, "assets/gui/index.html"), "utf8");

    expect(html).toContain("/api/routing?net=");
    expect(html).toContain("&limit=80");
    expect(html).toContain("'/api/route/pay'");
    expect(html).toContain("'/api/route/inspect'");
    expect(html).toContain(
      "rawVia.trim() ? rawVia.split(',').map(name => name.trim()) : []",
    );
    expect(html).not.toContain(
      "/api/state?net=' + encodeURIComponent(this._forgeNet()) + '&routing",
    );
  });

  it("has complete loading, empty, error, retry, focus, and responsive states", async () => {
    const html = await readFile(join(repoDir, "assets/gui/index.html"), "utf8");

    expect(html).toContain('aria-busy="true"');
    expect(html).toContain("NO CHANNEL ANNOUNCEMENTS RETURNED");
    expect(html).toContain("ROUTING RPC UNAVAILABLE");
    expect(html).toContain('onClick="{{ reloadRouting }}"');
    expect(html).toContain("document.getElementById('routing-trigger')");
    expect(html).toContain("e.key === 'Escape' && this.state.routingOpen");
    expect(html).toContain(
      ".routing-body{grid-template-columns:1fr;overflow:auto;}",
    );
    expect(html).toContain("max-height:250px");
  });
});
