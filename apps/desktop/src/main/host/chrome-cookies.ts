import { createDecipheriv, createHash, pbkdf2Sync, timingSafeEqual } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, sep } from "node:path";
import { nativeCommand, sqliteRows, sqlText, type NativeCommand } from "./native-command";
import type { CapabilitySettingsStore, NativeConsent } from "./capability-settings";
interface Origin {
  origin: string;
  profileId: string;
  profileDisplayName: string;
}
const host = (value: unknown) => {
  if (
    typeof value !== "string" ||
    (!/^\.?[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(value) && !/^\[[a-f0-9:]+\]$/i.test(value))
  )
    throw new Error("Use a Chrome cookie host exactly as listed");
  return value.toLowerCase();
};
export function decryptChromeCookie(
  hex: string,
  password: string,
  domain: string,
  version: number
): string {
  const data = Buffer.from(hex, "hex");
  if (data.subarray(0, 3).toString() !== "v10")
    throw new Error(
      "This Chrome cookie encryption version is unsupported; no cookies were imported"
    );
  const key = pbkdf2Sync(password, "saltysalt", 1003, 16, "sha1");
  try {
    const decipher = createDecipheriv("aes-128-cbc", key, Buffer.alloc(16, 32));
    const clear = Buffer.concat([decipher.update(data.subarray(3)), decipher.final()]);
    if (version >= 24) {
      const digest = createHash("sha256").update(domain).digest();
      if (clear.length < 32 || !timingSafeEqual(clear.subarray(0, 32), digest))
        throw new Error("Cookie host verification failed");
      return clear.subarray(32).toString("utf8");
    }
    return clear.toString("utf8");
  } finally {
    key.fill(0);
  }
}
export class ChromeCookies {
  constructor(
    private readonly settings: CapabilitySettingsStore,
    private readonly consent: NativeConsent,
    private readonly run: NativeCommand = nativeCommand,
    private readonly root = join(homedir(), "Library", "Application Support", "Google", "Chrome")
  ) {}
  private async database(profileId: string) {
    if (!/^(?:Default|Profile \d+)$/.test(profileId)) throw new Error("Invalid Chrome profile ID");
    const root = await realpath(this.root);
    for (const path of [
      join(root, profileId, "Network", "Cookies"),
      join(root, profileId, "Cookies"),
    ]) {
      try {
        const actual = await realpath(path);
        if (!actual.startsWith(root + sep)) throw new Error("Chrome profile path escaped its root");
        if ((await stat(actual)).isFile()) return actual;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      }
    }
    throw new Error("Chrome cookie database is unavailable");
  }
  async list(signal?: AbortSignal): Promise<Origin[]> {
    let state: any;
    try {
      state = JSON.parse(await readFile(join(this.root, "Local State"), "utf8"));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw new Error("Chrome profiles are unavailable; check Full Disk Access");
    }
    const result: Origin[] = [];
    for (const [profileId, profile] of Object.entries(state.profile?.info_cache ?? {})) {
      if (!/^(?:Default|Profile \d+)$/.test(profileId)) continue;
      let path: string;
      try {
        path = await this.database(profileId);
      } catch {
        continue;
      }
      for (const row of await sqliteRows(
        this.run,
        path,
        "SELECT DISTINCT host_key FROM cookies ORDER BY host_key LIMIT 10000",
        signal
      ))
        result.push({
          origin: row.host_key,
          profileId,
          profileDisplayName: String((profile as any).name ?? profileId),
        });
    }
    return result;
  }
  async collect(botId: string, requested: unknown, signal?: AbortSignal) {
    const available = await this.list(signal);
    if (requested === undefined || (Array.isArray(requested) && !requested.length))
      return { kind: "listed", items: available };
    if (!Array.isArray(requested) || requested.length > 32)
      throw new Error("Request at most 32 listed origins");
    const pairs = new Map<string, Origin>();
    for (const entry of requested) {
      const value = typeof entry === "string" ? entry : entry?.origin;
      if (typeof value === "string" && !value.trim()) continue;
      const origin = host(value);
      const profileId = typeof entry === "string" ? null : entry?.profileId;
      const matches = available.filter(
        (x) => x.origin === origin && (profileId === null || x.profileId === profileId)
      );
      if (!matches.length)
        throw new Error(
          "Requested Chrome profile/origin was not listed. List again and use the exact profileId and host."
        );
      for (const pair of matches)
        pairs.set(JSON.stringify([botId, pair.profileId, pair.origin]), pair);
    }
    if (!pairs.size) return { kind: "listed", items: available };
    const settings = await this.settings.read();
    const epoch = settings.revocationEpoch ?? 0;
    const pending = [...pairs.keys()].filter((k) => !settings.cookieGrants.includes(k));
    let importDecision = "always_allow";
    if (pending.length) {
      const decision = await this.consent({
        title: "Import Chrome logins?",
        detail: `Allow this bot (${botId}) to use cookies from:\n${pending
          .map((k) => {
            const p = pairs.get(k)!;
            return `${p.origin} — ${p.profileDisplayName} (${p.profileId})`;
          })
          .join("\n")}\n\nThese cookies can sign the bot into those websites.`,
        allowAlways: true,
      });
      importDecision = decision === "always" ? "always_allow" : "approve_once";
      if (decision === "deny")
        throw new Error("Chrome cookie import denied. Do not retry unless asked.");
      if (decision === "always")
        await this.settings.mutate((s) => {
          if ((s.revocationEpoch ?? 0) !== epoch)
            throw new Error("Cookie access changed during review");
          return { ...s, cookieGrants: [...new Set([...s.cookieGrants, ...pending])] };
        });
    }
    if (((await this.settings.read()).revocationEpoch ?? 0) !== epoch)
      throw new Error("Cookie access was revoked during review");
    const password = (
      await this.run(
        "/usr/bin/security",
        ["find-generic-password", "-w", "-a", "Chrome", "-s", "Chrome Safe Storage"],
        signal
      )
    ).replace(/\r?\n$/, "");
    const cookies = [];
    for (const pair of pairs.values()) {
      const path = await this.database(pair.profileId);
      const version = Number(
        (await sqliteRows(this.run, path, "SELECT value FROM meta WHERE key='version'", signal))[0]
          ?.value ?? 0
      );
      const columns = new Set(
        (await sqliteRows(this.run, path, "PRAGMA table_info(cookies)", signal)).map((x) => x.name)
      );
      const extra = ["top_frame_site_key", "has_cross_site_ancestor"]
        .filter((x) => columns.has(x))
        .join(",");
      const rows = await sqliteRows(
        this.run,
        path,
        `SELECT host_key,name,value,hex(encrypted_value) encrypted,path,expires_utc,is_secure,is_httponly,samesite,has_expires${extra ? "," + extra : ""} FROM cookies WHERE host_key=${sqlText(pair.origin)} LIMIT 10000`,
        signal
      );
      for (const row of rows) {
        const expires = Number(row.expires_utc) / 1e6 - 11644473600;
        if (row.has_expires && expires <= Date.now() / 1000) continue;
        cookies.push({
          name: row.name,
          value: row.encrypted
            ? decryptChromeCookie(row.encrypted, password, row.host_key, version)
            : row.value,
          domain: row.host_key,
          path: row.path,
          secure: Boolean(row.is_secure),
          httpOnly: Boolean(row.is_httponly),
          ...(row.has_expires ? { expires } : {}),
          ...(["None", "Lax", "Strict"][row.samesite]
            ? { sameSite: ["None", "Lax", "Strict"][row.samesite] }
            : {}),
          ...(row.top_frame_site_key
            ? {
                partitionKey: {
                  topLevelSite: row.top_frame_site_key,
                  hasCrossSiteAncestor: Boolean(row.has_cross_site_ancestor),
                },
              }
            : {}),
        });
      }
    }
    if (((await this.settings.read()).revocationEpoch ?? 0) !== epoch)
      throw new Error("Cookie access was revoked during collection");
    return { kind: "collected", decision: importDecision, grants: [...pairs.values()], cookies };
  }
}
