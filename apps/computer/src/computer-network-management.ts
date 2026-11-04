import { Resolver } from "node:dns/promises";
import { isIP } from "node:net";
import { execFile } from "node:child_process";

/** Runs only inside the marked relay worker. Docker service discovery must
 * remain available before the API server exists and before any exit lease.
 * Resolve through the underlay DNS, bypassing /etc/hosts and application DoH. */
export function startManagementDiscovery(
  serverUrl: string,
  ready: () => void,
  options: {
    intervalMs?: number;
    helper?: string;
    resolve?: (hostname: string) => Promise<string[]>;
    apply?: (addresses: string[]) => Promise<void>;
  } = {}
) {
  const hostname = new URL(serverUrl).hostname.replace(/^\[|\]$/g, "");
  const resolver = new Resolver({ timeout: 1000, tries: 1 });
  const controller = new AbortController();
  let stopped = false,
    pending = false,
    started = false,
    previous = "";
  const resolve =
    options.resolve ??
    (async (host: string) => {
      if (isIP(host)) return [host];
      const results = await Promise.allSettled([resolver.resolve4(host), resolver.resolve6(host)]);
      return results.flatMap((result) => (result.status === "fulfilled" ? result.value : []));
    });
  const apply =
    options.apply ??
    ((addresses: string[]) =>
      new Promise<void>((yes, no) => {
        execFile(
          "/usr/bin/python3",
          [
            "-I",
            "-S",
            options.helper ?? "/usr/lib/openteam/bin/openteam-computer-network.py",
            "--management",
            serverUrl,
            JSON.stringify(addresses),
          ],
          { timeout: 3000, signal: controller.signal, env: { PATH: process.env.PATH } },
          (error) => (error ? no(new Error("Management route unavailable")) : yes())
        );
      }));
  const refresh = async () => {
    if (stopped || pending) return;
    pending = true;
    try {
      const addresses = [...new Set(await resolve(hostname))]
        .filter((address) => isIP(address))
        .sort();
      if (stopped || !addresses.length) return;
      const key = addresses.join(",");
      if (key !== previous) {
        await apply(addresses);
        if (stopped) return;
        previous = key;
      }
      if (!started) {
        started = true;
        ready();
      }
    } catch {
      // Boot stays blocked until discovery succeeds. Transient DNS failures
      // preserve the last working management route and retry independently.
    } finally {
      pending = false;
    }
  };
  const timer = setInterval(() => void refresh(), options.intervalMs ?? 2000);
  timer.unref();
  void refresh();
  return {
    stop() {
      stopped = true;
      clearInterval(timer);
      controller.abort();
      resolver.cancel();
    },
  };
}
