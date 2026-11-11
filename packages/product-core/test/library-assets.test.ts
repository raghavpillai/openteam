import { expect, test } from "bun:test";
import { parseAssetRef } from "../src/messages";
test("Library pin metadata accepts contract-valid empty files and rejects negative sizes", () => {
  const asset = {
    assetId: "a".repeat(64),
    fileName: "empty.csv",
    mimeType: "text/csv",
    byteSize: 0,
    kind: "file",
  };
  expect(parseAssetRef(asset)?.byteSize).toBe(0);
  expect(parseAssetRef({ ...asset, byteSize: -1 })).toBeNull();
});
