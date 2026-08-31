import { createHash } from "node:crypto";
import { basename } from "node:path";
import { normalizeRepository, normalizeVersion } from "./config";
import { CliError } from "./errors";

export interface ReleaseArtifact {
  version: string;
  composeUrl: string;
  checksumUrl: string;
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
}): Promise<ReleaseArtifact> => {
  const version = normalizeVersion(options.version);
  const composeUrl = options.composeUrl ?? releaseComposeUrl(options.repository, version);
  const checksumUrl = options.checksumUrl ?? new URL("SHA256SUMS", composeUrl).toString();
  const [compose, checksums] = await Promise.all([fetchText(composeUrl), fetchText(checksumUrl)]);
  validateCompose(compose);
  const filename = basename(new URL(composeUrl).pathname);
  const expected = checksumFor(checksums, filename);
  if (!expected) throw new CliError(`${checksumUrl} does not contain a checksum for ${filename}`);
  const actual = createHash("sha256").update(compose).digest("hex");
  if (actual !== expected) throw new CliError(`Checksum verification failed for ${composeUrl}`);
  return { version, composeUrl, checksumUrl, compose };
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
