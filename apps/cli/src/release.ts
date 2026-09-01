import { createHash } from "node:crypto";
import { basename } from "node:path";
import { verify, type Bundle } from "sigstore";
import { normalizeRepository, normalizeVersion } from "./config";
import { CliError } from "./errors";

export interface ReleaseArtifact {
  version: string;
  composeUrl: string;
  checksumUrl: string;
  signatureUrl: string | null;
  compose: string;
}

export const releaseComposeUrl = (repository: string, version: string): string =>
  `https://github.com/${normalizeRepository(repository)}/releases/download/v${normalizeVersion(version)}/openbot-compose.yaml`;

const fetchText = async (url: string, accept = "text/plain"): Promise<string> => {
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { accept, "user-agent": "openbot-cli" },
      redirect: "follow",
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    throw new CliError(
      `Could not download ${url}: ${error instanceof Error ? error.message : error}`
    );
  }
  if (!response.ok) throw new CliError(`Could not download ${url} (HTTP ${response.status})`);
  return response.text();
};

const escapedPattern = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export const verifyReleaseSignature = async (options: {
  repository: string;
  version: string;
  compose: string;
  serializedBundle: string;
}): Promise<void> => {
  let bundle: Bundle;
  try {
    bundle = JSON.parse(options.serializedBundle) as Bundle;
  } catch {
    throw new CliError("The release signature bundle is not valid JSON");
  }
  const identity = `https://github.com/${normalizeRepository(options.repository)}/.github/workflows/release.yml@refs/tags/v${normalizeVersion(options.version)}`;
  try {
    await verify(bundle, Buffer.from(options.compose), {
      certificateIssuer: "https://token.actions.githubusercontent.com",
      certificateIdentityURI: `^${escapedPattern(identity)}$`,
      ctLogThreshold: 1,
      tlogThreshold: 1,
    });
  } catch (error) {
    throw new CliError(
      `Sigstore verification failed for OpenBot ${options.version}: ${error instanceof Error ? error.message : error}`
    );
  }
};

const checksumFor = (contents: string, filename: string): string | null => {
  for (const line of contents.split(/\r?\n/)) {
    const match = line.trim().match(/^([a-fA-F0-9]{64})\s+\*?(.+)$/);
    if (match?.[1] && match[2] === filename) return match[1].toLowerCase();
  }
  return null;
};

export const validateCompose = (contents: string): void => {
  if (contents.length < 100 || contents.length > 1_000_000) {
    throw new CliError("The downloaded Compose file has an unexpected size");
  }
  if (!/^name:\s*openbot\s*$/m.test(contents)) {
    throw new CliError("The downloaded Compose file is not an OpenBot release bundle");
  }
  if (!contents.includes("OPENBOT_VERSION") || !contents.includes("openbot_workspace")) {
    throw new CliError("The downloaded Compose file is missing required OpenBot configuration");
  }
};

export const downloadRelease = async (options: {
  repository: string;
  version: string;
  composeUrl?: string;
  checksumUrl?: string;
  signatureUrl?: string;
  allowUnsigned?: boolean;
}): Promise<ReleaseArtifact> => {
  const version = normalizeVersion(options.version);
  const composeUrl = options.composeUrl ?? releaseComposeUrl(options.repository, version);
  const checksumUrl = options.checksumUrl ?? new URL("SHA256SUMS", composeUrl).toString();
  const signatureUrl = options.allowUnsigned
    ? null
    : (options.signatureUrl ?? `${composeUrl}.sigstore.json`);
  const [compose, checksums, signature] = await Promise.all([
    fetchText(composeUrl),
    fetchText(checksumUrl),
    signatureUrl ? fetchText(signatureUrl, "application/json") : Promise.resolve(null),
  ]);
  validateCompose(compose);
  const filename = basename(new URL(composeUrl).pathname);
  const expected = checksumFor(checksums, filename);
  if (!expected) throw new CliError(`${checksumUrl} does not contain a checksum for ${filename}`);
  const actual = createHash("sha256").update(compose).digest("hex");
  if (actual !== expected) throw new CliError(`Checksum verification failed for ${composeUrl}`);
  if (signature) {
    await verifyReleaseSignature({
      repository: options.repository,
      version,
      compose,
      serializedBundle: signature,
    });
  }
  return { version, composeUrl, checksumUrl, signatureUrl, compose };
};

export const latestReleaseVersion = async (repository: string): Promise<string> => {
  const normalized = normalizeRepository(repository);
  const body = await fetchText(
    `https://api.github.com/repos/${normalized}/releases/latest`,
    "application/vnd.github+json"
  );
  let tag: unknown;
  try {
    tag = (JSON.parse(body) as { tag_name?: unknown }).tag_name;
  } catch {
    throw new CliError(`GitHub returned an invalid latest release response for ${normalized}`);
  }
  if (typeof tag !== "string") throw new CliError(`No latest release was found for ${normalized}`);
  return normalizeVersion(tag);
};
