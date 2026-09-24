import { getLatestDesktopRelease, ReleaseLookupError } from "@/lib/github-release";

export async function GET() {
  try {
    const release = await getLatestDesktopRelease();
    return Response.json(
      { available: true, release },
      { headers: { "Cache-Control": "public, max-age=60, s-maxage=300" } }
    );
  } catch (error) {
    const unpublished = error instanceof ReleaseLookupError && error.status === 404;
    return Response.json(
      {
        available: false,
        message: unpublished
          ? "Desktop builds have not been published yet."
          : "Could not load the latest release.",
      },
      {
        status: unpublished ? 404 : 502,
        headers: { "Cache-Control": "public, max-age=60, s-maxage=300" },
      }
    );
  }
}
