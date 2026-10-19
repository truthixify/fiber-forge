import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createFiberForge,
  preset,
  version,
  type FiberForge,
} from "../src/index";

const packageMetadata = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as { version: string };

describe("fiber-forge", () => {
  it("reports the package version", () => {
    expect(version).toBe(packageMetadata.version);
  });

  it("constructs the supported SDK without contacting Docker", () => {
    const forge: FiberForge = createFiberForge({
      stateDir: join(tmpdir(), "fiber-forge-sdk-test"),
    });
    expect(typeof forge.up).toBe("function");
    expect(typeof forge.down).toBe("function");
    expect(preset("trio")?.nodes).toHaveLength(3);
  });
});
