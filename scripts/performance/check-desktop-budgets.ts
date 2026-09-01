import { expectedReleaseArtifactKinds } from "./desktop-build-measurement-utils";

const measure = Bun.spawn([process.execPath, "scripts/performance/measure-desktop-build.ts"], {
  cwd: new URL("../..", import.meta.url).pathname,
  stdout: "pipe",
  stderr: "inherit",
});
const output = await new Response(measure.stdout).text();
if ((await measure.exited) !== 0) throw new Error("Desktop measurement failed");

const result = JSON.parse(output) as {
  electron: {
    files: Array<{ path: string; bytes: number; gzipBytes: number }>;
    bytes: number;
    gzipBytes: number;
  };
  renderer: {
    bytes: number;
    gzipBytes: number;
    buildMetadata: { bytes: number };
    byExtension: { css: { bytes: number } };
    lazyClosures: Record<
      string,
      {
        bytes: number;
        isDynamicEntry: boolean;
        nonDynamicSources: string[];
      } | null
    > | null;
    lazyBoundaryAudit: {
      coveredSources: string[];
      dynamicSources: string[];
      nestedDynamicGroups: Record<
        "mermaidDiagrams" | "shikiLanguages",
        {
          bytes: number;
          entries: number;
          largest: { bytes: number; source: string } | null;
          missingEntries: string[];
          startupEntries: string[];
        } | null
      >;
      shikiLanguageEntries: number;
      shikiThemeEntries: number;
      uncoveredDynamicSources: string[];
    } | null;
    violations: {
      sourceMaps: string[];
      wasm: string[];
    };
    startup: { bytes: number; files: Array<{ path: string; bytes: number }> };
  };
  package: {
    platform: NodeJS.Platform;
    arch: string;
    releaseArtifacts: Array<{
      bytes: number;
      kind: "appImage" | "asar" | "dmg" | "nsis" | "zip";
      mtimeMs: number;
      path: string;
    }>;
    asarCandidates: string[];
    newestBuildMtimeMs: number;
    asarBytes: number | null;
    asarMtimeMs: number | null;
    zipBytes: number | null;
    zipMtimeMs: number | null;
    dmgBytes: number | null;
    dmgMtimeMs: number | null;
    zipAsarVerification: {
      embeddedPath: string | null;
      verified: boolean;
      error: string | null;
    } | null;
    asar: {
      headerBytes: number;
      files: number;
      buildComparison: {
        expected: number;
        matched: number;
        missing: string[];
        changed: string[];
        unexpected: string[];
      };
      violations: Record<string, string[]>;
    } | null;
  };
};

const failures: string[] = [];
const requirePackage =
  process.argv.includes("--release") || process.env.OPENBOT_REQUIRE_PACKAGE === "1";
const atMost = (label: string, actual: number, maximum: number) => {
  if (actual > maximum) failures.push(`${label}: ${actual} > ${maximum}`);
};
const entry = result.renderer.startup.files
  .filter((file) => file.path.endsWith(".js") && !file.path.includes("rolldown-runtime"))
  .sort((left, right) => right.bytes - left.bytes)[0];
if (!entry) failures.push("entry JavaScript was not found in index.html");
else atMost("entry bytes", entry.bytes, 800_000);
atMost("startup bytes", result.renderer.startup.bytes, 1_200_000);
const startupCssBytes = result.renderer.startup.files
  .filter((file) => file.path.endsWith(".css"))
  .reduce((total, file) => total + file.bytes, 0);
// Responsive settings and details layouts bring the complete startup stylesheet
// to 165,357 bytes. Keep less than 0.4% headroom and stay below upstream's
// 178.8 KB rather than moving established surfaces behind first-open boundaries.
atMost("startup CSS bytes", startupCssBytes, 166_000);
// Durable recovery, responsive/search parity, direct computer control, and
// bounded-history telemetry bring the complete renderer to 15,546,357 bytes.
// Keep less than 0.06% headroom while the compressed, startup, and nested
// Shiki/Mermaid ceilings continue to guard delivery and first interaction.
atMost("renderer bytes", result.renderer.bytes, 15_555_000);
atMost("renderer gzip bytes", result.renderer.gzipBytes, 3_800_000);
atMost("build-analysis metadata bytes", result.renderer.buildMetadata.bytes, 256_000);
atMost("Electron runtime bytes", result.electron.bytes, 2_300_000);
const electronFileBudget = (path: string, maximum: number) => {
  const file = result.electron.files.find((candidate) => candidate.path === path);
  if (!file) failures.push(`Electron runtime file is missing: ${path}`);
  else atMost(`Electron ${path} bytes`, file.bytes, maximum);
};
electronFileBudget("main.js", 175_000);
electronFileBudget("chunks/main.js", 600_000);
electronFileBudget("preload.cjs", 10_000);
electronFileBudget("host-utility.js", 40_000);
electronFileBudget("openbot-cli.js", 1_600_000);
if (result.renderer.violations.sourceMaps.length > 0) {
  failures.push(
    `renderer source maps: ${result.renderer.violations.sourceMaps.slice(0, 5).join(", ")}`
  );
}
if (result.renderer.violations.wasm.length > 0) {
  failures.push(`renderer WASM: ${result.renderer.violations.wasm.slice(0, 5).join(", ")}`);
}

const lazyBudgets: Record<string, number> = {
  basicMarkdown: 600_000,
  advancedRich: 600_000,
  cjk: 600_000,
  code: 800_000,
  math: 1_050_000,
  mermaid: 1_300_000,
  emojiPanel: 350_000,
  a2aExchange: 5_000,
  asyncTasks: 20_000,
  desktopDialogs: 25_000,
  groupForm: 25_000,
  inspector: 150_000,
  avatarPicker: 20_000,
  botScreen: 20_000,
  botTemplateShare: 20_000,
  fileAttachment: 20_000,
  pdfPreview: 1_500_000,
  docxPreview: 550_000,
  spreadsheetPreview: 550_000,
  routineSummary: 40_000,
  routineEditor: 100_000,
  routineEventFields: 40_000,
  newBot: 20_000,
  pluginSettings: 50_000,
  pluginSettingsDetail: 30_000,
  search: 100_000,
  groupAvatarEditor: 10_000,
  settingsInitial: 40_000,
  settingsShell: 10_000,
  settingsAbout: 10_000,
  settingsGeneral: 30_000,
  settingsGeneralBot: 30_000,
  settingsComputer: 30_000,
  settingsUpdates: 10_000,
};
if (!result.renderer.lazyClosures) {
  failures.push("Vite manifest/lazy closures were not found; run a current desktop build");
} else {
  for (const [name, maximum] of Object.entries(lazyBudgets)) {
    const closure = result.renderer.lazyClosures[name];
    if (!closure) failures.push(`${name} lazy boundary was not found in the Vite manifest`);
    else {
      atMost(`${name} static lazy closure bytes`, closure.bytes, maximum);
      if (!closure.isDynamicEntry) {
        failures.push(
          `${name} is not a dynamic manifest entry: ${closure.nonDynamicSources.join(", ")}`
        );
      }
    }
  }
}
if (!result.renderer.lazyBoundaryAudit) {
  failures.push("Vite dynamic-boundary coverage audit was not found");
} else if (result.renderer.lazyBoundaryAudit.uncoveredDynamicSources.length > 0) {
  failures.push(
    `unbudgeted renderer dynamic entries: ${result.renderer.lazyBoundaryAudit.uncoveredDynamicSources.join(", ")}`
  );
}
if ((result.renderer.lazyBoundaryAudit?.shikiThemeEntries ?? 0) > 0) {
  failures.push(
    `Shiki theme registry entries: ${result.renderer.lazyBoundaryAudit?.shikiThemeEntries}`
  );
}
const nestedDynamicBudgets = {
  shikiLanguages: { entries: 250, largest: 2_100_000, total: 8_000_000 },
  mermaidDiagrams: { entries: 50, largest: 2_100_000, total: 3_500_000 },
} as const;
for (const [name, maximum] of Object.entries(nestedDynamicBudgets)) {
  const group =
    result.renderer.lazyBoundaryAudit?.nestedDynamicGroups[
      name as keyof typeof nestedDynamicBudgets
    ];
  if (!group) {
    failures.push(`${name} nested dynamic payload audit was not found`);
    continue;
  }
  if (group.entries === 0) failures.push(`${name} has no demand-loaded entries`);
  atMost(`${name} nested dynamic entries`, group.entries, maximum.entries);
  atMost(`${name} total unique bytes`, group.bytes, maximum.total);
  if (!group.largest) failures.push(`${name} largest nested payload was not measured`);
  else atMost(`${name} largest static closure bytes`, group.largest.bytes, maximum.largest);
  if (group.missingEntries.length > 0) {
    failures.push(
      `${name} missing manifest entries: ${group.missingEntries.slice(0, 5).join(", ")}`
    );
  }
  if (group.startupEntries.length > 0) {
    failures.push(`${name} leaked into startup: ${group.startupEntries.slice(0, 5).join(", ")}`);
  }
}

if (requirePackage && result.package.asarBytes !== null && result.package.asar) {
  atMost("ASAR bytes", result.package.asarBytes, 25 * 1024 * 1024);
  atMost("ASAR header bytes", result.package.asar.headerBytes, 256 * 1024);
  atMost("ASAR files", result.package.asar.files, 1_000);
  for (const [kind, paths] of Object.entries(result.package.asar.violations)) {
    if (paths.length > 0) failures.push(`${kind}: ${paths.slice(0, 5).join(", ")}`);
  }
}
if (requirePackage) {
  const artifactBudgets = {
    appImage: 160 * 1024 * 1024,
    dmg: 135 * 1024 * 1024,
    nsis: 160 * 1024 * 1024,
    zip: 130 * 1024 * 1024,
  } as const;
  for (const artifact of result.package.releaseArtifacts) {
    if (artifact.kind === "asar") continue;
    atMost(
      `${artifact.kind} artifact ${artifact.path}`,
      artifact.bytes,
      artifactBudgets[artifact.kind]
    );
  }
}

if (requirePackage) {
  if (result.package.asarCandidates.length !== 1) {
    failures.push(
      `exactly one packaged app.asar is required; found ${result.package.asarCandidates.length}`
    );
  }
  if (result.package.asarBytes === null || !result.package.asar) {
    failures.push("release app.asar is required");
  }
  for (const kind of expectedReleaseArtifactKinds(result.package.platform)) {
    if (!result.package.releaseArtifacts.some((artifact) => artifact.kind === kind)) {
      failures.push(`${kind} release artifact is required on ${result.package.platform}`);
    }
  }
  if (
    result.package.platform === "darwin" &&
    result.package.releaseArtifacts.some((artifact) => artifact.kind === "zip") &&
    !result.package.zipAsarVerification?.verified
  ) {
    failures.push(
      `ZIP embedded app.asar was not verified: ${result.package.zipAsarVerification?.error ?? "verification unavailable"}`
    );
  }
  if (
    result.package.asarMtimeMs !== null &&
    result.package.asarMtimeMs < result.package.newestBuildMtimeMs
  ) {
    failures.push("release app.asar predates the current desktop build");
  }
  if (result.package.asarMtimeMs !== null) {
    for (const artifact of result.package.releaseArtifacts) {
      if (artifact.kind !== "asar" && artifact.mtimeMs < result.package.asarMtimeMs) {
        failures.push(`${artifact.path} predates app.asar`);
      }
    }
  }
  const comparison = result.package.asar?.buildComparison;
  if (comparison) {
    if (comparison.matched !== comparison.expected) {
      failures.push(
        `packaged build content: ${comparison.matched}/${comparison.expected} current files match`
      );
    }
    if (comparison.missing.length > 0) {
      failures.push(`package missing: ${comparison.missing.slice(0, 5).join(", ")}`);
    }
    if (comparison.changed.length > 0) {
      failures.push(`package changed: ${comparison.changed.slice(0, 5).join(", ")}`);
    }
    if (comparison.unexpected.length > 0) {
      failures.push(`stale package files: ${comparison.unexpected.slice(0, 5).join(", ")}`);
    }
  }
}

if (failures.length > 0) {
  console.error(
    `Desktop performance budgets failed:\n${failures.map((item) => `- ${item}`).join("\n")}`
  );
  process.exit(1);
}
console.log(
  `Desktop performance budgets pass (entry ${entry?.bytes ?? "n/a"} B, startup ${result.renderer.startup.bytes} B, renderer ${result.renderer.bytes} B, ASAR ${requirePackage ? `${result.package.asarBytes ?? "missing"} B` : "not checked; use the release gate"}).`
);
