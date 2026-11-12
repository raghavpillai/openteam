import { lookup } from "node:dns/promises";
import { request as httpRequest, type RequestOptions } from "node:http";
import { request as httpsRequest } from "node:https";
import { publicAddress } from "@openteam/plugin-sdk/browser-network/policy";

/** Validate every DNS answer, then hand those exact addresses to the socket. */
export function publicFaviconLookup(resolve = lookup): NonNullable<RequestOptions["lookup"]> {
  return (hostname, options, callback) => {
    resolve(hostname, { all: true }).then((answers) => {
      if (!answers.length || answers.some(({ address }) => !publicAddress(address))) {
        callback(new Error("Favicon destination is not public"), "", 0);
        return;
      }
      // Node's family selection must consume these pinned answers, never resolve again.
      if (typeof options === "object" && options.all) callback(null, answers);
      else {
        const family = typeof options === "number" ? options : options.family;
        const answer = answers.find((answer) => !family || answer.family === family);
        if (!answer) callback(new Error("No matching public address"), "", 0);
        else callback(null, answer.address, answer.family);
      }
    }, (error: Error) => callback(error, "", 0));
  };
}

/** Cookie-free single-hop transport. Redirects are validated by the caller. */
export function createPublicFaviconFetch(resolve = lookup) {
  const pinnedLookup = publicFaviconLookup(resolve);
  return (raw: string, init: RequestInit): Promise<Response> => new Promise((resolveResponse, reject) => {
    const url = new URL(raw);
    const request = url.protocol === "https:" ? httpsRequest : httpRequest;
    const outgoing = request(url, {
      agent: false,
      lookup: pinnedLookup,
      signal: init.signal ?? undefined,
      headers: { accept: "text/html,image/*;q=0.9,*/*;q=0.1", "accept-encoding": "identity" },
    }, (incoming) => {
      const headers = new Headers();
      for (const [name, value] of Object.entries(incoming.headers)) {
        if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(", ") : value);
      }
      const status = incoming.statusCode ?? 502;
      if ([301, 302, 303, 307, 308].includes(status)) {
        incoming.destroy();
        resolveResponse(new Response(null, { status, headers }));
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      const limit = headers.get("content-type")?.includes("html") ? 256_000 : 1_000_000;
      incoming.on("error", reject);
      incoming.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > limit) {
          incoming.destroy(new Error("Favicon response is too large"));
          return;
        }
        chunks.push(chunk);
      });
      incoming.on("end", () => {
        try {
          const body = [204, 205, 304].includes(status) ? null : new Uint8Array(Buffer.concat(chunks));
          resolveResponse(new Response(body, { status, headers }));
        } catch (error) { reject(error); }
      });
    });
    outgoing.on("error", reject);
    outgoing.end();
  });
}
