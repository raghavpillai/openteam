/** The page a request_box_help handoff should show: hosts to look for among open tabs, and an
 * address to open when no web page is open. */
export interface BoxHelpPage {
  hosts: string[];
  domain?: string;
  url?: string;
}

const hostOf = (raw: string | undefined): string | undefined => {
  const value = raw?.trim().toLowerCase();
  if (!value) return undefined;
  try {
    return new URL(value.includes("://") ? value : `https://${value}`).hostname || undefined;
  } catch {
    return undefined;
  }
};

export const webHost = (raw: string): string | undefined => {
  try {
    const url = new URL(raw);
    return url.protocol === "https:" || url.protocol === "http:" ? url.hostname : undefined;
  } catch {
    return undefined;
  }
};

/** The domain itself or one of its subdomains. */
export const onSite = (host: string, domain: string): boolean => host === domain || host.endsWith(`.${domain}`);

export function boxHelpPage(input: { url?: string; domain?: string; idp_domain?: string }): BoxHelpPage | undefined {
  const domain = hostOf(input.domain)?.replace(/^www\./, "");
  const idp = hostOf(input.idp_domain);
  let url: string | undefined;
  const raw = input.url?.trim();
  if (raw) {
    try {
      const parsed = new URL(raw.includes("://") ? raw : `https://${raw}`);
      const host = webHost(parsed.href);
      // Only an address on the destination's site or the IdP host counts; any other one is ignored.
      if (host && ((idp && host === idp) || (domain && onSite(host, domain)))) url = parsed.href;
    } catch {
      url = undefined;
    }
  }
  const hosts = [...new Set([idp, url && webHost(url), domain].filter((host): host is string => Boolean(host)))];
  if (!hosts.length) return undefined;
  return { hosts, ...(domain ? { domain } : {}), ...(url ? { url } : {}) };
}
