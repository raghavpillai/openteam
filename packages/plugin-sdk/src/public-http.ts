import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { request as httpRequest, type RequestOptions } from "node:http";
import { request as httpsRequest } from "node:https";
import { canonicalHost, publicAddress } from "./browser-network/policy";

/** Validate all answers once; the socket consumes precisely this snapshot. */
export function publicHttpLookup(resolve = lookup): NonNullable<RequestOptions["lookup"]> {
  return (hostname, options, callback) => {
    resolve(hostname, { all: true }).then((answers) => {
      if (!answers.length || answers.some(({ address }) => !publicAddress(address))) {
        callback(new Error("Destination is not public"), "", 0);
        return;
      }
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

/** No ambient credentials, agents, proxy environment, cookies or automatic redirects. */
export function createPublicHttpFetch(options: {
  resolve?: typeof lookup;
  request?: typeof httpsRequest;
  httpsOnly?: boolean;
  accept?: string;
  byteLimit?: (headers: Headers) => number;
} = {}) {
  return (raw: string, init: RequestInit): Promise<Response> => new Promise((resolveResponse, reject) => {
    const url = new URL(raw);
    if (!(["http:", "https:"].includes(url.protocol)) || (options.httpsOnly && url.protocol !== "https:") || url.username || url.password)
      throw new Error("Invalid public destination");
    const host = canonicalHost(url.hostname.replace(/^\[|\]$/g, ""));
    // Node skips lookup for IP literals, so enforce the same policy here too.
    if (isIP(host) && !publicAddress(host)) throw new Error("Destination is not public");
    const outgoing = (options.request ?? (url.protocol === "https:" ? httpsRequest : httpRequest))(url, {
      agent: false,
      lookup: publicHttpLookup(options.resolve),
      signal: init.signal ?? undefined,
      headers: { accept: options.accept ?? "text/html,image/*;q=0.9,*/*;q=0.1", "accept-encoding": "identity" },
    }, (incoming) => {
      const headers = new Headers();
      for (const [name, value] of Object.entries(incoming.headers))
        if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(", ") : value);
      const status = incoming.statusCode ?? 502;
      if ([301, 302, 303, 307, 308].includes(status)) {
        incoming.destroy();
        resolveResponse(new Response(null, { status, headers }));
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      const limit = options.byteLimit?.(headers) ?? (headers.get("content-type")?.includes("html") ? 256_000 : 1_000_000);
      const fail = (error: Error) => { incoming.destroy(); outgoing.destroy(); reject(error); };
      incoming.on("error", reject);
      incoming.on("aborted", () => reject(new Error("Public response interrupted")));
      if (Number(headers.get("content-length")) > limit) { fail(new Error("Public response is too large")); return; }
      incoming.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > limit) { fail(new Error("Public response is too large")); return; }
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
