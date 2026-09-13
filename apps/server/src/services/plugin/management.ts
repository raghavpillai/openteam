import { cancelPendingPluginWork } from "./pending-work";
import { createHash } from "node:crypto";
import {
  ApiError,
  type PluginManagementView,
  type PluginPackageView,
  type PluginSkillInput,
} from "@openteam/contracts";
import type { PrismaClient } from "@openteam/db";
import { Effect } from "effect";
import {
  exportPackage,
  fieldsForConnector,
  importPackage,
  packageChanges,
  parsePluginDefinition,
  validatePackageFiles,
  type PackagePreview,
  type PluginDefinition,
  type PluginInstallationMode,
} from "@openteam/plugin-sdk";
import { exportPackageArchive, importPackageArchive } from "@openteam/plugin-sdk/archive";
import { parseOpenTeamMarketplace } from "../../plugins/openteam-marketplace";
import { serviceEffect, toJson } from "../service-utils";
import {
  canonicalJson,
  definitionFromManifest,
  jsonObject,
  stringArray,
  stringRecord,
} from "./values";

export const pluginDigest = (definition: PluginDefinition): string =>
  createHash("sha256").update(canonicalJson(definition)).digest("hex");

async function fetchPackageResource(value: string): Promise<{ bytes: Uint8Array; url: string }> {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ApiError(400, "plugin_url_invalid", "Enter a valid package or repository URL");
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
    throw new ApiError(
      400,
      "plugin_url_invalid",
      "Use an HTTP(S) URL without embedded credentials"
    );
  if (url.hostname === "github.com") {
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length === 2)
      url = new URL(`https://api.github.com/repos/${parts[0]}/${parts[1]}/zipball`);
    else if (parts[2] === "tree" && parts.length === 4)
      url = new URL(
        `https://api.github.com/repos/${parts[0]}/${parts[1]}/zipball/${encodeURIComponent(parts[3]!)}`
      );
  }
  const response = await fetch(url, {
    signal: AbortSignal.timeout(30_000),
    headers: { "User-Agent": "OpenBot-Plugins" },
  });
  if (!response.ok)
    throw new ApiError(
      400,
      "plugin_source_failed",
      `Package source returned HTTP ${response.status}`
    );
  if (Number(response.headers.get("content-length")) > 20 * 1024 * 1024)
    throw new ApiError(413, "plugin_package_too_large", "Package exceeds 20 MB");
  const reader = response.body?.getReader();
  if (!reader) throw new ApiError(400, "plugin_source_empty", "Package source returned no content");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value: chunk, done } = await reader.read();
      if (done) break;
      size += chunk.length;
      if (size > 20 * 1024 * 1024)
        throw new ApiError(413, "plugin_package_too_large", "Package exceeds 20 MB");
      chunks.push(chunk);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return { bytes, url: response.url };
}

export class PluginManagement {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly bundled: () => Promise<PluginDefinition[]>,
    private readonly install: (key: string) => Promise<unknown>,
    private readonly sync: () => Promise<void>,
    private readonly stop: (id: string, transport: string) => Promise<void>
  ) {}

  catalog = async (): Promise<PluginDefinition[]> => {
    const [bundled, sources, drafts] = await Promise.all([
      this.bundled(),
      this.prisma.pluginSource.findMany({ orderBy: { createdAt: "asc" } }),
      this.prisma.pluginDraft.findMany({ orderBy: { updatedAt: "asc" } }),
    ]);
    const plugins = new Map(bundled.map((plugin) => [plugin.key, plugin]));
    for (const source of sources) {
      try {
        for (const plugin of parseOpenTeamMarketplace(source.manifest).plugins)
          if (!plugins.has(plugin.key))
            plugins.set(plugin.key, { ...plugin, sourceUrl: source.url });
      } catch {
        /* Retain successful snapshots only. */
      }
    }
    for (const draft of drafts) {
      const plugin = parsePluginDefinition(draft.definition);
      plugins.set(plugin.key, plugin);
    }
    return [...plugins.values()];
  };

  overview = () =>
    serviceEffect(async (): Promise<PluginManagementView> => {
      const [sources, drafts, skills] = await Promise.all([
        this.prisma.pluginSource.findMany({ orderBy: { createdAt: "asc" } }),
        this.prisma.pluginDraft.findMany({ orderBy: { updatedAt: "desc" } }),
        this.prisma.pluginPrivateSkill.findMany({ orderBy: { name: "asc" } }),
      ]);
      return {
        sources: sources.map((source) => ({
          id: source.id,
          name: source.name,
          url: source.url,
          status: source.status,
          error: source.error,
          refreshedAt: source.refreshedAt?.toISOString() ?? null,
          pluginCount: Array.isArray(jsonObject(source.manifest).plugins)
            ? (jsonObject(source.manifest).plugins as unknown[]).length
            : 0,
        })),
        drafts: drafts.map((draft) => ({
          id: draft.id,
          name: draft.name,
          definition: parsePluginDefinition(draft.definition),
          warnings: stringArray(draft.warnings),
          format: "openteam",
          sourceUrl: draft.sourceUrl,
          digest: pluginDigest(parsePluginDefinition(draft.definition)),
          updatedAt: draft.updatedAt.toISOString(),
        })),
        skills: skills.map((skill) => ({
          id: skill.id,
          name: skill.name,
          description: skill.description,
          body: skill.body,
          files: stringRecord(skill.files),
          enabledBotIds: stringArray(skill.enabledBotIds),
        })),
      };
    });

  private savePreview = async (preview: PackagePreview, sourceUrl?: string, id?: string) => {
    // The preview itself is never merged with live connection credentials.
    const data = {
      name: preview.definition.name,
      definition: toJson(preview.definition),
      warnings: toJson(preview.warnings),
      sourceUrl: sourceUrl ?? null,
    };
    id ??= (
      await this.prisma.pluginDraft.findFirst({
        where: { definition: { path: ["key"], equals: preview.definition.key } },
        select: { id: true },
      })
    )?.id;
    const draft = id
      ? await this.prisma.pluginDraft.update({ where: { id }, data })
      : await this.prisma.pluginDraft.create({ data });
    return { ...preview, id: draft.id, digest: pluginDigest(preview.definition) };
  };
  importFiles = (files: Record<string, string>, sourceUrl?: string) =>
    serviceEffect(async () => this.savePreview(importPackage(files), sourceUrl));
  importArchive = (bytes: Uint8Array) =>
    serviceEffect(async () => this.savePreview(importPackageArchive(bytes)));
  importUrl = (url: string) =>
    serviceEffect(async () => {
      const resource = await fetchPackageResource(url);
      const preview =
        resource.bytes[0] === 0x50 && resource.bytes[1] === 0x4b
          ? importPackageArchive(resource.bytes)
          : importPackage({ "plugin.json": new TextDecoder().decode(resource.bytes) });
      preview.definition.sourceUrl = url;
      return this.savePreview(preview, url);
    });
  saveDraft = (id: string, definition: unknown) =>
    serviceEffect(async () => {
      const current = await this.prisma.pluginDraft.findUnique({ where: { id } });
      if (!current) throw new ApiError(404, "plugin_draft_missing", "Plugin draft not found");
      return this.savePreview(
        {
          definition: parsePluginDefinition(definition),
          warnings: stringArray(current.warnings),
          format: "openteam",
        },
        current.sourceUrl ?? undefined,
        id
      );
    });
  deleteDraft = (id: string) =>
    serviceEffect(async () => {
      await this.prisma.pluginDraft.delete({ where: { id } });
      return { deleted: true };
    });
  installDraft = (id: string) =>
    serviceEffect(async () => {
      const draft = await this.prisma.pluginDraft.findUnique({ where: { id } });
      if (!draft) throw new ApiError(404, "plugin_draft_missing", "Plugin draft not found");
      const plugin = parsePluginDefinition(draft.definition);
      const installed = await this.prisma.pluginInstallation.findUnique({
        where: { pluginKey: plugin.key },
      });
      if (installed)
        throw new ApiError(
          409,
          "plugin_already_installed",
          "Review and apply this package as an update from Installed plugins"
        );
      return this.install(plugin.key);
    });
  exportDraft = (id: string) =>
    serviceEffect(async () => {
      const draft = await this.prisma.pluginDraft.findUnique({ where: { id } });
      if (!draft) throw new ApiError(404, "plugin_draft_missing", "Plugin draft not found");
      return exportPackageArchive(parsePluginDefinition(draft.definition));
    });
  exportInstalled = (key: string) =>
    serviceEffect(async () => exportPackageArchive(await this.installedDefinition(key)));

  private async validateSourceKeys(plugins: readonly PluginDefinition[], ownSourceId?: string) {
    const [bundled, sources] = await Promise.all([
      this.bundled(),
      this.prisma.pluginSource.findMany({ where: ownSourceId ? { id: { not: ownSourceId } } : {} }),
    ]);
    const owners = new Map(bundled.map((plugin) => [plugin.key, "the bundled catalog"]));
    for (const source of sources)
      for (const plugin of parseOpenTeamMarketplace(source.manifest).plugins)
        owners.set(plugin.key, source.name);
    for (const plugin of plugins) {
      const owner = owners.get(plugin.key);
      if (owner)
        throw new ApiError(
          409,
          "plugin_source_conflict",
          `Plugin key ${plugin.key} already belongs to ${owner}. Use a distinct package key or update its existing source.`
        );
    }
  }

  addSource = (url: string, name?: string) =>
    serviceEffect(async () => {
      const resource = await fetchPackageResource(url);
      const manifest = parseOpenTeamMarketplace(
        JSON.parse(new TextDecoder().decode(resource.bytes))
      );
      await this.validateSourceKeys(manifest.plugins);
      const source = await this.prisma.pluginSource.create({
        data: {
          url,
          name: name?.trim() || new URL(url).hostname,
          manifest: toJson(manifest),
          status: "ready",
          refreshedAt: new Date(),
        },
      });
      return { id: source.id };
    });
  updateSource = (id: string, url: string, name?: string) =>
    serviceEffect(async () => {
      const existing = await this.prisma.pluginSource.findUnique({ where: { id } });
      if (!existing) throw new ApiError(404, "plugin_source_missing", "Source not found");
      const resource = await fetchPackageResource(url);
      const manifest = parseOpenTeamMarketplace(
        JSON.parse(new TextDecoder().decode(resource.bytes))
      );
      await this.validateSourceKeys(manifest.plugins, id);
      await this.prisma.pluginSource.update({
        where: { id },
        data: {
          url,
          name: name?.trim() || existing.name,
          manifest: toJson(manifest),
          status: "ready",
          error: null,
          refreshedAt: new Date(),
        },
      });
      return { id };
    });
  refreshSource = (id: string) =>
    serviceEffect(async () => {
      const source = await this.prisma.pluginSource.findUnique({ where: { id } });
      if (!source) throw new ApiError(404, "plugin_source_missing", "Source not found");
      try {
        const resource = await fetchPackageResource(source.url);
        const manifest = parseOpenTeamMarketplace(
          JSON.parse(new TextDecoder().decode(resource.bytes))
        );
        await this.validateSourceKeys(manifest.plugins, id);
        await this.prisma.pluginSource.update({
          where: { id },
          data: {
            manifest: toJson(manifest),
            status: "ready",
            error: null,
            refreshedAt: new Date(),
          },
        });
        return { refreshed: true, pluginCount: manifest.plugins.length };
      } catch (error) {
        await this.prisma.pluginSource.update({
          where: { id },
          data: {
            status: "error",
            error: error instanceof Error ? error.message.slice(0, 2000) : "Source refresh failed",
          },
        });
        throw error;
      }
    });
  deleteSource = (id: string) =>
    serviceEffect(async () => {
      await this.prisma.pluginSource.delete({ where: { id } });
      return { deleted: true };
    });

  private async installedDefinition(key: string): Promise<PluginDefinition> {
    const installation = await this.prisma.pluginInstallation.findUnique({
      where: { pluginKey: key },
    });
    const definition = definitionFromManifest(installation?.manifest);
    if (!installation || !definition)
      throw new ApiError(404, "plugin_not_installed", "Plugin not installed");
    return definition;
  }
  package = (key: string) =>
    serviceEffect(async (): Promise<PluginPackageView> => {
      const installation = await this.prisma.pluginInstallation.findUnique({
        where: { pluginKey: key },
      });
      const definition = await this.installedDefinition(key);
      const next = (await this.catalog()).find((plugin) => plugin.key === key);
      const digest = pluginDigest(definition);
      return {
        definition,
        digest,
        mode: (installation?.mode ?? "optional") as PluginInstallationMode,
        skillSyncStatus: installation?.skillSyncStatus ?? "pending",
        skillSyncError: installation?.skillSyncError ?? null,
        hasRollback: Boolean(installation?.previousManifest),
        update:
          next && pluginDigest(next) !== digest
            ? {
                definition: next,
                digest: pluginDigest(next),
                changes: packageChanges(definition, next),
              }
            : null,
      };
    });
  update = (key: string, digest: string, rollback = false) =>
    serviceEffect(async () => {
      const installation = await this.prisma.pluginInstallation.findUnique({
        where: { pluginKey: key },
        include: { connections: true },
      });
      if (!installation) throw new ApiError(404, "plugin_not_installed", "Plugin not installed");
      const next = rollback
        ? definitionFromManifest(installation.previousManifest)
        : (await this.catalog()).find((plugin) => plugin.key === key);
      if (!next) throw new ApiError(404, "plugin_update_missing", "Package update is unavailable");
      if (!rollback && pluginDigest(next) !== digest)
        throw new ApiError(
          409,
          "plugin_update_changed",
          "The package changed; review the update again"
        );
      parsePluginDefinition(next);
      const previous = definitionFromManifest(installation.manifest)!;
      await Promise.all(
        installation.connections.map((connection) => this.stop(connection.id, connection.transport))
      );
      await this.prisma.$transaction(async (tx) => {
        await cancelPendingPluginWork(
          tx,
          installation.connections.map((connection) => connection.id)
        );
        // The UI review is tied to this installed snapshot as well as the candidate digest.
        const locked = await tx.pluginInstallation.updateMany({
          where: { id: installation.id, updatedAt: installation.updatedAt },
          data: {
            manifest: toJson(next),
            previousManifest: toJson(installation.manifest),
            version: next.version,
            name: next.name,
            description: next.description,
            publisher: next.publisher,
            sourceDigest: pluginDigest(next),
            skillSyncStatus: "pending",
            skillSyncError: null,
          },
        });
        if (!locked.count)
          throw new ApiError(
            409,
            "plugin_update_conflict",
            "This installation changed; review the update again"
          );
        for (const connector of next.connections) {
          const defaults = Object.fromEntries(
            fieldsForConnector(next, connector.key)
              .filter((field) => !field.secret && field.default !== undefined)
              .map((field) => [field.key, field.default])
          );
          const setup =
            connector.setup ??
            (next.setup?.connectionKey === connector.key ? next.setup : undefined);
          const initialConfiguration = {
            ...(setup?.requiredScopes.length ? { scope: setup.requiredScopes.join(" ") } : {}),
            ...(connector.oauth?.tokenEndpointAuthMethod
              ? { tokenEndpointAuthMethod: connector.oauth.tokenEndpointAuthMethod }
              : {}),
            ...connector.configuration,
            values: defaults,
          };
          const oldDefinition = previous.connections.find(
            (candidate) => candidate.key === connector.key
          );
          const accounts = installation.connections.filter(
            (connection) => connection.connectorKey === connector.key
          );
          if (!accounts.length) {
            await tx.pluginConnection.create({
              data: {
                installationId: installation.id,
                connectorKey: connector.key,
                name: connector.name,
                endpoint: connector.endpoint,
                transport: connector.transport,
                authType: connector.auth,
                configuration: toJson(initialConfiguration),
                toolSnapshot: toJson(connector.tools),
                status: connector.auth === "none" ? "disconnected" : "needs_auth",
              },
            });
            continue;
          }
          const compatible =
            oldDefinition?.auth === connector.auth &&
            oldDefinition.transport === connector.transport &&
            oldDefinition.endpoint === connector.endpoint &&
            canonicalJson(oldDefinition.oauth?.authorizationServer) ===
              canonicalJson(connector.oauth?.authorizationServer);
          const configChanged =
            JSON.stringify(oldDefinition?.configuration) !==
            JSON.stringify(connector.configuration);
          for (const account of accounts) {
            const existingConfiguration = jsonObject(account.configuration);
            const configuration = configChanged
              ? {
                  ...initialConfiguration,
                  ...Object.fromEntries(
                    Object.entries(existingConfiguration).filter(
                      ([key, value]) =>
                        [
                          "values",
                          "clientId",
                          "scope",
                          "clientSecret",
                          "tokenEndpointAuthMethod",
                        ].includes(key) ||
                        canonicalJson(value) !== canonicalJson(oldDefinition?.configuration?.[key])
                    )
                  ),
                }
              : existingConfiguration;
            configuration.values = { ...defaults, ...jsonObject(existingConfiguration.values) };
            await tx.pluginConnection.update({
              where: { id: account.id },
              data: {
                name: connector.name,
                transport: connector.transport,
                authType: connector.auth,
                endpoint: compatible ? account.endpoint : connector.endpoint,
                configuration: toJson(configuration),
                runtimeGeneration: { increment: 1 },
                ...(!compatible
                  ? {
                      credentials: {},
                      toolSnapshot: toJson(connector.tools),
                      status: connector.auth === "none" ? "disconnected" : "needs_auth",
                      statusMessage: "The connector changed. Review its setup and reconnect.",
                    }
                  : {
                      status: "disconnected",
                      statusMessage: "Package updated. Reconnect to refresh its tools.",
                    }),
              },
            });
          }
        }
        await tx.pluginConnection.deleteMany({
          where: {
            installationId: installation.id,
            connectorKey: { notIn: next.connections.map((connector) => connector.key) },
          },
        });
        await tx.pluginActivity.create({
          data: {
            installationId: installation.id,
            kind: rollback ? "plugin.rolled_back" : "plugin.updated",
            summary: `${rollback ? "Restored" : "Updated"} ${next.name} ${next.version}`,
          },
        });
      });
      await this.sync();
      return { updated: true, version: next.version };
    });
  setMode = (key: string, mode: PluginInstallationMode) =>
    serviceEffect(async () => {
      const installation = await this.prisma.pluginInstallation.findUnique({
        where: { pluginKey: key },
        include: { connections: true },
      });
      if (!installation) throw new ApiError(404, "plugin_not_installed", "Plugin not installed");
      if (mode === "disabled")
        await Promise.all(
          installation.connections.map((connection) =>
            this.stop(connection.id, connection.transport)
          )
        );
      await this.prisma.$transaction(async (tx) => {
        if (mode === "disabled")
          await cancelPendingPluginWork(
            tx,
            installation.connections.map((connection) => connection.id)
          );
        await tx.pluginInstallation.update({
          where: { id: installation.id },
          data: { mode, status: mode === "disabled" ? "disabled" : "installed" },
        });
        if (mode === "disabled")
          await tx.pluginConnection.updateMany({
            where: { installationId: installation.id },
            data: { runtimeGeneration: { increment: 1 }, status: "disconnected" },
          });
        if (mode === "required" || mode === "default") {
          const bots = await tx.bot.findMany({
            where: { status: { not: "archived" } },
            select: { id: true },
          });
          for (const bot of bots) {
            await tx.botPluginEnablement.upsert({
              where: { botId_installationId: { botId: bot.id, installationId: installation.id } },
              create: {
                botId: bot.id,
                installationId: installation.id,
                enabled: true,
                skillsEnabled: true,
              },
              update: { enabled: true, skillsEnabled: true },
            });
          }
        }
        await tx.pluginActivity.create({
          data: {
            installationId: installation.id,
            kind: "plugin.mode_changed",
            summary: `${installation.name} installation policy: ${mode}`,
          },
        });
      });
      await this.sync();
      return { mode };
    });
  retrySync = () =>
    serviceEffect(async () => {
      await this.sync();
      const failed = await this.prisma.pluginInstallation.findFirst({
        where: { status: "installed", skillSyncStatus: "error" },
        select: { skillSyncError: true },
      });
      if (failed)
        throw new ApiError(
          503,
          "plugin_skill_sync_failed",
          failed.skillSyncError ?? "Skill sync failed"
        );
      return { synced: true };
    });

  saveSkill = (id: string | null, input: PluginSkillInput) =>
    serviceEffect(async () => {
      validatePackageFiles(input.files ?? {});
      const enabledBotIds = [...new Set(input.enabledBotIds ?? [])];
      if (
        enabledBotIds.length &&
        (await this.prisma.bot.count({
          where: { id: { in: enabledBotIds }, status: { not: "archived" } },
        })) !== enabledBotIds.length
      )
        throw new ApiError(400, "plugin_skill_bot_missing", "A selected bot is unavailable");
      const data = {
        name: input.name.trim(),
        description: input.description,
        body: input.body,
        files: toJson(input.files ?? {}),
        enabledBotIds: toJson(enabledBotIds),
      };
      const skill = id
        ? await this.prisma.pluginPrivateSkill.update({ where: { id }, data })
        : await this.prisma.pluginPrivateSkill.create({ data });
      await this.sync();
      return { id: skill.id };
    });
  deleteSkill = (id: string) =>
    serviceEffect(async () => {
      await this.prisma.pluginPrivateSkill.delete({ where: { id } });
      await this.sync();
      return { deleted: true };
    });
}
