import { getDomain } from "tldts";
export type CredentialTargetRule =
  | { kind: "registrable-domain"; registrableDomain: string }
  | { kind: "exact-host-port"; scheme: string; host: string; port: number };
const hostname = (url: URL) => url.hostname.toLowerCase().replace(/\.$/, "");
const port = (url: URL) => Number(url.port || (url.protocol === "https:" ? 443 : 80));
export function credentialRules(sites: string[]): CredentialTargetRule[] {
  return sites.map((site) => {
    const url = new URL(site);
    const host = hostname(url);
    const domain = getDomain(host, { allowPrivateDomains: true });
    return domain && url.protocol === "https:" && !url.port
      ? { kind: "registrable-domain", registrableDomain: domain }
      : { kind: "exact-host-port", scheme: url.protocol.slice(0, -1), host, port: port(url) };
  });
}
export function matchCredentialRules(
  rules: CredentialTargetRule[],
  site: string,
  exactOrigin = false
): boolean {
  const target = new URL(site);
  const host = hostname(target);
  if (
    target.protocol !== "https:" &&
    !(
      target.protocol === "http:" &&
      (host === "localhost" || host === "[::1]" || host.startsWith("127."))
    )
  )
    return false;
  return rules.some((rule) =>
    rule.kind === "exact-host-port"
      ? target.protocol === rule.scheme + ":" && host === rule.host && port(target) === rule.port
      : exactOrigin
        ? host === rule.registrableDomain && target.protocol === "https:" && port(target) === 443
        : getDomain(host, { allowPrivateDomains: true }) === rule.registrableDomain
  );
}
