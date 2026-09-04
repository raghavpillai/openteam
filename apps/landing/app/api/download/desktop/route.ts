import {
  type DesktopTargetId,
  desktopTargets,
  getLatestDesktopRelease,
} from "@/lib/github-release";

export async function GET(request: Request) {
  const target = new URL(request.url).searchParams.get("target") as DesktopTargetId | null;
  if (!target || !desktopTargets.some((candidate) => candidate.id === target)) {
    return Response.json({ error: "Unknown desktop download target." }, { status: 400 });
  }

  try {
    const release = await getLatestDesktopRelease();
    const asset = release.downloads[target];
    if (!asset) {
      return Response.json(
        { error: `The ${target} build is not available in OpenTeam ${release.version}.` },
        { status: 404 }
      );
    }
    return Response.redirect(asset.url, 307);
  } catch {
    return Response.json(
      { error: "No public OpenTeam desktop release is available yet." },
      { status: 404 }
    );
  }
}
