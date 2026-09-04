import { createHash } from "node:crypto";
import { open, readdir, readFile, stat } from "node:fs/promises";
import { extname, relative, resolve } from "node:path";
import { gzipSync } from "node:zlib";
import {
  isReleaseArtifactLocation,
  releaseArtifactKind,
  validatePackagedPackageJson,
  validatePackagedTopLevel,
  zipAsarEntries,
} from "./desktop-build-measurement-utils";

const desktopRoot = resolve(import.meta.dirname, "..", "..", "apps", "desktop");
const rendererRoot = resolve(desktopRoot, "dist");
const electronRoot = resolve(desktopRoot, "dist-electron");
const releaseRoot = resolve(desktopRoot, "release");
const packageRelative = (root: string, path: string) => relative(root, path).replaceAll("\\", "/");
const desktopPackage = JSON.parse(await readFile(resolve(desktopRoot, "package.json"), "utf8")) as {
  author?: unknown;
  description?: unknown;
  main: string;
  name: string;
  private?: unknown;
  type?: unknown;
  version: string;
};

interface FileMetric {
  path: string;
  bytes: number;
  gzipBytes: number;
}

const walk = async (directory: string): Promise<string[]> => {
  const entries = await readdir(directory, { withFileTypes: true });
  const children = await Promise.all(
    entries.map((entry) => {
      const path = resolve(directory, entry.name);
      return entry.isDirectory() ? walk(path) : [path];
    })
  );
  return children.flat().sort();
};

const metricFor = async (path: string, root = rendererRoot): Promise<FileMetric> => {
  const bytes = await readFile(path);
  return {
    path: packageRelative(root, path),
    bytes: bytes.byteLength,
    gzipBytes: gzipSync(bytes, { level: 9 }).byteLength,
  };
};

const allRendererFiles = await walk(rendererRoot);
const buildMetadataNames = new Set(["manifest.json"]);
const files = allRendererFiles.filter(
  (path) => !buildMetadataNames.has(packageRelative(rendererRoot, path))
);
const buildMetadataFiles = allRendererFiles.filter((path) => !files.includes(path));
const metrics = await Promise.all(files.map((path) => metricFor(path)));
const buildMetadataMetrics = await Promise.all(buildMetadataFiles.map((path) => metricFor(path)));
const electronFiles = await walk(electronRoot);
const electronMetrics = await Promise.all(
  electronFiles.map((path) => metricFor(path, electronRoot))
);
const indexHtml = await readFile(resolve(rendererRoot, "index.html"), "utf8");
const startupPaths = Array.from(
  indexHtml.matchAll(/(?:src|href)=["']\.\/([^"']+)["']/g),
  (match) => match[1]
).filter((path) => path.endsWith(".js") || path.endsWith(".css"));
const startup = metrics.filter((metric) => startupPaths.includes(metric.path));
const metricByPath = new Map(metrics.map((metric) => [metric.path, metric] as const));

const sum = (values: FileMetric[], key: "bytes" | "gzipBytes") =>
  values.reduce((total, value) => total + value[key], 0);
const byExtension = Object.fromEntries(
  [".js", ".css", ".woff2", ".html"].map((extension) => {
    const matching = metrics.filter((metric) => extname(metric.path) === extension);
    return [
      extension.slice(1),
      {
        files: matching.length,
        bytes: sum(matching, "bytes"),
        gzipBytes: sum(matching, "gzipBytes"),
      },
    ];
  })
);

interface AsarNode {
  files?: Record<string, AsarNode>;
  offset?: string;
  size?: number;
  unpacked?: boolean;
}

const readAsarInventory = async (path: string) => {
  try {
    const file = await open(path, "r");
    try {
      const prefix = Buffer.alloc(8);
      await file.read(prefix, 0, prefix.length, 0);
      const headerSize = prefix.readUInt32LE(4);
      const pickle = Buffer.alloc(headerSize);
      await file.read(pickle, 0, headerSize, 8);
      const jsonBytes = pickle.readUInt32LE(4);
      const root = JSON.parse(pickle.subarray(8, 8 + jsonBytes).toString("utf8")) as AsarNode;
      const paths: string[] = [];
      const entries = new Map<string, AsarNode>();
      let logicalBytes = 0;
      let asarFiles = 0;
      let directories = 0;
      const visit = (node: AsarNode, parent = "") => {
        for (const [name, child] of Object.entries(node.files ?? {})) {
          const pathName = parent ? `${parent}/${name}` : name;
          if (child.files) {
            directories += 1;
            visit(child, pathName);
          } else {
            asarFiles += 1;
            logicalBytes += child.size ?? 0;
            paths.push(pathName);
            entries.set(pathName, child);
          }
        }
      };
      visit(root);
      const topLevel = Object.keys(root.files ?? {}).sort();
      const topLevelValidation = validatePackagedTopLevel(topLevel);
      const currentBuildFiles = [
        ...files.map((filePath) => ({
          absolutePath: filePath,
          packagePath: `dist/${packageRelative(rendererRoot, filePath)}`,
        })),
        ...(await walk(electronRoot)).map((filePath) => ({
          absolutePath: filePath,
          packagePath: `dist-electron/${packageRelative(electronRoot, filePath)}`,
        })),
      ];
      const expectedPaths = new Set(currentBuildFiles.map((entry) => entry.packagePath));
      const missing: string[] = [];
      const changed: string[] = [];
      let matched = 0;
      const contentStart = headerSize + 8;
      for (const current of currentBuildFiles) {
        const packaged = entries.get(current.packagePath);
        if (!packaged) {
          missing.push(current.packagePath);
          continue;
        }
        const sourceBytes = await readFile(current.absolutePath);
        if (packaged.unpacked) {
          try {
            const packagedBytes = await readFile(resolve(`${path}.unpacked`, current.packagePath));
            if (sourceBytes.equals(packagedBytes)) matched += 1;
            else changed.push(current.packagePath);
          } catch {
            missing.push(current.packagePath);
          }
          continue;
        }
        if (packaged.offset === undefined) {
          missing.push(current.packagePath);
          continue;
        }
        if (packaged.size !== sourceBytes.byteLength) {
          changed.push(current.packagePath);
          continue;
        }
        const packagedBytes = Buffer.alloc(sourceBytes.byteLength);
        await file.read(
          packagedBytes,
          0,
          packagedBytes.byteLength,
          contentStart + Number(packaged.offset)
        );
        if (sourceBytes.equals(packagedBytes)) matched += 1;
        else changed.push(current.packagePath);
      }
      const unexpected = paths.filter(
        (candidate) =>
          (candidate.startsWith("dist/") || candidate.startsWith("dist-electron/")) &&
          !expectedPaths.has(candidate)
      );
      const packageJsonErrors: string[] = [];
      const packagedPackage = entries.get("package.json");
      if (!packagedPackage || packagedPackage.unpacked || packagedPackage.offset === undefined) {
        packageJsonErrors.push("package.json is missing or unpacked");
      } else {
        try {
          const bytes = Buffer.alloc(packagedPackage.size ?? 0);
          await file.read(
            bytes,
            0,
            bytes.byteLength,
            contentStart + Number(packagedPackage.offset)
          );
          const parsed = JSON.parse(bytes.toString("utf8")) as unknown;
          packageJsonErrors.push(
            ...validatePackagedPackageJson(parsed, desktopPackage, new Set(paths))
          );
        } catch (error) {
          packageJsonErrors.push(
            `package.json could not be parsed: ${error instanceof Error ? error.message : String(error)}`
          );
        }
      }
      return {
        headerBytes: headerSize + 8,
        headerPickleBytes: headerSize,
        logicalBytes,
        files: asarFiles,
        directories,
        topLevel,
        buildComparison: {
          expected: currentBuildFiles.length,
          matched,
          missing,
          changed,
          unexpected,
        },
        violations: {
          nodeModules: paths.filter((candidate) => candidate.includes("node_modules/")),
          sourceMaps: paths.filter((candidate) => candidate.endsWith(".map")),
          wasm: paths.filter((candidate) => candidate.endsWith(".wasm")),
          nativeModules: paths.filter((candidate) => candidate.endsWith(".node")),
          stalePreload: paths.filter((candidate) => candidate.endsWith("/preload.js")),
          missingTopLevel: topLevelValidation.missing,
          unexpectedTopLevel: topLevelValidation.unexpected,
          packageJson: packageJsonErrors,
        },
      };
    } finally {
      await file.close();
    }
  } catch {
    return null;
  }
};

interface ManifestEntry {
  assets?: string[];
  css?: string[];
  dynamicImports?: string[];
  file: string;
  imports?: string[];
  isEntry?: boolean;
  isDynamicEntry?: boolean;
}

const readLazyClosures = async () => {
  try {
    const manifest = JSON.parse(
      await readFile(resolve(rendererRoot, "manifest.json"), "utf8")
    ) as Record<string, ManifestEntry>;
    const closureFor = (sourceSuffixes: string[]) => {
      const keys = sourceSuffixes.map((sourceSuffix) =>
        Object.keys(manifest).find((candidate) => candidate.endsWith(sourceSuffix))
      );
      if (keys.some((key) => !key)) return null;
      const visited = new Set<string>();
      const assetPaths = new Set<string>();
      const visit = (manifestKey: string) => {
        if (visited.has(manifestKey)) return;
        visited.add(manifestKey);
        const entry = manifest[manifestKey];
        if (!entry) return;
        assetPaths.add(entry.file);
        for (const path of entry.css ?? []) assetPaths.add(path);
        for (const path of entry.assets ?? []) assetPaths.add(path);
        for (const imported of entry.imports ?? []) visit(imported);
      };
      for (const key of keys) visit(key as string);
      const incrementalPaths = [...assetPaths].filter((path) => !startupPaths.includes(path));
      return {
        sources: keys,
        isDynamicEntry: keys.every((key) => manifest[key as string]?.isDynamicEntry === true),
        nonDynamicSources: keys.filter((key) => manifest[key as string]?.isDynamicEntry !== true),
        files: incrementalPaths.length,
        bytes: incrementalPaths.reduce(
          (total, path) => total + (metricByPath.get(path)?.bytes ?? 0),
          0
        ),
        gzipBytes: incrementalPaths.reduce(
          (total, path) => total + (metricByPath.get(path)?.gzipBytes ?? 0),
          0
        ),
      };
    };
    const workerParserClosureFor = async (parserPrefix: string) => {
      const matching = (prefix: string) =>
        metrics.filter(
          (metric) => metric.path.startsWith(`assets/${prefix}-`) && metric.path.endsWith(".js")
        );
      const workerEntries = matching("preview.worker");
      const parserEntries = matching(parserPrefix);
      if (workerEntries.length !== 1 || parserEntries.length !== 1) return null;

      const visited = new Set<string>([workerEntries[0]?.path as string]);
      const visitImports = async (path: string) => {
        if (visited.has(path)) return;
        visited.add(path);
        const source = await readFile(resolve(rendererRoot, path), "utf8");
        for (const match of source.matchAll(/(?:import\(\s*|from\s*)[`'"]\.\/([^`'"]+)[`'"]/g)) {
          const imported = match[1];
          if (imported) await visitImports(`assets/${imported}`);
        }
      };
      await visitImports(parserEntries[0]?.path as string);
      const incrementalPaths = [...visited].filter((path) => !startupPaths.includes(path));
      return {
        sources: [workerEntries[0]?.path, parserEntries[0]?.path],
        isDynamicEntry: true,
        nonDynamicSources: [],
        files: incrementalPaths.length,
        bytes: incrementalPaths.reduce(
          (total, path) => total + (metricByPath.get(path)?.bytes ?? 0),
          0
        ),
        gzipBytes: incrementalPaths.reduce(
          (total, path) => total + (metricByPath.get(path)?.gzipBytes ?? 0),
          0
        ),
      };
    };
    const nestedDynamicGroupFor = (sourceSuffix: string) => {
      const source = Object.keys(manifest).find((candidate) => candidate.endsWith(sourceSuffix));
      if (!source) return null;
      const entries = manifest[source]?.dynamicImports ?? [];
      if (entries.length === 0) return null;

      const closurePathsFor = (key: string) => {
        const visited = new Set<string>();
        const paths = new Set<string>();
        const visit = (manifestKey: string) => {
          if (visited.has(manifestKey)) return;
          visited.add(manifestKey);
          const entry = manifest[manifestKey];
          if (!entry) return;
          paths.add(entry.file);
          for (const path of entry.css ?? []) paths.add(path);
          for (const path of entry.assets ?? []) paths.add(path);
          for (const imported of entry.imports ?? []) visit(imported);
        };
        visit(key);
        return [...paths].filter((path) => !startupPaths.includes(path));
      };
      const metricsFor = (paths: string[]) => ({
        files: paths.length,
        bytes: paths.reduce((total, path) => total + (metricByPath.get(path)?.bytes ?? 0), 0),
        gzipBytes: paths.reduce(
          (total, path) => total + (metricByPath.get(path)?.gzipBytes ?? 0),
          0
        ),
      });
      const entryClosures = entries
        .filter((key) => Boolean(manifest[key]))
        .map((key) => ({ source: key, ...metricsFor(closurePathsFor(key)) }))
        .sort((left, right) => right.bytes - left.bytes);
      const uniquePaths = [
        ...new Set(entries.flatMap((key) => (manifest[key] ? closurePathsFor(key) : []))),
      ];
      return {
        source,
        entries: entries.length,
        missingEntries: entries.filter((key) => !manifest[key]),
        startupEntries: entries.filter((key) => startupPaths.includes(manifest[key]?.file ?? "")),
        ...metricsFor(uniquePaths),
        largest: entryClosures[0] ?? null,
      };
    };
    const boundarySources = {
      basicMarkdown: ["src/renderer/components/ai-elements/message-response.tsx"],
      advancedRich: ["src/renderer/components/ai-elements/message-response/rich.tsx"],
      cjk: [
        "src/renderer/components/ai-elements/message-response/rich.tsx",
        "src/renderer/components/ai-elements/message-response/cjk.ts",
      ],
      code: [
        "src/renderer/components/ai-elements/message-response/rich.tsx",
        "src/renderer/components/ai-elements/message-response/code.ts",
      ],
      math: [
        "src/renderer/components/ai-elements/message-response/rich.tsx",
        "src/renderer/components/ai-elements/message-response/math.ts",
      ],
      mermaid: [
        "src/renderer/components/ai-elements/message-response/rich.tsx",
        "src/renderer/components/ai-elements/message-response/mermaid.ts",
      ],
      emojiPanel: ["src/renderer/components/openteam/emoji/panel.tsx"],
      a2aExchange: ["src/renderer/components/openteam/a2a-exchange-sheet.tsx"],
      asyncTasks: ["src/renderer/components/openteam/async-tasks-panel.tsx"],
      desktopDialogs: ["src/renderer/components/openteam/desktop-dialogs.tsx"],
      groupForm: ["src/renderer/components/openteam/forms.tsx"],
      inspector: ["src/renderer/components/openteam/inspector.tsx"],
      avatarPicker: ["src/renderer/components/openteam/avatar-picker.tsx"],
      botScreen: ["src/renderer/components/openteam/bot-screen.tsx"],
      botTemplateShare: ["src/renderer/components/openteam/bot-template-share.tsx"],
      fileAttachment: ["src/renderer/components/openteam/file-attachment.tsx"],
      pdfPreview: [
        "node_modules/pdfjs-dist/build/pdf.mjs",
        "node_modules/pdfjs-dist/build/pdf.worker.min.mjs?url",
      ],
      routineSummary: ["src/renderer/components/openteam/routine-summary.tsx"],
      routineEditor: ["src/renderer/components/openteam/routine-panel.tsx"],
      newBot: ["src/renderer/components/openteam/new-bot-screen.tsx"],
      pluginSettings: ["src/renderer/components/openteam/plugin-settings.tsx"],
      pluginSettingsDetail: ["src/renderer/components/openteam/plugin-settings-detail.tsx"],
      search: ["src/renderer/components/openteam/search-dialog.tsx"],
      groupAvatarEditor: ["src/renderer/components/openteam/group-avatar-editor.tsx"],
      settingsInitial: [
        "src/renderer/components/openteam/settings/panel.tsx",
        "src/renderer/components/openteam/settings/general.tsx",
        "src/renderer/components/openteam/settings/general-bot.tsx",
      ],
      settingsShell: ["src/renderer/components/openteam/settings/panel.tsx"],
      settingsAbout: ["src/renderer/components/openteam/settings/about.tsx"],
      settingsGeneral: ["src/renderer/components/openteam/settings/general.tsx"],
      settingsGeneralBot: ["src/renderer/components/openteam/settings/general-bot.tsx"],
      settingsComputer: ["src/renderer/components/openteam/settings/computer.tsx"],
      settingsServer: ["src/renderer/components/openteam/settings/server.tsx"],
      settingsUpdates: ["src/renderer/components/openteam/settings/updates.tsx"],
    };
    const closures = Object.fromEntries(
      Object.entries(boundarySources).map(([name, suffixes]) => [name, closureFor(suffixes)])
    );
    closures.docxPreview = await workerParserClosureFor("docx-parser");
    closures.spreadsheetPreview = await workerParserClosureFor("spreadsheet-parser");
    const coveredSources = new Set(
      Object.values(boundarySources).flatMap((suffixes) =>
        suffixes
          .map((suffix) => Object.keys(manifest).find((candidate) => candidate.endsWith(suffix)))
          .filter((key): key is string => Boolean(key))
      )
    );
    const dynamicSources = Object.keys(manifest)
      .filter((key) => key.startsWith("src/renderer/") && manifest[key]?.isDynamicEntry === true)
      .sort();
    return {
      closures,
      audit: {
        coveredSources: [...coveredSources].sort(),
        dynamicSources,
        shikiLanguageEntries: Object.keys(manifest).filter((key) =>
          /@shikijs(?:\+|\/)langs@?/.test(key)
        ).length,
        shikiThemeEntries: Object.keys(manifest).filter((key) =>
          /@shikijs(?:\+|\/)themes@?/.test(key)
        ).length,
        nestedDynamicGroups: {
          shikiLanguages: nestedDynamicGroupFor(
            "src/renderer/components/ai-elements/message-response/code.ts"
          ),
          mermaidDiagrams: nestedDynamicGroupFor(
            "src/renderer/components/ai-elements/message-response/mermaid.ts"
          ),
        },
        uncoveredDynamicSources: dynamicSources.filter((key) => !coveredSources.has(key)),
      },
    };
  } catch {
    return null;
  }
};

const optionalFileDetails = async (path: string) => {
  try {
    const details = await stat(path);
    return { bytes: details.size, mtimeMs: details.mtimeMs };
  } catch {
    return null;
  }
};
const releaseFiles = await walk(releaseRoot).catch(() => [] as string[]);
const releaseArtifacts = (
  await Promise.all(
    releaseFiles.map(async (path) => {
      const relativePath = packageRelative(releaseRoot, path);
      const kind = releaseArtifactKind(path);
      if (!kind || !isReleaseArtifactLocation(relativePath, kind)) return null;
      const details = await optionalFileDetails(path);
      if (!details) return null;
      return {
        path: relativePath,
        kind,
        ...details,
      };
    })
  )
).filter((artifact): artifact is NonNullable<typeof artifact> => Boolean(artifact));
const asarCandidates = releaseArtifacts.filter((artifact) => artifact.kind === "asar");
const asarArtifact = asarCandidates.length === 1 ? asarCandidates[0] : undefined;
const packageAsar = asarArtifact ? resolve(releaseRoot, asarArtifact.path) : null;
const zipDetails = releaseArtifacts.find((artifact) => artifact.kind === "zip");
const dmgDetails = releaseArtifacts.find((artifact) => artifact.kind === "dmg");
const verifyZipAsar = async () => {
  if (process.platform !== "darwin" || !zipDetails || !packageAsar) return null;
  const zipPath = resolve(releaseRoot, zipDetails.path);
  try {
    const listingProcess = Bun.spawn(["/usr/bin/unzip", "-Z1", zipPath], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const listing = await new Response(listingProcess.stdout).text();
    const listingError = await new Response(listingProcess.stderr).text();
    if ((await listingProcess.exited) !== 0) {
      throw new Error(listingError.trim() || "unzip could not list the archive");
    }
    const entries = zipAsarEntries(listing);
    if (entries.length !== 1 || !entries[0]) {
      throw new Error(`expected one embedded app.asar, found ${entries.length}`);
    }
    const extractProcess = Bun.spawn(["/usr/bin/unzip", "-p", zipPath, entries[0]], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const embeddedBytes = Buffer.from(await new Response(extractProcess.stdout).arrayBuffer());
    const extractError = await new Response(extractProcess.stderr).text();
    if ((await extractProcess.exited) !== 0) {
      throw new Error(extractError.trim() || "unzip could not read embedded app.asar");
    }
    const packagedBytes = await readFile(packageAsar);
    const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
    const embeddedSha256 = hash(embeddedBytes);
    const packagedSha256 = hash(packagedBytes);
    return {
      embeddedPath: entries[0],
      embeddedBytes: embeddedBytes.byteLength,
      embeddedSha256,
      packagedSha256,
      verified: embeddedSha256 === packagedSha256,
      error: embeddedSha256 === packagedSha256 ? null : "embedded app.asar hash differs",
    };
  } catch (error) {
    return {
      embeddedPath: null,
      embeddedBytes: null,
      embeddedSha256: null,
      packagedSha256: null,
      verified: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
};
const newestBuildMtimeMs = Math.max(
  ...(await Promise.all(
    [...files, ...(await walk(electronRoot))].map(async (path) => (await stat(path)).mtimeMs)
  ))
);
const lazyMeasurements = await readLazyClosures();

const report = {
  measuredAt: new Date().toISOString(),
  renderer: {
    files: metrics.length,
    bytes: sum(metrics, "bytes"),
    gzipBytes: sum(metrics, "gzipBytes"),
    buildMetadata: {
      files: buildMetadataMetrics,
      bytes: sum(buildMetadataMetrics, "bytes"),
      gzipBytes: sum(buildMetadataMetrics, "gzipBytes"),
    },
    byExtension,
    startup: {
      files: startup,
      bytes: sum(startup, "bytes"),
      gzipBytes: sum(startup, "gzipBytes"),
    },
    largestJavaScript: metrics
      .filter((metric) => metric.path.endsWith(".js"))
      .sort((left, right) => right.bytes - left.bytes)
      .slice(0, 20),
    lazyClosures: lazyMeasurements?.closures ?? null,
    lazyBoundaryAudit: lazyMeasurements?.audit ?? null,
    violations: {
      sourceMaps: metrics
        .filter((metric) => metric.path.endsWith(".map"))
        .map((metric) => metric.path),
      wasm: metrics.filter((metric) => metric.path.endsWith(".wasm")).map((metric) => metric.path),
    },
  },
  electron: {
    files: electronMetrics,
    bytes: sum(electronMetrics, "bytes"),
    gzipBytes: sum(electronMetrics, "gzipBytes"),
  },
  package: {
    platform: process.platform,
    arch: process.arch,
    releaseArtifacts,
    asarCandidates: asarCandidates.map((artifact) => artifact.path),
    newestBuildMtimeMs,
    asarBytes: asarArtifact?.bytes ?? null,
    asarMtimeMs: asarArtifact?.mtimeMs ?? null,
    asar: packageAsar ? await readAsarInventory(packageAsar) : null,
    zipBytes: zipDetails?.bytes ?? null,
    zipMtimeMs: zipDetails?.mtimeMs ?? null,
    dmgBytes: dmgDetails?.bytes ?? null,
    dmgMtimeMs: dmgDetails?.mtimeMs ?? null,
    zipAsarVerification: await verifyZipAsar(),
  },
};
const serialized = JSON.stringify(report, null, 2);
if (process.env.OPENTEAM_AUDIT_OUTPUT) {
  await Bun.write(process.env.OPENTEAM_AUDIT_OUTPUT, `${serialized}\n`);
}
console.log(serialized);
