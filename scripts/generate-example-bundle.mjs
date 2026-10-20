import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { buildBundleArchive } from "../src/bundle.ts";

const repoDir = fileURLToPath(new URL("..", import.meta.url));
const exampleDir = join(repoDir, "docs", "examples", "export-v1");
const manifest = JSON.parse(
  await readFile(join(exampleDir, "manifest.json"), "utf8"),
);
const artifacts = new Map(
  await Promise.all(
    manifest.artifacts.map(async (artifact) => [
      artifact.path,
      await readFile(join(exampleDir, artifact.path)),
    ]),
  ),
);
const archive = buildBundleArchive(manifest, artifacts);
const output = join(exampleDir, "failure.ffbundle");
await writeFile(output, archive, { mode: 0o644 });
console.log(`wrote ${output} (${archive.length} bytes)`);
