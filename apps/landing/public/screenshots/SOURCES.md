# Desktop captures

The `linux-*.png` files were captured on 2026-09-12 from a disposable screen session in the current OpenTeam computer image. Each is an unmodified 1280 × 800 frame with the real XFCE desktop, dock, and Chromium browser chrome.

The pages displayed in Chromium are local, illustrative HTML. Northstar, vendor prices, dashboard metrics, and the code review are sample data. No real account or credentials are shown.

- `linux-sign-in.png`: sample sign-in page.
- `linux-vendor-review.png`: vendor comparison report.
- `linux-dashboard.png`: sample workspace dashboard.
- `linux-code-review.png`: sample date-parser fix.

Capture sources and reproducible sample HTML: `output/landing-screen-assets-0912/` in the project workspace. The disposable screen session was removed after capture.

## Plugin captures

The `plugins-*.png` files are lossless 3000 × 2100 captures of the shipping desktop `PluginDialog`, rendered at its logical 1000 × 700 size with the app's current styles on 2026-09-12. They were captured directly as PNG at 3× scale through Chrome's screenshot API using CUA, without raster upscaling or JPEG conversion. The local fixture is `apps/desktop/test/browser/plugin-reference.tsx`. Catalog names and descriptions come from the bundled plugin manifests; accounts, grants, and skill instructions are sample data. No real service was connected.

The fixture supplies local brand SVGs through the renderer's existing `logoUrl` field. See `../logos/SOURCES.md` for asset provenance. Each SVG has an opaque tile background in the fixture so the renderer's monogram fallback does not show through transparent areas. The shipping components and CSS are unchanged.

- `plugins-browse.png`: bundled catalog with GitHub, Slack, Notion, Linear, and Research Playbook.
- `plugins-access.png`: GitHub account, per-agent access, and a configured sample of three tool policies.
- `plugins-skills.png`: Private skills editor, scrolled to the instructions and agent selection.

The three illustrative GitHub tools (`search_repositories`, `pull_request_read`, `issue_write`) are verified against [GitHub's official MCP server documentation](https://github.com/github/github-mcp-server). They are a sample subset, not the full discovered tool inventory. The configured policies are examples.

Current capture provenance: `output/landing-plugin-retina-0912/` in the project workspace. Earlier 1× captures are archived in `output/landing-plugin-assets-0912/`.
