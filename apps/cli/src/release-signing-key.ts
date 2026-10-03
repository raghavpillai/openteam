import { createHash } from "node:crypto";
import { normalizeRepository, normalizeVersion } from "./config";

/** Public trust anchor for locally built OpenTeam releases. Private material stays outside Git. */
export const LOCAL_RELEASE_KEY_ID = "openteam-local-release-2026-10-03";
export const LOCAL_RELEASE_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEP7SK+uMfd3oYi3ccEoQo2ZeJ7DdW
Zxh3lDGxyQkeKdNqLI+PX135J4Em2uXpYu5saZuq/MoeQf2HQ1sR7WaWng==
-----END PUBLIC KEY-----
`;

/** Bind a signature to the release identity and content, preventing cross-version replay. */
export const localReleaseSigningPayload = (repository: string, version: string, artifact: Uint8Array): Buffer =>
  Buffer.from(`OpenTeam release signature v1\nrepository:${normalizeRepository(repository)}\nversion:${normalizeVersion(version)}\nsha256:${createHash("sha256").update(artifact).digest("hex")}\n`);
