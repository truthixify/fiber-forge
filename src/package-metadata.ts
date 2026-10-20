import { createRequire } from "node:module";

interface PackageMetadata {
  name: string;
  version: string;
  fiberForge: {
    images: {
      ckb: string;
      fiber: string;
    };
  };
}

const metadata = createRequire(import.meta.url)(
  "../package.json",
) as PackageMetadata;

if (!metadata.name || !metadata.version) {
  throw new Error("package.json does not contain valid package metadata");
}
if (!metadata.fiberForge?.images?.ckb || !metadata.fiberForge.images.fiber) {
  throw new Error("package.json does not contain the pinned runtime images");
}

export const packageName = metadata.name;
export const packageVersion = metadata.version;
export const runtimeImages = Object.freeze({
  ckb: metadata.fiberForge.images.ckb,
  fiber: metadata.fiberForge.images.fiber,
});
