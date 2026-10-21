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
    workspaceStartup: { bytes: number } | null;
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
  process.argv.includes("--release") || process.env.OPENTEAM_REQUIRE_PACKAGE === "1";
const atMost = (label: string, actual: number, maximum: number) => {
  if (actual > maximum) failures.push(`${label}: ${actual} > ${maximum}`);
};
const entry = result.renderer.startup.files
  .filter((file) => file.path.endsWith(".js") && !file.path.includes("rolldown-runtime"))
  .sort((left, right) => right.bytes - left.bytes)[0];
if (!entry) failures.push("entry JavaScript was not found in index.html");
else atMost("entry bytes", entry.bytes, 800_000);
atMost("startup bytes", result.renderer.startup.bytes, 1_200_000);
if (!result.renderer.workspaceStartup) failures.push("Workspace startup closure is missing");
// noVNC's new dynamic boundary changes shared chunk layout: 1,205,086 bytes
// versus 1,192,236 in the previous desktop. The 187 KB RFB client stays lazy.
// Current main (69b13a34) measures 1,216,024 bytes after composer motion;
// the shared Model/Voice notes settings bring it to 1,216,277 bytes.
else atMost("signed-in workspace startup bytes", result.renderer.workspaceStartup.bytes, 1_216_600);
const startupCssBytes = result.renderer.startup.files
  .filter((file) => file.path.endsWith(".css"))
  .reduce((total, file) => total + file.bytes, 0);
// The shadcn shell and modular responsive sidebar bring the complete startup
// stylesheet to 177,306 bytes. Keep less than 0.4% headroom and stay below
// 178 KB rather than moving established navigation behind first-open boundaries.
atMost("startup CSS bytes", startupCssBytes, 178_600);
// September 16: worker isolation and the complete memory/plugin/settings UI
// measure 15.90 MB / 3.887 MB gzip. Account for the worker's separate runtime;
// retain the existing entry, CSS and grammar-total ceilings.
// The on-demand noVNC client adds ~270 KB / 90 KB gzip, including license notices.
// It must remain outside both startup closures and has its own limits below.
// +15 KB (2026-10) for the first-run sign-in and setup wizard (lazy) and the restored
// model and transcription settings. Measured total: 16,256,908 bytes.
// +19 KB (2026-10) for the setup screens' motion (view transitions, step pictures, the
// "It works!" moment; all lazy). Measured total: 16,282,593 bytes; 16,291,269 with the
// motion review (overlapping screen changes, kept pictures, and setup's frame on the boot
// screen while signing in reloads the app). +28 KB for spring motion, the living stage, the
// first bot's landing, and the official provider icons: measured 16,318,802 bytes;
// 16,333,358 with the server check's live topology and the searchable model picker;
// 16,341,410 with setup's chaos fixes (time limits, plain-words errors and retries, the
// other-device bot, the signed-out step); 16,346,448 with the sign-in-or-key step for ChatGPT
// and Claude, checked keys, and the model select.
// October 20: thinking-orb loaders and the voice note glow add 72 KB / 28 KB gzip on demand.
// With them and the server gauges: 16,425,283 bytes.
// Main at 69b13a34 measures 16,448,915 after auto-review settings and composer
// motion. The dedicated Model/Voice notes pages add 5,358 bytes (16,454,273 total).
atMost("renderer bytes", result.renderer.bytes, 16_455_000);
// +10 KB (2026-09) for Settings → Providers and its provider logos (~9 KB gzip).
// Measured total with the former saved-login screen: 4,016,715 bytes.
// The first-run wizard and settings measure 4,022,126 bytes gzip (2026-10); with the
// setup screens' motion, 4,028,383; with spring motion, the landing and the official
// provider icons, 4,041,683; with the topology and the model picker, 4,046,893; with the
// chaos fixes, 4,050,224; with the sign-in-or-key step and the model select, 4,051,639; with
// the thinking-orb loaders, the voice note glow and the server gauges, 4,083,231.
// Current main measures 4,089,620 gzip; Model/Voice notes settings: 4,092,502.
atMost("renderer gzip bytes", result.renderer.gzipBytes, 4_093_000);
atMost("build-analysis metadata bytes", result.renderer.buildMetadata.bytes, 256_000);
// October 1 release baseline, including the native launcher and current tool
// contracts: 2,447,064 bytes with pinned Bun 1.4.2. The same sources with Bun
// 1.3.8 are 10,758 bytes larger. Retain the individual bundle limits below
// and less than 1% aggregate headroom for this measured feature baseline.
atMost("Electron runtime bytes", result.electron.bytes, 2_460_000);
const electronFileBudget = (path: string, maximum: number) => {
  const file = result.electron.files.find((candidate) => candidate.path === path);
  if (!file) failures.push(`Electron runtime file is missing: ${path}`);
  else atMost(`Electron ${path} bytes`, file.bytes, maximum);
};
electronFileBudget("main.js", 175_000);
const updaterChunks = result.electron.files.filter(file => /^chunks\/main(?:-[^.]+)?\.js$/.test(file.path));
if (updaterChunks.length !== 1) failures.push("Expected exactly one Electron updater chunk");
else atMost("Electron updater chunk bytes", updaterChunks[0]!.bytes, 600_000);
electronFileBudget("preload.cjs", 10_000);
// AwaitShell adds the bounded RE2 engine and durable job/environment receipts.
// Measured unminified utility: 280,140 bytes; retain the total Electron ceiling.
electronFileBudget("host-utility.js", 285_000);
electronFileBudget("openteam-cli.js", 1_600_000);
if (result.renderer.violations.sourceMaps.length > 0) {
  failures.push(
    `renderer source maps: ${result.renderer.violations.sourceMaps.slice(0, 5).join(", ")}`
  );
}
if (result.renderer.violations.wasm.length > 0) {
  failures.push(`renderer WASM: ${result.renderer.violations.wasm.slice(0, 5).join(", ")}`);
}

const lazyBudgets: Record<string, number> = {
  workspace: 800_000,
  largeCode: 600_000,
  // Sign-in recovery (Start again, session-mismatch guidance) and plugin setup
  // secrets for Bot processes bring the measured October closure to 51,380 bytes.
  pluginDetail: 52_000,
  pluginConnection: 40_000,
  pluginStudio: 30_000,
  privateSkills: 20_000,
  settingsMicrophone: 12_000,
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
  vncProtocol: 280_000,
  fileAttachment: 20_000,
  pdfPreview: 1_500_000,
  docxPreview: 550_000,
  spreadsheetPreview: 550_000,
  routineSummary: 40_000,
  // Thinking-orb loading indicators, fetched on first use so startup stays lean.
  loadingOrb: 28_000,
  // Main's compact voice glow and recording bar measure 59,665 bytes; still lazy.
  voiceMemo: 60_000,
  routineEditor: 100_000,
  newBot: 20_000,
  // The first-run wizard with its shared layout, step pictures, provider marks, and
  // robot artwork. Loads only until setup finishes. Measured October closure: 76,968;
  // 81,925 after the QA fixes (retryable sign-ins, saves and bot creation, submit guards,
  // focus and alerts, the narrow-window avatar, "Copied" feedback); 99,904 with motion
  // (~14 KB of view-transition, step-picture and celebration CSS shared with sign-in,
  // the layout's transition helpers, and react-dom's flushSync); 103,828 with the motion
  // review (kept pictures, the gliding terminal highlight, the signed-in browser card,
  // cross-fading titles, and the server check's opening state for the first-run frame);
  // 127,494 with the cinematic pass: ~13 KB of CSS (spring easings, the living stage, depth
  // and parallax in screen changes, the robots' landing, the "It works!" sweep and burst,
  // and the first bot's landing in the app), ~8.7 KB of official ChatGPT and Claude app
  // icons (two 128 px WebP, inlined), and ~2 KB more of official provider marks;
  // 142,817 with the server check's live topology (~8.5 KB of component and CSS), the
  // searchable model picker for OpenRouter's catalog (~5 KB), and the OpenRouter card;
  // 146,262 with the chaos fixes (the saved model's Try again, fresh server checks with an
  // unreachable state, "still waiting" notes, and the other-device bot); 150,671 with the
  // sign-in-or-key step for ChatGPT and Claude, checked keys, and the model select (a
  // select-style trigger with a filtered list, also on "You're already connected").
  onboarding: 152_000,
  // Welcome, server address, and sign-in; loads only while signed out. Measured
  // October closure: 40,306; 44,595 after the QA fixes (cancellable connects, address
  // checks, and the shared layout's guards and styles); 61,766 with the setup screens'
  // shared motion CSS and transition helpers (see onboarding); 65,416 with the motion
  // review's shared layout and CSS; 66,735 with the cinematic pass's shared CSS (its own
  // pictures, the topology and the model picker live apart, with the setup screens).
  signIn: 68_000,
  pluginSettings: 50_000,
  pluginSettingsDetail: 30_000,
  pluginManagement: 38_000,
  skillImport: 100_000,
  search: 100_000,
  groupAvatarEditor: 10_000,
  // Model and Voice notes navigation with the shared Radix chunks: 42,789 bytes.
  settingsInitial: 43_000,
  // The Voice notes entry and microphone icon bring the settings shell to 10,728.
  settingsShell: 10_900,
  settingsAbout: 10_000,
  // Main already measures 33,930 with auto-review rules.
  settingsGeneral: 34_000,
  settingsComputer: 31_000,
  // Provider sign-in, model selection and testing now load only on Settings → Model.
  // Includes onboarding's shared searchable picker and compact popover (53,386 bytes).
  settingsModel: 54_000,
  // Activity and Remote access stay in Server; measured 10,389 after extraction.
  settingsServer: 11_000,
  // Dedicated Voice notes page: load retry, provider marks, busy indicators and
  // responsive fields. Still lazy; its measured closure is 40,488 bytes.
  settingsTranscription: 40_800,
  // Search and Fetch pages with inlined 40 px WebP logos (~10 KB of the total).
  settingsProviders: 30_000,
  // Shares lucide's triangle-alert chunk with Providers. The signed-out
  // compatibility guard brings the measured October release closure to 10,250 bytes.
  settingsUpdates: 10_300,
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
  // The worker audit includes every transitive embedded grammar (Twig: 2.148 MB).
  shikiLanguages: { entries: 250, largest: 2_160_000, total: 8_000_000 },
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
