import { lookup } from "node:dns/promises";
import { connect } from "node:tls";

export interface PublicReadiness {
  dns: { ok: boolean; detail: string };
  endpoint: { ok: boolean; detail: string };
  tls?: { ok: boolean; detail: string };
}

const inspectCertificate = (
  host: string,
  port: number,
  timeoutMs: number
): Promise<{ ok: boolean; detail: string }> =>
  new Promise((resolve) => {
    const socket = connect({ host, port, servername: host, rejectUnauthorized: true });
    const finish = (result: { ok: boolean; detail: string }) => {
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs, () => finish({ ok: false, detail: "TLS handshake timed out" }));
    socket.once("error", (error) => finish({ ok: false, detail: error.message }));
    socket.once("secureConnect", () => {
      const certificate = socket.getPeerCertificate();
      const expires = Date.parse(certificate.valid_to || "");
      if (!Number.isFinite(expires)) {
        finish({ ok: false, detail: "certificate expiry could not be read" });
        return;
      }
      const days = Math.floor((expires - Date.now()) / 86_400_000);
      finish({
        ok: days >= 7,
        detail: `trusted certificate expires ${certificate.valid_to} (${days} days remaining)`,
      });
    });
  });

export const inspectPublicReadiness = async (
  publicUrl: string,
  timeoutMs = 10_000
): Promise<PublicReadiness> => {
  const url = new URL(publicUrl);
  let dns: PublicReadiness["dns"];
  try {
    const addresses = await lookup(url.hostname, { all: true });
    dns = addresses.length
      ? {
          ok: true,
          detail: `${url.hostname} resolves to ${addresses.map(({ address }) => address).join(", ")}`,
        }
      : { ok: false, detail: `${url.hostname} did not resolve` };
  } catch (error) {
    dns = {
      ok: false,
      detail: `${url.hostname}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  let endpoint: PublicReadiness["endpoint"];
  try {
    const response = await fetch(new URL("/api/v0/health", url), {
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = (await response.json().catch(() => null)) as { status?: unknown } | null;
    endpoint =
      response.ok && body?.status === "ready"
        ? { ok: true, detail: `${response.status} ready at ${url.origin}` }
        : {
            ok: false,
            detail: response.ok
              ? `${url.origin} did not report ready`
              : `${url.origin} returned HTTP ${response.status}`,
          };
  } catch (error) {
    endpoint = { ok: false, detail: error instanceof Error ? error.message : String(error) };
  }

  const tls =
    url.protocol === "https:"
      ? await inspectCertificate(url.hostname, Number(url.port || "443"), timeoutMs)
      : undefined;
  return { dns, endpoint, tls };
};
