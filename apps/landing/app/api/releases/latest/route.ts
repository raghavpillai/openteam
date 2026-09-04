import { getLatestDesktopRelease } from "@/lib/github-release";

export async function GET() {
  try {
    const release = await getLatestDesktopRelease();
    return Response.json(
      { available: true, release },
      { headers: { "Cache-Control": "public, max-age=60, s-maxage=300" } }
    );
  } catch {
    return Response.json(
      {
        available: false,
        message: "Desktop builds have not been published yet.",
      },
      {
        status: 404,
        headers: { "Cache-Control": "public, max-age=60, s-maxage=300" },
      }
    );
  }
}
