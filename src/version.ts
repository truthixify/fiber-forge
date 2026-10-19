import { readFileSync } from "node:fs";

interface PackageMetadata {
  version: string;
}

function readPackageVersion(): string {
  const metadata = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  ) as Partial<PackageMetadata>;
  if (typeof metadata.version !== "string" || metadata.version.length === 0) {
    throw new Error("package.json does not contain a valid version");
  }
  return metadata.version;
}

/** The installed Fiber Forge package version. */
export const version = readPackageVersion();
