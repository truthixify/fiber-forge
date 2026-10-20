/**
 * The fiber-forge daemon: a central HTTP server for the web GUI. It serves the GUI and exposes the
 * orchestrator over JSON routes so the GUI can list/create networks and drive live actions
 * (pay, open/close channel, fund, tear down) against any of them. It is network-agnostic — the
 * GUI passes `net` per request — so one daemon manages every fiber-forge network at once.
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
import { type WebSocket, WebSocketServer } from "ws";
import { type NetworkLayout } from "./config.js";
import {
  type ChannelRow,
  type ChannelSettlementReport,
  type ForceCloseOptions,
  type NetworkSummary,
  type NetworkView,
  type NodeLifecycleReport,
  type PaymentReport,
} from "./orchestrator.js";
import { preset } from "./presets.js";
import { type Topology } from "./topology.js";

/** The orchestrator operations the daemon exposes over HTTP (the Orchestrator implements these). */
export interface Backend {
  inspect(net: string): Promise<NetworkView>;
  inspectNode(net: string, node: string): Promise<NodeLifecycleReport>;
  stopNode(net: string, node: string): Promise<NodeLifecycleReport>;
  startNode(net: string, node: string): Promise<NodeLifecycleReport>;
  restartNode(net: string, node: string): Promise<NodeLifecycleReport>;
  list(): Promise<NetworkSummary[]>;
  channels(net: string, node?: string): Promise<ChannelRow[]>;
  pay(
    net: string,
    from: string,
    to: string,
    amountCkb: number,
    description?: string,
    udt?: boolean,
  ): Promise<PaymentReport>;
  openChannelBetween(
    net: string,
    from: string,
    to: string,
    capacityCkb: number,
    onProgress?: (message: string) => void,
    udt?: boolean,
  ): Promise<void>;
  issueUdt(net: string, node: string, amountUdt: number): Promise<string>;
  closeChannel(net: string, node: string, channelId: string): Promise<void>;
  forceCloseChannel(
    net: string,
    node: string,
    channelId: string,
    options: ForceCloseOptions,
  ): Promise<ChannelSettlementReport>;
  inspectChannelSettlement(
    net: string,
    node: string,
    channelId: string,
  ): Promise<ChannelSettlementReport>;
  fund(net: string, node: string, amountCkb: number): Promise<string>;
  createInvoice(
    net: string,
    node: string,
    amountCkb: number,
    description?: string,
    udt?: boolean,
  ): Promise<string>;
  logs(net: string, node: string): Promise<string>;
  down(
    net: string,
    options: { purge?: boolean; keep?: boolean },
  ): Promise<void>;
  up(
    topology: Topology,
    options: {
      onProgress?: (message: string) => void;
      udtPerNode?: number;
    },
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
  const named =
    shape === "duo" || shape === "trio" || shape === "hub" || shape === "cch";
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
  // If the GUI sent the node names it previewed, use them so the spawned network matches the
  // preview instead of getting a fresh random set from the preset.
  const names = Array.isArray(body.names)
    ? (body.names as unknown[]).map((n) => String(n))
    : null;
  if (names && names.length === base.nodes.length) {
    const remap: Record<string, string> = {};
    base.nodes.forEach((node, i) => {
      remap[node.name] = names[i];
    });
    return {
      ...base,
      name,
      nodes: base.nodes.map((_node, i) => ({ name: names[i] })),
      channels: base.channels.map((c) => ({
        ...c,
        from: remap[c.from],
        to: remap[c.to],
      })),
      funding: { perNodeCkb },
      ...(base.cch
        ? {
            cch: {
              ...base.cch,
              hubNode: remap[base.cch.hubNode],
              userNode: remap[base.cch.userNode],
            },
          }
        : {}),
    };
  }
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

  const server = createServer(async (request, response) => {
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
      if (method === "GET" && path === "/api/channel/settlement") {
        const net = parsed.searchParams.get("net");
        const node = parsed.searchParams.get("node");
        const channelId = parsed.searchParams.get("channelId");
        if (!net || !node || !channelId) {
          sendJson(response, 400, {
            error: "net, node, and channelId query parameters required",
          });
          return;
        }
        sendJson(
          response,
          200,
          await backend.inspectChannelSettlement(net, node, channelId),
        );
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
              undefined,
              Boolean(body.udt),
            ),
          );
          return;
        }
        if (path === "/api/node/lifecycle") {
          const net = str(body.net);
          const node = str(body.node);
          const action = str(body.action);
          const result =
            action === "inspect"
              ? await backend.inspectNode(net, node)
              : action === "stop"
                ? await backend.stopNode(net, node)
                : action === "start"
                  ? await backend.startNode(net, node)
                  : action === "restart"
                    ? await backend.restartNode(net, node)
                    : null;
          if (!result) {
            sendJson(response, 400, {
              error: "action must be inspect, stop, start, or restart",
            });
            return;
          }
          sendJson(response, 200, result);
          return;
        }
        if (path === "/api/channel/open") {
          await backend.openChannelBetween(
            str(body.net),
            str(body.from),
            str(body.to),
            num(body.capacity),
            undefined,
            Boolean(body.udt),
          );
          sendJson(response, 200, { ok: true });
          return;
        }
        if (path === "/api/udt/issue") {
          const tx = await backend.issueUdt(
            str(body.net),
            str(body.node),
            num(body.amount),
          );
          sendJson(response, 200, { tx });
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
        if (path === "/api/channel/force-close") {
          const report = await backend.forceCloseChannel(
            str(body.net),
            str(body.node),
            str(body.channelId),
            {
              confirmChannelId: str(body.confirmChannelId),
              timeoutMs:
                body.timeoutMs === undefined ? undefined : num(body.timeoutMs),
              mineBlocksPerPoll:
                body.mineBlocksPerPoll === undefined
                  ? undefined
                  : num(body.mineBlocksPerPoll),
            },
          );
          sendJson(response, 200, report);
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
            undefined,
            Boolean(body.udt),
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
              udtPerNode: num(body.udtFunding) || undefined,
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

  attachStateSocket(server, backend);
  return server;
}

/**
 * A WebSocket at `/ws` that pushes live network state. A client sends `{"sub":"<net>"}`; the
 * daemon then inspects that network on a short interval (only while someone is watching) and
 * pushes each {@link NetworkView} to its subscribers — so the GUI updates without polling.
 */
function attachStateSocket(server: Server, backend: Backend): void {
  const wss = new WebSocketServer({ server, path: "/ws" });
  const subscribers = new Map<string, Set<WebSocket>>();
  const timers = new Map<string, ReturnType<typeof setInterval>>();

  const startNet = (net: string): void => {
    if (timers.has(net)) {
      return;
    }
    let inFlight = false;
    const tick = async (): Promise<void> => {
      const clients = subscribers.get(net);
      if (!clients || clients.size === 0 || inFlight) {
        return;
      }
      inFlight = true;
      try {
        const message = JSON.stringify(await backend.inspect(net));
        for (const socket of clients) {
          if (socket.readyState === socket.OPEN) {
            socket.send(message);
          }
        }
      } catch {
        // transient (node restarting, chain busy); the next tick retries
      } finally {
        inFlight = false;
      }
    };
    timers.set(net, setInterval(tick, 1500));
    void tick();
  };

  const stopIfIdle = (net: string): void => {
    const clients = subscribers.get(net);
    if ((!clients || clients.size === 0) && timers.has(net)) {
      clearInterval(timers.get(net)!);
      timers.delete(net);
    }
  };

  wss.on("connection", (socket) => {
    let joined: string | null = null;
    socket.on("message", (data) => {
      let message: { sub?: unknown };
      try {
        message = JSON.parse(String(data)) as { sub?: unknown };
      } catch {
        return;
      }
      if (typeof message.sub === "string") {
        if (joined) {
          subscribers.get(joined)?.delete(socket);
          stopIfIdle(joined);
        }
        joined = message.sub;
        if (!subscribers.has(joined)) {
          subscribers.set(joined, new Set());
        }
        subscribers.get(joined)!.add(socket);
        startNet(joined);
      }
    });
    const leave = (): void => {
      if (joined) {
        subscribers.get(joined)?.delete(socket);
        stopIfIdle(joined);
      }
    };
    socket.on("close", leave);
    socket.on("error", leave);
  });
}

/** Start the daemon listening on `port` and return the server. */
export function serveGui(backend: Backend, port: number): Promise<Server> {
  const server = createDaemon(backend);
  return new Promise((resolve) =>
    server.listen(port, "127.0.0.1", () => resolve(server)),
  );
}
