/**
 * The `forge` CLI: bring local Fiber networks up, tear them down, and inspect them. A target is
 * either a built-in preset name or a path to a topology YAML file.
 */

import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { DockerEngine } from "./engine";
import { Orchestrator } from "./orchestrator";
import { preset, presetNames } from "./presets";
import { type Topology, parseTopology } from "./topology";

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

export function buildCli(): Command {
  const program = new Command();
  program
    .name("forge")
    .description("One-click local Fiber networks")
    .version("0.1.0");

  program
    .command("up")
    .argument(
      "<preset|file>",
      `a preset (${presetNames().join(", ")}) or a topology YAML file`,
    )
    .option("--ckb-port <n>", "host port for the ckb rpc", (v) =>
      Number.parseInt(v, 10),
    )
    .option("--rpc-base <n>", "first host port for node rpc", (v) =>
      Number.parseInt(v, 10),
    )
    .action(
      async (
        target: string,
        options: { ckbPort?: number; rpcBase?: number },
      ) => {
        const topology = await resolveTopology(target);
        const layout = await orchestrator().up(topology, {
          layout: {
            ckbHostPort: options.ckbPort,
            rpcHostPortBase: options.rpcBase,
          },
          onProgress: (message) => console.error("› " + message),
        });
        console.log(
          JSON.stringify(
            {
              net: layout.net,
              network: layout.network,
              ckbRpc: `http://127.0.0.1:${layout.ckbHostPort}`,
              nodes: layout.nodes.map((n) => ({
                name: n.name,
                rpc: `http://127.0.0.1:${n.rpcHostPort}`,
              })),
            },
            null,
            2,
          ),
        );
      },
    );

  program
    .command("down")
    .argument("<net>", "network name")
    .option("--purge", "also delete the network's state and data volume")
    .action(async (net: string, options: { purge?: boolean }) => {
      await orchestrator().down(net, { purge: Boolean(options.purge) });
      console.error(`removed network ${net}`);
    });

  program
    .command("status")
    .argument("<net>", "network name")
    .action(async (net: string) => {
      console.log(JSON.stringify(await orchestrator().status(net), null, 2));
    });

  program
    .command("gui")
    .argument("<net>", "network name")
    .option("--port <n>", "http port", (v) => Number.parseInt(v, 10), 5178)
    .action(async (net: string, options: { port: number }) => {
      const { serveGui } = await import("./daemon");
      await serveGui(orchestrator(), net, options.port);
      console.error(
        `fiber-forge GUI for '${net}' at http://127.0.0.1:${options.port}`,
      );
    });

  return program;
}

export async function main(argv: string[] = process.argv): Promise<void> {
  await buildCli().parseAsync(argv);
}
