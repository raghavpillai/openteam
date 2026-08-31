import { timingSafeEqual } from "node:crypto";

const tokenMatches = (expected: string, supplied: string): boolean => {
  const expectedBytes = Buffer.from(expected);
  const suppliedBytes = Buffer.from(supplied);
  return (
    expectedBytes.length === suppliedBytes.length && timingSafeEqual(expectedBytes, suppliedBytes)
  );
};

export const isLoopbackAddress = (address: string | null | undefined): boolean =>
  address === "::1" ||
  address === "0:0:0:0:0:0:0:1" ||
  address?.startsWith("127.") === true ||
  address?.startsWith("::ffff:127.") === true;

export const isLoopbackHostname = (hostname: string): boolean =>
  hostname === "localhost" || hostname === "::1" || hostname.startsWith("127.");

export const isTrustedLocalApiClient = (
  address: string | null | undefined,
  hostname: string,
  trustLoopback: boolean
): boolean => trustLoopback && (isLoopbackAddress(address) || isLoopbackHostname(hostname));

export const authorizedApi = (
  request: Request,
  expectedToken: string | null,
  clientAddress: string | null | undefined,
  trustLoopback: boolean
): boolean => {
  if (!expectedToken) return true;
  if (trustLoopback && isLoopbackAddress(clientAddress)) return true;
  const supplied = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  return tokenMatches(expectedToken, supplied);
};
