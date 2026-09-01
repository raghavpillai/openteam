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

export const authRequestWithClientIp = (
  request: Request,
  requestServer: RequestIpSource,
  proxySecret: string,
  url?: URL,
  body?: string
): Request => {
  const headers = new Headers(request.headers);
  const proxyAuthenticated =
    proxySecret.length >= 32 &&
    equalSecret(request.headers.get("x-openbot-proxy") ?? "", proxySecret);
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "";
  const direct = requestServer.requestIP(request)?.address ?? "";
  const clientIp = proxyAuthenticated && isIP(forwarded) ? forwarded : direct;
  headers.delete("x-openbot-proxy");
  headers.delete("x-forwarded-for");
  headers.delete("x-forwarded-host");
  headers.delete("x-forwarded-proto");
  if (isIP(clientIp)) headers.set("x-openbot-client-ip", clientIp);
  else headers.delete("x-openbot-client-ip");
  if (body !== undefined) {
    return new Request(url ?? request.url, { method: request.method, headers, body });
  }
  return new Request(url ?? request, { headers });
};
