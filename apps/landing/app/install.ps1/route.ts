import { powerShellInstallScript } from "@/lib/install-script";

export const dynamic = "force-static";

export function GET() {
  return new Response(powerShellInstallScript, {
    headers: {
      "Cache-Control": "public, max-age=300, s-maxage=300",
      "Content-Type": "text/plain; charset=utf-8",
      "Content-Disposition": 'inline; filename="openteam-install.ps1"',
      "X-Content-Type-Options": "nosniff",
    },
  });
}
