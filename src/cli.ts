/**
 * The `fiber-forge` CLI. Human output is calm and colorful (see {@link ui}); every data command also
 * takes `--json` for scripting. Live progress and spinners render to stderr, results to stdout.
 */

import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { type NetworkLayout } from "./config";
import { DockerEngine } from "./engine";
import { type NetworkView, Orchestrator } from "./orchestrator";
import { preset, presetHelp } from "./presets";
import { parseScenario, runScenario } from "./scenario";
import { type Topology, parseTopology } from "./topology";
import * as ui from "./ui";

/** The bundled assets directory (a sibling of `src`). */
export function assetsDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "assets");
}

/** Resolve a CLI target to a topology: a preset name, else a YAML file path. */
export async function resolveTopology(target: string): Promise<Topology> {
  const fromPreset = preset(target);
  if (fromPreset) {
    return fromPreset;
  }
  return parseTopology(await readFile(resolve(target), "utf8"));
}

function orchestrator(): Orchestrator {
  return new Orchestrator(new DockerEngine(), assetsDir());
}

/** Open a URL in the default browser (best-effort, platform-aware). */
async function openBrowser(url: string): Promise<void> {
  const command =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "start"
        : "xdg-open";
  try {
    const { spawn } = await import("node:child_process");
    spawn(command, [url], { stdio: "ignore", detached: true }).unref();
  } catch {
    // no browser available; the URL is printed regardless
  }
}

/** Serve the GUI on a free port, open it, and keep the process alive. */
async function launchGui(
  note?: string,
  opts: { spawn?: boolean } = {},
): Promise<void> {
  const { serveGui } = await import("./daemon");
  const { findFreePort } = await import("./ports");
  const port = await findFreePort(5178);
  await serveGui(orchestrator(), port);
  const base = `http://127.0.0.1:${port}`;
  const url = opts.spawn ? `${base}/?spawn=1` : base;
  console.log(ui.hint("GUI", [url]));
  console.log(
    ui.muted(
      `  Ctrl-C stops the GUI · your networks keep running${note ? ` · ${note}` : ""}\n`,
    ),
  );
  await openBrowser(url);
}

function printJson(data: unknown): void {
  console.log(JSON.stringify(data, null, 2));
}

function fail(message: string, suggestion?: string): void {
  const hint =
    suggestion ?? (/not found/.test(message) ? "fiber-forge ls" : undefined);
  console.error("\n" + ui.errorBox(message, hint) + "\n");
  process.exitCode = 1;
}

const UP_STEPS: ui.Step[] = [
  { key: "network", label: "network" },
  { key: "ckb", label: "ckb" },
  { key: "nodes", label: "nodes" },
  { key: "fund", label: "fund" },
  { key: "connect", label: "connect" },
  { key: "channels", label: "channels" },
  { key: "ready", label: "ready" },
];

function upHandler(
  progress: ui.Progress,
  totals: { nodes: number; channels: number },
): (message: string) => void {
  let nodes = 0;
  let funded = 0;
  let channels = 0;
  return (message) => {
    if (/^network .+ ready$/.test(message)) {
      progress.enter("ready");
    } else if (message.startsWith("network ")) {
      progress.enter("network");
    } else if (message.startsWith("ckb ")) {
      progress.enter("ckb");
    } else if (/^channel .+ ready$/.test(message)) {
      progress.enter("channels");
      progress.count("channels", (channels += 1), totals.channels);
    } else if (message.startsWith("open channel")) {
      progress.enter("channels", message);
    } else if (message.startsWith("connect ")) {
      progress.enter("connect", message);
    } else if (message.startsWith("funding ")) {
      progress.enter("fund");
      progress.count("fund", (funded += 1), totals.nodes);
    } else if (message.startsWith("waiting for")) {
      progress.enter("nodes", message);
    } else if (message.startsWith("node ")) {
      progress.enter("nodes");
      progress.count("nodes", (nodes += 1), totals.nodes);
    }
  };
}

function printUpCard(layout: NetworkLayout, topology: Topology): void {
  const nameWidth = Math.max(...layout.nodes.map((n) => n.name.length));
  const body: string[] = [
    `${ui.muted(ui.caps("network"))}   ${ui.text(layout.network)}`,
    `${ui.muted(ui.caps("ckb rpc"))}   ${ui.flux("http://127.0.0.1:" + layout.ckbHostPort)}`,
    "",
    ui.muted(ui.caps("nodes")),
  ];
  for (const node of layout.nodes) {
    body.push(
      `${ui.success("●")} ${ui.text(node.name.padEnd(nameWidth))}   ${ui.flux("http://127.0.0.1:" + node.rpcHostPort)}`,
    );
  }
  body.push("", ui.muted(ui.caps("channels")));
  for (const channel of topology.channels) {
    body.push(
      `${ui.text(channel.from)} ${ui.muted("→")} ${ui.text(channel.to)}   ${ui.success("●")} ${ui.text("ChannelReady")}   ${ui.gold(channel.capacityCkb + " CKB")}`,
    );
  }
  console.log("\n" + ui.box(layout.net, "ready", ui.success, body));
  const someNode = layout.nodes[0]?.name ?? "a";
  const otherNode = layout.nodes[layout.nodes.length - 1]?.name ?? "b";
  console.log(
    ui.hint("NEXT", [
      `fiber-forge status ${layout.net}`,
      `fiber-forge pay ${layout.net} ${someNode} ${otherNode} 42`,
      `fiber-forge gui ${layout.net}`,
    ]),
  );
}

function printStatus(view: NetworkView): void {
  console.log(ui.heading2(view.net));
  const nameWidth = Math.max(...view.nodes.map((n) => n.name.length));
  for (const node of view.nodes) {
    console.log(
      `  ${ui.nodeGlyph(node.status)} ${ui.text(node.name.padEnd(nameWidth))}   ${ui.muted(node.status.padEnd(7))}   ${ui.flux("http://127.0.0.1:" + node.rpcHostPort)}   ${ui.muted(ui.shortHash(node.pubkey))}`,
    );
  }
  console.log(ui.heading2("channels"));
  for (const channel of view.channels) {
    const detail =
      channel.state === "unknown"
        ? ui.error("unreachable")
        : `${ui.text(channel.state)}   ${ui.gold(channel.capacityCkb + " CKB")}`;
    console.log(
      `  ${ui.channelGlyph(channel.state)} ${ui.text(channel.from)} ${ui.muted("→")} ${ui.text(channel.to)}   ${detail}`,
    );
  }
  console.log("");
}

export function buildCli(): Command {
  const program = new Command();
  program
    .name("fiber-forge")
    .description("One-click local Fiber networks")
    .version("0.1.0");

  program
    .command("up")
    .argument(
      "[preset|file]",
      `${presetHelp()}, or a topology YAML file (omit to choose one in the GUI)`,
    )
    .option("--ckb-port <n>", "host port for the ckb rpc", (v) =>
      Number.parseInt(v, 10),
    )
    .option("--rpc-base <n>", "first host port for node rpc", (v) =>
      Number.parseInt(v, 10),
    )
    .option("--json", "print machine-readable JSON instead of the live UI")
    .option("--no-gui", "do not open the web GUI when the network is ready")
    .action(
      async (
        target: string | undefined,
        options: {
          ckbPort?: number;
          rpcBase?: number;
          json?: boolean;
          gui?: boolean;
        },
      ) => {
        if (!target) {
          if (options.gui === false) {
            fail(
              "nothing to spin up — give a preset or topology file, or drop --no-gui to pick one in the GUI",
            );
            return;
          }
          await launchGui("pick a topology, then Forge it to spawn", {
            spawn: true,
          });
          return;
        }
        const topology = await resolveTopology(target);
        const layoutOptions = {
          ckbHostPort: options.ckbPort,
          rpcHostPortBase: options.rpcBase,
        };
        if (options.json) {
          const layout = await orchestrator().up(topology, {
            layout: layoutOptions,
          });
          printJson(upResult(layout));
          return;
        }
        const progress = new ui.Progress(
          `spinning up ${topology.name}`,
          UP_STEPS,
        );
        try {
          const layout = await orchestrator().up(topology, {
            layout: layoutOptions,
            onProgress: upHandler(progress, {
              nodes: topology.nodes.length,
              channels: topology.channels.length,
            }),
          });
          progress.finish();
          printUpCard(layout, topology);
          if (options.gui !== false) {
            await launchGui(`fiber-forge down ${layout.net} to remove it`);
          }
        } catch (error) {
          progress.failActive((error as Error).message);
          fail((error as Error).message, `fiber-forge down ${topology.name}`);
        }
      },
    );

  program
    .command("down")
    .argument("[net]", "network name (omit when using --all)")
    .option("--all", "tear down every network at once")
    .option("--purge", "also delete the state dir — nothing left on disk")
    .option("--keep", "preserve the ckb data volume for a stateful restart")
    .action(
      async (
        net: string | undefined,
        options: { all?: boolean; purge?: boolean; keep?: boolean },
      ) => {
        const note = options.purge ? ui.muted("  (purged)") : "";
        if (options.all) {
          const removed = await orchestrator().downAll({
            purge: options.purge,
            keep: options.keep,
          });
          if (removed.length === 0) {
            console.log(`\n  ${ui.muted("no networks to remove")}\n`);
            return;
          }
          const plural = removed.length === 1 ? "" : "s";
          console.log(
            `\n  ${ui.success("✔")}  removed ${ui.text(String(removed.length))} network${plural} — ${removed
              .map((n) => ui.text(n))
              .join(", ")}${note}\n`,
          );
          return;
        }
        if (!net) {
          fail(
            "specify a network, or --all to tear down every one",
            "fiber-forge ls",
          );
          return;
        }
        await orchestrator().down(net, {
          purge: options.purge,
          keep: options.keep,
        });
        console.log(`\n  ${ui.success("✔")}  removed ${ui.text(net)}${note}\n`);
      },
    );

  program
    .command("status")
    .argument("<net>", "network name")
    .option("--json", "print machine-readable JSON")
    .action(async (net: string, options: { json?: boolean }) => {
      let view: NetworkView;
      try {
        view = await orchestrator().inspect(net);
      } catch {
        fail(`network "${net}" not found`, "fiber-forge ls");
        return;
      }
      if (options.json) {
        printJson(view);
        return;
      }
      printStatus(view);
    });

  program
    .command("ls")
    .alias("list")
    .description("list all fiber-forge networks")
    .option("--json", "print machine-readable JSON")
    .action(async (options: { json?: boolean }) => {
      const networks = await orchestrator().list();
      if (options.json) {
        printJson(networks);
        return;
      }
      if (networks.length === 0) {
        console.log(
          ui.muted(
            "\n  no networks yet  ·  fiber-forge up trio to create one\n",
          ),
        );
        return;
      }
      console.log(ui.heading2("networks"));
      console.log(
        ui.table(
          ["NET", "NODES", "STATE"],
          networks.map((n) => [
            ui.heading(n.net),
            ui.text(String(n.nodeCount)),
            n.running
              ? `${ui.success("●")} ${ui.text("up")}`
              : `${ui.dim("○")} ${ui.muted("stopped")}`,
          ]),
        ),
      );
      console.log(
        `\n  ${ui.muted(`${networks.length} networks  ·  fiber-forge status <net> for detail`)}\n`,
      );
    });

  program
    .command("pay")
    .argument("<net>", "network name")
    .argument("<from>", "paying node")
    .argument("<to>", "receiving node")
    .argument("<amount>", "amount (CKB, or UDT with --udt)")
    .option("--description <text>", "invoice description")
    .option("--udt", "denominate the payment in the dev UDT instead of CKB")
    .option("--json", "print machine-readable JSON")
    .action(
      async (
        net: string,
        from: string,
        to: string,
        amount: string,
        options: { description?: string; udt?: boolean; json?: boolean },
      ) => {
        const amountCkb = Number(amount);
        const unit = options.udt ? "UDT" : "CKB";
        if (options.json) {
          printJson(
            await orchestrator().pay(
              net,
              from,
              to,
              amountCkb,
              options.description,
              options.udt,
            ),
          );
          return;
        }
        const progress = new ui.Progress(
          `pay ${amountCkb} ${unit}   ${from} → ${to}`,
          [{ key: "settle", label: "settle" }],
        );
        try {
          progress.enter("settle", "creating invoice, routing payment…");
          const result = await orchestrator().pay(
            net,
            from,
            to,
            amountCkb,
            options.description,
            options.udt,
          );
          if (result.status === "Success") {
            progress.finish();
            console.log(
              "\n" +
                ui.box(`paid ${amountCkb} ${unit}`, result.status, ui.success, [
                  `${ui.success("✔")}  ${ui.text(from)} ${ui.muted("→")} ${ui.text(to)}`,
                  `${ui.muted("hash")}   ${ui.muted(ui.shortHash(result.paymentHash))}`,
                ]) +
                "\n",
            );
          } else {
            progress.fail("settle", result.status);
            fail(`payment ${result.status.toLowerCase()}`);
          }
        } catch (error) {
          progress.fail("settle", (error as Error).message);
          fail((error as Error).message);
        }
      },
    );

  program
    .command("invoice")
    .argument("<net>", "network name")
    .argument("<node>", "node that will receive the payment")
    .argument("<amount>", "amount in CKB")
    .option("--description <text>", "invoice description")
    .option("--json", "print machine-readable JSON")
    .action(
      async (
        net: string,
        node: string,
        amount: string,
        options: { description?: string; json?: boolean },
      ) => {
        const amountCkb = Number(amount);
        const invoice = await orchestrator().createInvoice(
          net,
          node,
          amountCkb,
          options.description,
        );
        if (options.json) {
          printJson({ net, node, amountCkb, invoice });
          return;
        }
        console.log(
          `\n  ${ui.muted(ui.caps("invoice"))}   ${ui.text(node)}   ${ui.gold(amountCkb + " CKB")}`,
        );
        console.log(`  ${ui.text(invoice)}\n`);
      },
    );

  const channel = program
    .command("channel")
    .description("open, close, and list channels");

  channel
    .command("open")
    .argument("<net>", "network name")
    .argument("<from>", "source node")
    .argument("<to>", "target node")
    .argument("<capacity>", "channel capacity (CKB, or UDT with --udt)")
    .option("--udt", "open a UDT-denominated channel")
    .action(
      async (
        net: string,
        from: string,
        to: string,
        capacity: string,
        options: { udt?: boolean },
      ) => {
        const capacityCkb = Number(capacity);
        const unit = options.udt ? "UDT" : "CKB";
        const progress = new ui.Progress(`open ${from} → ${to}`, [
          { key: "connect", label: "connect" },
          { key: "open", label: "open" },
          { key: "ready", label: "ready" },
        ]);
        try {
          await orchestrator().openChannelBetween(
            net,
            from,
            to,
            capacityCkb,
            (message) => {
              if (message.startsWith("connect"))
                progress.enter("connect", message);
              else if (message.startsWith("open"))
                progress.enter("open", message);
              else if (message.includes("ready")) progress.enter("ready");
            },
            options.udt,
          );
          progress.finish();
          console.log(
            `\n  ${ui.success("✔")}  channel ${ui.text(from)} ${ui.muted("→")} ${ui.text(to)}  ${ui.muted(capacityCkb + " " + unit)}  ${ui.success("ChannelReady")}\n`,
          );
        } catch (error) {
          progress.failActive((error as Error).message);
          fail((error as Error).message);
        }
      },
    );

  channel
    .command("close")
    .argument("<net>", "network name")
    .argument("<node>", "node that owns the channel")
    .argument("<channelId>", "the channel id (from `fiber-forge channel ls`)")
    .action(async (net: string, node: string, channelId: string) => {
      await orchestrator().closeChannel(net, node, channelId);
      console.log(
        `\n  ${ui.success("✔")}  closing ${ui.muted(ui.shortHash(channelId))} on ${ui.text(node)}\n`,
      );
    });

  channel
    .command("ls")
    .argument("<net>", "network name")
    .argument("[node]", "limit to one node")
    .option("--json", "print machine-readable JSON")
    .action(
      async (
        net: string,
        node: string | undefined,
        options: { json?: boolean },
      ) => {
        const rows = await orchestrator().channels(net, node);
        if (options.json) {
          printJson(rows);
          return;
        }
        console.log(ui.heading2(`channels · ${net}`));
        if (rows.length === 0) {
          console.log(ui.muted("  no channels\n"));
          return;
        }
        console.log(
          ui.table(
            ["NODE", "PEER", "STATE", "LOCAL", "REMOTE", "ID"],
            rows.map((r) => [
              ui.text(r.node),
              ui.text(r.peer),
              `${ui.channelGlyph(r.state)} ${ui.text(r.state)}`,
              ui.muted(r.localCkb + ""),
              ui.muted(r.remoteCkb + ""),
              ui.dim(ui.shortHash(r.channelId)),
            ]),
          ),
        );
        console.log("");
      },
    );

  program
    .command("logs")
    .argument("<net>", "network name")
    .argument("<node>", "node name, or 'ckb' for the chain")
    .option("--tail <n>", "number of lines", (v) => Number.parseInt(v, 10), 200)
    .option("--level <level>", "minimum level: trace|debug|info|warn|error")
    .action(
      async (
        net: string,
        node: string,
        options: { tail: number; level?: string },
      ) => {
        process.stdout.write(
          await orchestrator().logs(net, node, options.tail, options.level),
        );
      },
    );

  const udt = program.command("udt").description("dev UDT asset operations");

  udt
    .command("issue")
    .argument("<net>", "network name")
    .argument("<node>", "node that will receive the UDT")
    .argument("<amount>", "amount in whole UDT")
    .option("--json", "print machine-readable JSON")
    .action(
      async (
        net: string,
        node: string,
        amount: string,
        options: { json?: boolean },
      ) => {
        const amountUdt = Number(amount);
        const tx = await orchestrator().issueUdt(net, node, amountUdt);
        if (options.json) {
          printJson({ net, node, amountUdt, tx });
          return;
        }
        console.log(
          `\n  ${ui.muted(ui.caps("udt issue"))}   ${ui.text(node)}   ${ui.gold(amountUdt + " UDT")}`,
        );
        console.log(`  ${ui.muted("tx")}   ${ui.muted(ui.shortHash(tx))}\n`);
      },
    );

  program
    .command("run")
    .description(
      "run a scenario script (pay/open/close/fund/wait) against a network",
    )
    .argument("<net>", "network name")
    .argument("<file>", "path to a scenario YAML file")
    .option("--json", "print machine-readable JSON")
    .action(async (net: string, file: string, options: { json?: boolean }) => {
      const scenario = parseScenario(await readFile(resolve(file), "utf8"));
      const orch = orchestrator();
      if (options.json) {
        const steps = await runScenario(orch, net, scenario);
        printJson({ net, steps });
        return;
      }
      console.log(
        `\n  ${ui.accent("fiber-forge")}  ${ui.dim("·")}  ${ui.muted("scenario " + file)}\n`,
      );
      await runScenario(orch, net, scenario, (r) => {
        console.log(
          `  ${ui.dim(String(r.index + 1).padStart(2))}  ${ui.text(ui.caps(r.action).padEnd(8))}  ${ui.muted(r.summary)}`,
        );
      });
      console.log("");
    });

  program
    .command("gui")
    .description("serve the web GUI for all networks")
    .option("--port <n>", "http port", (v) => Number.parseInt(v, 10), 5178)
    .action(async (options: { port: number }) => {
      const { serveGui } = await import("./daemon");
      const { findFreePort } = await import("./ports");
      const port = await findFreePort(options.port);
      await serveGui(orchestrator(), port);
      const url = `http://127.0.0.1:${port}`;
      console.log(
        `\n  ${ui.accent("fiber-forge")}  ${ui.muted("→")}  ${ui.flux(url)}\n`,
      );
      await openBrowser(url);
    });

  return program;
}

function upResult(layout: NetworkLayout): unknown {
  return {
    net: layout.net,
    network: layout.network,
    ckbRpc: `http://127.0.0.1:${layout.ckbHostPort}`,
    nodes: layout.nodes.map((n) => ({
      name: n.name,
      rpc: `http://127.0.0.1:${n.rpcHostPort}`,
    })),
  };
}

export async function main(argv: string[] = process.argv): Promise<void> {
  try {
    await buildCli().parseAsync(argv);
  } catch (error) {
    fail((error as Error).message);
  }
}
