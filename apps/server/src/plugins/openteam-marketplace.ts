import { type PluginDefinition, pluginCatalog, validatePluginCatalog } from "./catalog";

type JsonObject = Record<string, unknown>;

export interface OpenTeamMarketplaceManifest {
  schemaVersion: 1;
  revision: string;
  plugins: readonly PluginDefinition[];
}

const objectValue = (value: unknown): JsonObject =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : {};

const isPluginDefinition = (value: unknown): value is PluginDefinition => {
  const plugin = objectValue(value);
  return (
    typeof plugin.key === "string" &&
    typeof plugin.version === "string" &&
    typeof plugin.name === "string" &&
    typeof plugin.description === "string" &&
    typeof plugin.publisher === "string" &&
    typeof plugin.category === "string" &&
    typeof plugin.featured === "boolean" &&
    Array.isArray(plugin.components) &&
    Array.isArray(plugin.connections) &&
    Array.isArray(plugin.skills)
  );
};

export const bundledOpenTeamMarketplace: OpenTeamMarketplaceManifest = {
  schemaVersion: 1,
  revision: "2026.08.29.4",
  plugins: pluginCatalog,
};

/**
 * Parse the deployment-owned OpenTeam marketplace format.
 *
 * The manifest is intentionally just JSON: self-hosters can mount a registry file without
 * running another service. Installed packages remain pinned because PluginService stores the
 * complete normalized plugin definition on installation.
 */
export const parseOpenTeamMarketplace = (value: unknown): OpenTeamMarketplaceManifest => {
  const manifest = objectValue(value);
  if (manifest.schemaVersion !== 1) {
    throw new Error("OpenTeam marketplace schemaVersion must be 1");
  }
  if (typeof manifest.revision !== "string" || !manifest.revision.trim()) {
    throw new Error("OpenTeam marketplace revision is required");
  }
  if (!Array.isArray(manifest.plugins) || !manifest.plugins.every(isPluginDefinition)) {
    throw new Error("OpenTeam marketplace plugins are invalid");
  }
  const plugins = structuredClone(manifest.plugins) as PluginDefinition[];
  validatePluginCatalog(plugins);
  return {
    schemaVersion: 1,
    revision: manifest.revision,
    plugins,
  };
};

export class OpenTeamMarketplaceSource {
  private snapshot: Promise<OpenTeamMarketplaceManifest> | null = null;

  constructor(
    private readonly manifestPath = process.env.OPENTEAM_MARKETPLACE_FILE?.trim() || null,
    private readonly bundledManifest: OpenTeamMarketplaceManifest = bundledOpenTeamMarketplace
  ) {}

  async manifest(): Promise<OpenTeamMarketplaceManifest> {
    if (this.snapshot) return this.snapshot;
    this.snapshot = this.load();
    return this.snapshot;
  }

  async plugins(): Promise<PluginDefinition[]> {
    const manifest = await this.manifest();
    return manifest.plugins.map((plugin) => ({
      ...structuredClone(plugin),
      sourceRevision: plugin.sourceRevision ?? manifest.revision,
    }));
  }

  private async load(): Promise<OpenTeamMarketplaceManifest> {
    if (!this.manifestPath) return parseOpenTeamMarketplace(this.bundledManifest);
    const file = Bun.file(this.manifestPath);
    if (!(await file.exists())) {
      throw new Error(`OpenTeam marketplace file does not exist: ${this.manifestPath}`);
    }
    return parseOpenTeamMarketplace(await file.json());
  }
}
