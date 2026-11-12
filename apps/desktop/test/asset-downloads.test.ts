import { describe, expect, test } from "bun:test";
import { createOpenTeamClient } from "@openteam/client-core";
import { downloadAssetRequests } from "../src/main/asset-downloads";

const asset = {
  assetId: "a".repeat(64),
  fileName: "shipping-label.PDF",
};
const filesFor = (baseUrl: string) => [
  {
    fileName: asset.fileName,
    url: createOpenTeamClient({ baseUrl }).assetUrl(asset, true),
  },
];

describe("native attachment download validation", () => {
  test("accepts client-generated downloads for the selected remote or local server", () => {
    for (const server of [
      "http://100.64.0.42:8787",
      "https://openteam.example.test",
      "http://127.0.0.1:8787",
      "https://openteam.example.test/team",
      "https://openteam.example.test/team/",
    ]) {
      const files = filesFor(server);
      expect(downloadAssetRequests(files, server)).toEqual(files);
    }
  });

  test("trust follows the selected server and fails closed before connection or after sign-out", () => {
    const remote = "http://100.64.0.42:8787";
    const local = "http://127.0.0.1:8787";
    expect(downloadAssetRequests(filesFor(remote), null)).toBeNull();
    expect(downloadAssetRequests(filesFor(remote), local)).toBeNull();
    expect(downloadAssetRequests(filesFor(local), remote)).toBeNull();
    expect(downloadAssetRequests(filesFor(remote), remote)).not.toBeNull();
  });

  test("rejects foreign origins, unsafe protocols, credentials, and non-asset routes", () => {
    const server = "https://openteam.example.test";
    for (const url of [
      `https://evil.test/api/v0/assets/${asset.assetId}`,
      `https://openteam.example.test.evil.test/api/v0/assets/${asset.assetId}`,
      `https://openteam.example.test:444/api/v0/assets/${asset.assetId}`,
      `http://openteam.example.test/api/v0/assets/${asset.assetId}`,
      `https://user:password@openteam.example.test/api/v0/assets/${asset.assetId}`,
      `file:///api/v0/assets/${asset.assetId}`,
      "data:application/pdf;base64,AA==",
      `https://openteam.example.test/api/v0/assets/${asset.assetId}/extra`,
      "https://openteam.example.test/api/v0/assets/not-a-hash",
      "https://openteam.example.test/api/v0/auth/session",
      `/api/v0/assets/${asset.assetId}`,
    ]) {
      expect(downloadAssetRequests([{ fileName: asset.fileName, url }], server)).toBeNull();
    }
    expect(downloadAssetRequests(filesFor(server), `${server}/team`)).toBeNull();
  });

  test("validates the whole batch and preserves the 24-file limit", () => {
    const server = "https://openteam.example.test";
    const [file] = filesFor(server);
    for (const value of [
      null,
      {},
      [],
      [null],
      ["file"],
      [{ url: file!.url }],
      [file, { fileName: asset.fileName, url: 7 }],
      Array(25).fill(file),
    ]) {
      expect(downloadAssetRequests(value, server)).toBeNull();
    }
    expect(downloadAssetRequests(Array(24).fill(file), server)).toHaveLength(24);
    for (const invalidServer of [
      "invalid",
      "file:///tmp/team",
      `${server}?query=1`,
      `${server}#fragment`,
      "https://user:password@openteam.example.test",
    ]) {
      expect(downloadAssetRequests([file], invalidServer)).toBeNull();
    }
  });

  test("keeps safe filenames while removing path and control characters", () => {
    const server = "https://openteam.example.test";
    const url = filesFor(server)[0]!.url;
    for (const [input, expected] of [
      ["../../label.PDF", "label.PDF"],
      ["C:\\labels\\label.PDF", "label.PDF"],
      ["bad\u0000:name?.pdf", "bad__name_.pdf"],
      ["", "attachment"],
      ["a".repeat(200), "a".repeat(180)],
    ]) {
      expect(downloadAssetRequests([{ fileName: input, url }], server)?.[0]?.fileName).toBe(expected);
    }
  });
});
