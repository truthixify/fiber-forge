/**
 * The forge daemon: a tiny HTTP server that serves the web GUI and a live-state endpoint
 * (`GET /api/state`) for one running network. The GUI polls that endpoint to render the graph.
 */

import { readFile } from "node:fs/promises";
import { type Server, createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type NetworkView } from "./orchestrator";

/** Anything that can produce a live view of a network (the Orchestrator, or a fake in tests). */
export interface Inspector {
  inspect(net: string): Promise<NetworkView>;
}

/** Build the daemon HTTP server for one network (not yet listening). */
export function createDaemon(inspector: Inspector, net: string): Server {
  const guiDir = join(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "assets",
    "gui",
  );
  return createServer(async (request, response) => {
    const url = request.url ?? "/";
    try {
      if (url === "/" || url === "/index.html") {
        const raw = await readFile(join(guiDir, "index.html"), "utf8");
        const inject = `<script>window.__FORGE__=${JSON.stringify({ net })};</script>`;
        const html = raw.includes("<head>")
          ? raw.replace("<head>", `<head>${inject}`)
          : inject + raw;
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end(html);
        return;
      }
      if (url === "/support.js") {
        response.writeHead(200, {
          "content-type": "text/javascript; charset=utf-8",
        });
        response.end(await readFile(join(guiDir, "support.js"), "utf8"));
        return;
      }
      if (url.startsWith("/api/state")) {
        const view = await inspector.inspect(net);
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(view));
        return;
      }
      response.writeHead(404);
      response.end("not found");
    } catch (error) {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: (error as Error).message }));
    }
  });
}

/** Start the daemon listening on `port` and return the server. */
export function serveGui(
  inspector: Inspector,
  net: string,
  port: number,
): Promise<Server> {
  const server = createDaemon(inspector, net);
  return new Promise((resolve) => server.listen(port, () => resolve(server)));
}
