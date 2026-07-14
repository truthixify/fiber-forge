#!/usr/bin/env node
// Runs the TypeScript CLI directly via tsx so there is no separate build step for the bin.
import { register } from "tsx/esm/api";
register();
const { main } = await import("../src/cli.ts");
await main();
