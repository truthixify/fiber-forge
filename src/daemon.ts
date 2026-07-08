/**
 * The forge daemon: a central HTTP server for the web GUI. It serves the GUI and exposes the
 * orchestrator over JSON routes so the GUI can list/create networks and drive live actions
 * (pay, open/close channel, fund, tear down) against any of them. It is network-agnostic — the
 * GUI passes `net` per request — so one daemon manages every forge network at once.
 */

import { readFile } from "node:fs/promises";
import {
  type IncomingMessage,
  type Server,
  type ServerResponse,
  createServer,
} from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type NetworkLayout } from "./config";
import {
  type ChannelRow,
  type NetworkSummary,
  type NetworkView,
  type PaymentReport,
} from "./orchestrator";
import { preset } from "./presets";
import { type Topology } from "./topology";

/** The orchestrator operations the daemon exposes over HTTP (the Orchestrator implements these). */
export interface Backend {
  inspect(net: string): Promise<NetworkView>;
  list(): Promise<NetworkSummary[]>;
  channels(net: string, node?: string): Promise<ChannelRow[]>;
  pay(
    net: string,
    from: string,
    to: string,
    amountCkb: number,
    description?: string,
  ): Promise<PaymentReport>;
  openChannelBetween(
    net: string,
    from: string,
    to: string,
    capacityCkb: number,
    onProgress?: (message: string) => void,
  ): Promise<void>;
  closeChannel(net: string, node: string, channelId: string): Promise<void>;
  fund(net: string, node: string, amountCkb: number): Promise<string>;
  createInvoice(
    net: string,
    node: string,
    amountCkb: number,
    description?: string,
  ): Promise<string>;
  logs(net: string, node: string): Promise<string>;
  down(
    net: string,
    options: { purge?: boolean; keep?: boolean },
  ): Promise<void>;
  up(
    topology: Topology,
    options: { onProgress?: (message: string) => void },
  ): Promise<NetworkLayout>;
}

interface Job {
  status: "running" | "done" | "error";
  net: string;
  progress: string[];
  error?: string;
}

async function readBody(
  request: IncomingMessage,
): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
}

function sendJson(
  response: ServerResponse,
  status: number,
  data: unknown,
): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(data));
}

const str = (v: unknown): string => String(v ?? "");
const num = (v: unknown): number => Number(v ?? 0);

/** Build a (uniquely-named) topology for a spawn request from the wizard. */
async function spawnTopology(
  backend: Backend,
  body: Record<string, unknown>,
): Promise<Topology> {
  const shape = str(body.preset || "trio");
  const count = num(body.nodes || 3);
  const named = shape === "duo" || shape === "trio" || shape === "hub";
  const base = named ? preset(shape) : preset(`${shape}:${count}`);
  if (!base) {
    throw new Error(`unknown preset "${shape}"`);
  }
  const existing = new Set((await backend.list()).map((s) => s.net));
  let name = base.name;
  for (let i = 2; existing.has(name); i += 1) {
    name = `${base.name}-${i}`;
  }
  const perNodeCkb = body.funding ? num(body.funding) : base.funding.perNodeCkb;
  return { ...base, name, funding: { perNodeCkb } };
}

/** Build the daemon HTTP server (not yet listening). */
export function createDaemon(backend: Backend): Server {
  const guiDir = join(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "assets",
    "gui",
  );
  const jobs = new Map<string, Job>();
  let jobSeq = 0;

  return createServer(async (request, response) => {
    const method = request.method ?? "GET";
    const parsed = new URL(request.url ?? "/", "http://localhost");
    const path = parsed.pathname;
    try {
      if (method === "GET" && (path === "/" || path === "/index.html")) {
        const raw = await readFile(join(guiDir, "index.html"), "utf8");
        const inject = `<script>window.__FORGE__={"central":true};</script>`;
        const html = raw.includes("<head>")
          ? raw.replace("<head>", `<head>${inject}`)
          : inject + raw;
        response.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
        });
        response.end(html);
        return;
      }
      if (method === "GET" && path === "/support.js") {
        response.writeHead(200, {
          "content-type": "text/javascript; charset=utf-8",
          "cache-control": "no-store",
        });
        response.end(await readFile(join(guiDir, "support.js"), "utf8"));
        return;
      }
      if (method === "GET" && path === "/api/networks") {
        sendJson(response, 200, await backend.list());
        return;
      }
      if (method === "GET" && path === "/api/state") {
        const net = parsed.searchParams.get("net");
        if (!net) {
          sendJson(response, 400, { error: "net query parameter required" });
          return;
        }
        sendJson(response, 200, await backend.inspect(net));
        return;
      }
      if (method === "GET" && path === "/api/channels") {
        const net = parsed.searchParams.get("net");
        if (!net) {
          sendJson(response, 400, { error: "net query parameter required" });
          return;
        }
        sendJson(response, 200, await backend.channels(net));
        return;
      }
      if (method === "GET" && path === "/api/logs") {
        const net = parsed.searchParams.get("net");
        const node = parsed.searchParams.get("node");
        if (!net || !node) {
          sendJson(response, 400, {
            error: "net and node query parameters required",
          });
          return;
        }
        sendJson(response, 200, { text: await backend.logs(net, node) });
        return;
      }
      if (method === "GET" && path === "/api/job") {
        const job = jobs.get(parsed.searchParams.get("id") ?? "");
        if (!job) {
          sendJson(response, 404, { error: "job not found" });
          return;
        }
        sendJson(response, 200, job);
        return;
      }
      if (method === "POST") {
        const body = await readBody(request);
        if (path === "/api/pay") {
          sendJson(
            response,
            200,
            await backend.pay(
              str(body.net),
              str(body.from),
              str(body.to),
              num(body.amount),
            ),
          );
          return;
        }
        if (path === "/api/channel/open") {
          await backend.openChannelBetween(
            str(body.net),
            str(body.from),
            str(body.to),
            num(body.capacity),
          );
          sendJson(response, 200, { ok: true });
          return;
        }
        if (path === "/api/channel/close") {
          await backend.closeChannel(
            str(body.net),
            str(body.node),
            str(body.channelId),
          );
          sendJson(response, 200, { ok: true });
          return;
        }
        if (path === "/api/fund") {
          const tx = await backend.fund(
            str(body.net),
            str(body.node),
            num(body.amount),
          );
          sendJson(response, 200, { tx });
          return;
        }
        if (path === "/api/invoice") {
          const invoice = await backend.createInvoice(
            str(body.net),
            str(body.node),
            num(body.amount),
          );
          sendJson(response, 200, { invoice });
          return;
        }
        if (path === "/api/down") {
          await backend.down(str(body.net), {
            purge: Boolean(body.purge),
            keep: Boolean(body.keep),
          });
          sendJson(response, 200, { ok: true });
          return;
        }
        if (path === "/api/up") {
          const topology = await spawnTopology(backend, body);
          const id = String((jobSeq += 1));
          const job: Job = {
            status: "running",
            net: topology.name,
            progress: [],
          };
          jobs.set(id, job);
          backend
            .up(topology, {
              onProgress: (message) => job.progress.push(message),
            })
            .then(() => {
              job.status = "done";
            })
            .catch((error: unknown) => {
              job.status = "error";
              job.error = (error as Error).message;
            });
          sendJson(response, 200, { jobId: id, net: topology.name });
          return;
        }
      }
      response.writeHead(404);
      response.end("not found");
    } catch (error) {
      sendJson(response, 500, { error: (error as Error).message });
    }
  });
}

/** Start the daemon listening on `port` and return the server. */
export function serveGui(backend: Backend, port: number): Promise<Server> {
  const server = createDaemon(backend);
  return new Promise((resolve) => server.listen(port, () => resolve(server)));
}
