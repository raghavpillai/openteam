import { ApiError, PluginConfigurationInput, PluginDraftInput, PluginModeInput, PluginPackageInput, PluginSkillInput, PluginTestInput, PluginUpdateInput, PluginUrlInput } from "@openteam/contracts";
import { json } from "../http";
import { type RouteContext, run } from "./context";
import { bodyRoute, dispatchRoutes, effectRoute } from "./dispatch";

export async function pluginManagementRoutes(context: RouteContext): Promise<Response | undefined> {
  const { request, path, app } = context;
  if (request.method === "GET" && path === "/api/plugins/composer") {
    const botId = context.url.searchParams.get("botId");
    if (!botId || !/^[0-9a-f-]{36}$/i.test(botId)) throw new ApiError(400, "plugin_bot_required", "Choose a Bot to see its plugins");
    return json(await run(app.plugins.composer(botId)));
  }
  if (request.method === "POST" && path === "/api/plugin-drafts/archive") {
    if (Number(request.headers.get("content-length")) > 20 * 1024 * 1024) throw new ApiError(413, "plugin_package_too_large", "Package exceeds 20 MB");
    const reader = request.body?.getReader();
    if (!reader) throw new ApiError(400, "plugin_package_empty", "Choose a package archive");
    const chunks: Uint8Array[] = []; let size = 0;
    try {
      while (true) { const part = await reader.read(); if (part.done) break; size += part.value.length; if (size > 20 * 1024 * 1024) throw new ApiError(413, "plugin_package_too_large", "Package exceeds 20 MB"); chunks.push(part.value); }
    } finally { await reader.cancel().catch(() => undefined); }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    return json(await run(app.plugins.management.importArchive(bytes)), 201);
  }
  const exportMatch = path.match(/^\/api\/(plugin-drafts|plugins)\/([^/]+)\/export$/);
  if (request.method === "GET" && exportMatch?.[2]) {
    const key = decodeURIComponent(exportMatch[2]);
    const bytes = await run(exportMatch[1] === "plugin-drafts" ? app.plugins.management.exportDraft(key) : app.plugins.management.exportInstalled(key));
    return json({ filename: `${key}.zip`, base64: Buffer.from(bytes).toString("base64") });
  }
  return dispatchRoutes(context, routes);
}
const routes = [
  effectRoute("GET", "/api/plugin-management", ({ app }) => app.plugins.management.overview()),
  bodyRoute("POST", /^\/api\/plugin-connections\/([^/]+)\/test$/, PluginTestInput, ({ app }, id, input) => app.plugins.testTool(id, input)),
  bodyRoute("POST", "/api/plugin-drafts/import", PluginPackageInput, ({ app }, _, input) => app.plugins.management.importFiles(input.files, input.sourceUrl), 201),
  bodyRoute("POST", "/api/plugin-drafts/url", PluginUrlInput, ({ app }, _, input) => app.plugins.management.importUrl(input.url), 201),
  bodyRoute("PUT", /^\/api\/plugin-drafts\/([^/]+)$/, PluginDraftInput, ({ app }, id, input) => app.plugins.management.saveDraft(id, input.definition)),
  effectRoute("DELETE", /^\/api\/plugin-drafts\/([^/]+)$/, ({ app }, id) => app.plugins.management.deleteDraft(id)),
  effectRoute("POST", /^\/api\/plugin-drafts\/([^/]+)\/install$/, ({ app }, id) => app.plugins.management.installDraft(id)),
  bodyRoute("POST", "/api/plugin-sources", PluginUrlInput, ({ app }, _, input) => app.plugins.management.addSource(input.url, input.name), 201),
  bodyRoute("PUT", /^\/api\/plugin-sources\/([^/]+)$/, PluginUrlInput, ({ app }, id, input) => app.plugins.management.updateSource(id, input.url, input.name)),
  effectRoute("POST", /^\/api\/plugin-sources\/([^/]+)\/refresh$/, ({ app }, id) => app.plugins.management.refreshSource(id)),
  effectRoute("DELETE", /^\/api\/plugin-sources\/([^/]+)$/, ({ app }, id) => app.plugins.management.deleteSource(id)),
  effectRoute("GET", /^\/api\/plugins\/([^/]+)\/package$/, ({ app }, id) => app.plugins.management.package(decodeURIComponent(id))),
  bodyRoute("POST", /^\/api\/plugins\/([^/]+)\/update$/, PluginUpdateInput, ({ app }, id, input) => app.plugins.management.update(decodeURIComponent(id), input.digest)),
  effectRoute("POST", /^\/api\/plugins\/([^/]+)\/rollback$/, ({ app }, id) => app.plugins.management.update(decodeURIComponent(id), "", true)),
  bodyRoute("POST", /^\/api\/plugins\/([^/]+)\/mode$/, PluginModeInput, ({ app }, id, input) => app.plugins.management.setMode(decodeURIComponent(id), input.mode)),
  effectRoute("POST", "/api/plugins/sync", ({ app }) => app.plugins.management.retrySync()),
  effectRoute("GET", /^\/api\/plugin-connections\/([^/]+)\/configuration$/, ({ app }, id) => app.plugins.configuration.get(id)),
  bodyRoute("PUT", /^\/api\/plugin-connections\/([^/]+)\/configuration$/, PluginConfigurationInput, ({ app }, id, input) => app.plugins.configuration.save(id, input)),
  bodyRoute("POST", "/api/plugin-skills", PluginSkillInput, ({ app }, _, input) => app.plugins.management.saveSkill(null, input), 201),
  bodyRoute("PUT", /^\/api\/plugin-skills\/([^/]+)$/, PluginSkillInput, ({ app }, id, input) => app.plugins.management.saveSkill(id, input)),
  effectRoute("DELETE", /^\/api\/plugin-skills\/([^/]+)$/, ({ app }, id) => app.plugins.management.deleteSkill(id)),
];
