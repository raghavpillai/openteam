import { timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";

export interface RequestIpSource {
  requestIP(request: Request): { address: string } | null;
}

const equalSecret = (supplied: string, expected: string): boolean => {
  const suppliedBytes = Buffer.from(supplied);
  const expectedBytes = Buffer.from(expected);
  return (
    suppliedBytes.length === expectedBytes.length && timingSafeEqual(suppliedBytes, expectedBytes)
  );
};

const isPrivateAddress = (address: string): boolean => {
  const normalized = address.toLowerCase().replace(/^::ffff:/, "");
  return (
    normalized === "127.0.0.1" ||
    normalized === "::1" ||
    /^10\./.test(normalized) ||
    /^192\.168\./.test(normalized) ||
    /^172\.(?:1[6-9]|2\d|3[01])\./.test(normalized) ||
    /^(?:fc|fd)[0-9a-f]{2}:/.test(normalized) ||
    /^fe[89ab][0-9a-f]:/.test(normalized)
  );
};

export const authRequestWithClientIp = (
  request: Request,
  requestServer: RequestIpSource,
  proxySecret: string,
  url?: URL,
  body?: string,
  options: { trustPrivateForwarder?: boolean } = {}
): Request => {
  const headers = new Headers(request.headers);
  const proxyAuthenticated =
    proxySecret.length >= 32 &&
    equalSecret(request.headers.get("x-openteam-proxy") ?? "", proxySecret);
  // Trust only the hop nearest the directly connected proxy. A client can prepend
  // arbitrary X-Forwarded-For values when a custom proxy appends instead of replaces.
  const forwarded = request.headers.get("x-forwarded-for")?.split(",").at(-1)?.trim() ?? "";
  const direct = requestServer.requestIP(request)?.address ?? "";
  const trustedForwarder =
    proxyAuthenticated || (options.trustPrivateForwarder && isPrivateAddress(direct));
  const clientIp = trustedForwarder && isIP(forwarded) ? forwarded : direct;
  headers.delete("x-openteam-proxy");
  headers.delete("x-forwarded-for");
  headers.delete("x-forwarded-host");
  headers.delete("x-forwarded-proto");
  if (isIP(clientIp)) headers.set("x-openteam-client-ip", clientIp);
  else headers.delete("x-openteam-client-ip");
  if (body !== undefined) {
    return new Request(url ?? request.url, { method: request.method, headers, body });
  }
  return new Request(url ?? request, { headers });
};
