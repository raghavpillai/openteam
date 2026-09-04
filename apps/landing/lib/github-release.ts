export const RELEASES_URL = "https://github.com/raghavpillai/openteam/releases";
const LATEST_RELEASE_API = "https://api.github.com/repos/raghavpillai/openteam/releases/latest";

export const desktopTargets = [
  {
    id: "mac-arm64",
    label: "macOS",
    detail: "Apple silicon",
    assetPattern: /^OpenTeam-.*-mac-arm64\.dmg$/i,
  },
  {
    id: "mac-x64",
    label: "macOS",
    detail: "Intel",
    assetPattern: /^OpenTeam-.*-mac-x64\.dmg$/i,
  },
  {
    id: "windows-x64",
    label: "Windows",
    detail: "x64 installer",
    assetPattern: /^OpenTeam-.*-win-x64\.exe$/i,
  },
  {
    id: "linux-x64",
    label: "Linux",
    detail: "x64 AppImage",
    assetPattern: /^OpenTeam-.*-linux-(?:x64|x86_64)\.AppImage$/i,
  },
] as const;

export type DesktopTargetId = (typeof desktopTargets)[number]["id"];

interface GitHubAsset {
  name: string;
  browser_download_url: string;
  size: number;
}

interface GitHubRelease {
  tag_name: string;
  html_url: string;
  published_at: string;
  assets: GitHubAsset[];
}

export interface DesktopRelease {
  version: string;
  releaseUrl: string;
  publishedAt: string;
  downloads: Record<DesktopTargetId, { url: string; size: number } | null>;
}

export function mapDesktopRelease(release: GitHubRelease): DesktopRelease {
  const downloads = Object.fromEntries(
    desktopTargets.map((target) => {
      const asset = release.assets.find((candidate) => target.assetPattern.test(candidate.name));
      return [target.id, asset ? { url: asset.browser_download_url, size: asset.size } : null];
    })
  ) as DesktopRelease["downloads"];

  return {
    version: release.tag_name.replace(/^v/, ""),
    releaseUrl: release.html_url,
    publishedAt: release.published_at,
    downloads,
  };
}

export async function getLatestDesktopRelease(): Promise<DesktopRelease> {
  const response = await fetch(LATEST_RELEASE_API, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "openteam-download-page",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    next: { revalidate: 300 },
  });

  if (!response.ok) {
    throw new Error(`GitHub releases returned HTTP ${response.status}`);
  }

  return mapDesktopRelease((await response.json()) as GitHubRelease);
}
