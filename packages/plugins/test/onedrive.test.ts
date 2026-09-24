import { expect, test } from "bun:test";
import { oneDriveTools } from "../onedrive/connector/server";

test("OneDrive reads encode resource IDs and search text, and preserve provider pagination", async () => {
  const requests: Array<{ url: URL; init?: RequestInit }> = [];
  const next = "https://graph.microsoft.com/v1.0/me/drive/root/children?$skiptoken=next%2Bpage";
  const tools = oneDriveTools("fixture-token", (async (input, init) => {
    requests.push({ url: new URL(String(input)), init });
    return Response.json({ value: [{ id: "fixture" }], "@odata.nextLink": next });
  }) as typeof fetch);
  const call = (name: string, args = {}) => tools.find((tool) => tool.name === name)!.run(args);
  await call("get_profile");
  expect(requests[0]!.url.pathname).toBe("/v1.0/me");
  const page = (await call("list_drive_items")) as Record<string, unknown>;
  await call("list_drive_items", { pageToken: page["@odata.nextLink"] });
  expect(requests[2]!.url.href).toBe(next);
  await call("get_drive_item", { fileId: "folder/file" });
  expect(requests[3]!.url.pathname).toBe("/v1.0/me/drive/items/folder%2Ffile");
  await call("search_drive_items", { query: "Bob's notes & plans" });
  expect(decodeURIComponent(requests[4]!.url.pathname)).toBe(
    "/v1.0/me/drive/root/search(q='Bob''s notes & plans')"
  );
  expect(tools.every((tool) => tool.annotations.readOnlyHint)).toBe(true);
  for (const request of requests) {
    expect(request.init?.headers).toEqual({ authorization: "Bearer fixture-token" });
    expect(request.init?.redirect).toBe("error");
  }
  for (const pageToken of [
    "https://example.com/children",
    "http://graph.microsoft.com/v1.0/me/drive/root/children",
    "https://graph.microsoft.com/v1.0/users/children",
  ]) {
    await expect(call("list_drive_items", { pageToken })).rejects.toThrow(
      "Invalid OneDrive page token"
    );
  }
  expect(requests).toHaveLength(5);
});

test("OneDrive missing auth and provider errors never return credentials or provider bodies", async () => {
  let requests = 0;
  const fetcher = (async () => {
    requests++;
    return new Response("private provider response fixture-token", { status: 401 });
  }) as unknown as typeof fetch;
  await expect(oneDriveTools("", fetcher)[0]!.run({})).rejects.toThrow(
    "Authenticate OneDrive first"
  );
  expect(requests).toBe(0);
  await expect(oneDriveTools("fixture-token", fetcher)[0]!.run({})).rejects.toThrow(
    "OneDrive returned 401"
  );
  expect(requests).toBe(1);
});
