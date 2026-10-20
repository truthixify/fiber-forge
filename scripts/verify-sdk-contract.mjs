import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { format } from "prettier";
import ts from "typescript";

const repoDir = fileURLToPath(new URL("..", import.meta.url));
const actualPath = join(repoDir, "dist", "sdk.d.ts");
const expectedPath = join(
  repoDir,
  "test",
  "fixtures",
  "sdk-consumer",
  "api-surface.d.ts",
);

function normalized(value) {
  return value.replaceAll("\r\n", "\n").trimEnd() + "\n";
}

const [actualRaw, expectedRaw] = await Promise.all([
  readFile(actualPath, "utf8"),
  readFile(expectedPath, "utf8"),
]);
const actual = normalized(await format(actualRaw, { parser: "typescript" }));
const expected = normalized(expectedRaw);

if (actual !== expected) {
  const actualLines = actual.split("\n");
  const expectedLines = expected.split("\n");
  const index = Array.from(
    { length: Math.max(actualLines.length, expectedLines.length) },
    (_value, line) => line,
  ).find((line) => actualLines[line] !== expectedLines[line]);
  throw new Error(
    [
      "public SDK declaration changed; review it and update api-surface.d.ts intentionally",
      `first difference at line ${(index ?? 0) + 1}`,
      `expected: ${expectedLines[index ?? 0] ?? "<end of file>"}`,
      `actual:   ${actualLines[index ?? 0] ?? "<end of file>"}`,
    ].join("\n"),
  );
}

const source = ts.createSourceFile(
  actualPath,
  actual,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TS,
);
if (source.parseDiagnostics.length > 0) {
  throw new Error(
    `generated SDK declaration is not parseable: ${source.parseDiagnostics
      .map((diagnostic) => diagnostic.messageText)
      .join("; ")}`,
  );
}

const forbiddenNames = new Set([
  "ContainerEngine",
  "DevChain",
  "DockerEngine",
  "FnnRpc",
  "HttpTransport",
  "Orchestrator",
]);
const leakedNames = new Set();
function visit(node) {
  if (ts.isIdentifier(node) && forbiddenNames.has(node.text)) {
    leakedNames.add(node.text);
  }
  ts.forEachChild(node, visit);
}
visit(source);
if (leakedNames.size > 0) {
  throw new Error(
    `public SDK declaration leaked internal types: ${[...leakedNames].sort().join(", ")}`,
  );
}

console.log("public SDK declaration matches the reviewed contract");
