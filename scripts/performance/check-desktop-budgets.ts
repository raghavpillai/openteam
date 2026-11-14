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
// Settings → Computer's Update Bot's Computer card with Stop brings it to 1,217,389.
// Settings → Timezone and the device time zone report bring it to 1,218,399.
// Messages settings and its permissions dialog (#165) bring it to 1,221,328; the Settings
// cleanup (#187) and the open-chat reply fix (#191), 1,224,485.
// November 3: update notices/recovery and attachment previews measure 1,244,722
// after durable-delivery imports capabilities directly. Keep the contracts barrel's
// tool definitions and Effect runtime out: that regression measures 1,700,685.
// v0.0.13: contextual send failures, account controls and settings styling measure
// 1,248,419 bytes. The settings Select stays outside pages that do not use it.
// v0.0.14: delivery/loading UI and shared resource ownership measure 1,258,168.
// Automatic lifecycle chunking avoids a React initialization cycle in built entries.
// Grok Bot conversation chrome, attachment stages and opt-in message colors:
// 1,278,577 bytes after integrating main's in-app links. Library stays lazy (6,201 B).
// Main at 4bb02542 measures 1,279,660. ScreenBot add no startup code (the bridge is lazy),
// but a second page shares React DOM and delivery modules: chunk glue measures 1,280,840;
// the voice recorder taking its transcriber as a parameter (for dictation), 1,281,496;
// the theme helper taking an explicit preference (the overlay's own storage), 1,281,509.
// Main at 2090e228 measures 1,287,125 (over its own 1,280,000); with ScreenBot, 1,288,966.
// Email review forwarding, revision highlights, validation and read-only history:
// 1,293,288 B on this baseline. File previews reuse the lazy attachment viewer.
// Rebindable shortcuts: windows match key presses against the saved bindings and show them in
// hints (the rules and labels load with Settings): 1,292,846.
// Both together on main at 3f91add4 (#309 email review + rebindable shortcuts): 1,297,183.
// Hold-to-dictate and double-press gestures for the Dictate shortcut: 1,298,156.
// The "microphone still starting" message for a hold released too early: 1,298,850.
// Main at f17447de (#315 file previews) measures 1,322,729, over its own limit; with this
// branch, 1,328,296.
// Main at 02abba39 with the rich map presentations (the lazy presentation hook in rich
// messages; the map renderer itself stays on demand): 1,329,632.
// v0.0.18: the reviewed account fences and authenticated photo resources measure
// 1,332,858 B; maps and the ScreenBot bridge retain their lazy boundaries.
// Question lifecycle and immutable history receipts: 1,338,466 B versus the same
// untouched main build's 1,334,586 B (+3,880 B). Keep the 4 KB feature allowance bounded.
else atMost("signed-in workspace startup bytes", result.renderer.workspaceStartup.bytes, 1_339_000);
const startupCssBytes = result.renderer.startup.files
  .filter((file) => file.path.endsWith(".css"))
  .reduce((total, file) => total + file.bytes, 0);
// The shadcn shell and modular responsive sidebar bring the complete startup
// stylesheet to 177,306 bytes. Retain narrow headroom while keeping established
// navigation available at startup.
// v0.0.13 adds sidebar, pending-message and settings styles: 181,253 bytes.
// v0.0.14 delivery/loading styles and background animation controls: 183,131.
// The matching chat/details/media styling brings the measured stylesheet to 200,278 B.
// Main at 2090e228: 201,404 B; ScreenBot' settings row adds 450 (201,854).
// Main at f17447de (#315 file previews): 220,564 B; with this branch, 220,625.
// v0.0.18 measured startup CSS: 221,640 B.
atMost("startup CSS bytes", startupCssBytes, 222_000);
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
// Setup's web search step adds 6,667 bytes (16,460,940 total). Main at 7ae74a08 measures
// 16,461,074; the Update Bot's Computer card with Stop adds 3,458 (16,464,532 total).
// Settings → Timezone adds 3,901 (16,468,433 total). Messages on the desktop (#165) and the
// Settings cleanup (#187) bring it to 16,485,550.
// November 3: update progress/recovery, device networking, saved-key controls and
// attachment previews measure 16,523,942 after the capabilities import fix.
// v0.0.13 measures 16,529,321 bytes after isolating SettingsSelectContent.
// v0.0.14 resource/cache ownership and delivery UI: 16,542,075 after safe chunking.
// Native presentation widgets + MapLibre add 1,089,152 bytes on demand. The
// signed-in startup increases only 689 bytes; retain its existing ceiling.
// Conversation/Library/media styling and bot-color controls: 16,572,650 bytes.
// v0.0.17 persistent computer control and handoff completion: 16,583,992 B.
// ScreenBot' overlay page (capture motion, mascot, composer, its styles) and lazy bridge:
// 16,633,150 B with frame-accurate motion (soft limits, handovers, animated line growth);
// 16,647,600 B with dictation in the composer and Settings › ScreenBot (shortcut recorder);
// 16,649,756 B after the overlay's performance review (off-thread thumbnail and texture,
// bounded goo mask, released images, race fixes);
// 16,650,624 B with dictation on the chat's voice-note bar (the custom strip removed) and
// the adversarial-review fixes (own storage, request guards, reserved shortcuts);
// 16,651,901 B with one continuous card shadow (the goo's SVG copy of the card's two layers);
// 16,652,343 B with Esc leaving early (mid-intro fade, dismissing the sent pill).
// Rebased on main at 2090e228 (16,593,176 B on its own): 16,661,513 B; 16,662,762 B with
// the Bot menu fitting the screen (flips below the chip) and fading where it scrolls.
// Main at 521b9f32 grows to 16,599,431 B (+6,255, routines); with ScreenBot, 16,669,264 B.
// Email review parity on this baseline: 16,673,564 B.
// Settings › Keyboard and rebindable shortcuts: 16,678,696 B.
// Both together on main at 3f91add4: 16,683,510 B.
// With the Dictate hold/double-press gestures: 16,685,425 B; dictation from anywhere in the
// conversation and ScreenBot's fading voice-bar exit: 16,686,084 B.
// Main at f17447de: 16,720,649 B; with this branch, 16,733,081 B; 16,734,520 B with ScreenBot's
// "Sent" check matching the file preview's and dictation inside a preview.
// Main at 02abba39 with the native presentation widgets and MapLibre (lazy), the OpenStreetMap
// plugin move and the presentation polish: 17,867,243 B.
// v0.0.18 after separating Settings Switch: 17,890,302 B / 4,478,603 gzip.
// Includes generation-fenced photo loading and ScreenBot ownership; no new dependency.
atMost("renderer bytes", result.renderer.bytes, 17_892_000);
// +10 KB (2026-09) for Settings → Providers and its provider logos (~9 KB gzip).
// Measured total with the former saved-login screen: 4,016,715 bytes.
// The first-run wizard and settings measure 4,022,126 bytes gzip (2026-10); with the
// setup screens' motion, 4,028,383; with spring motion, the landing and the official
// provider icons, 4,041,683; with the topology and the model picker, 4,046,893; with the
// chaos fixes, 4,050,224; with the sign-in-or-key step and the model select, 4,051,639; with
// the thinking-orb loaders, the voice note glow and the server gauges, 4,083,231.
// Current main measures 4,089,620 gzip; Model/Voice notes settings: 4,092,502; main at
// 7ae74a08 (web search setup, Stop), 4,093,841; the Update Bot's Computer card, 4,095,467;
// Settings → Timezone, 4,096,699; Messages and the Settings cleanup, 4,101,637.
// The same November feature baseline measures 4,113,699 gzip bytes.
// The same v0.0.13 build measures 4,116,499 gzip bytes.
// Resource ownership and background lifecycle controls measure 4,118,074 gzip
// bytes. Allow 2 KB for worker retirement, blob leases and shared activity hooks.
// The same v0.0.14 build measures 4,121,192 gzip bytes, including chunk metadata.
// The same presentation/MapLibre payload adds 276,742 gzip bytes.
// Same feature baseline: 4,125,698 gzip bytes.
// Same v0.0.17 build: 4,131,675 gzip bytes; startup ceilings stay unchanged.
// With the screenbot overlay page and bridge: 4,146,316 gzip bytes; with dictation and the
// shortcut settings: 4,152,175; after the review fixes, the chat's voice bar in the composer
// and one continuous card shadow: 4,153,604; with Esc leaving early: 4,153,714.
// Rebased on main at 2090e228 (4,133,729 on its own): 4,157,884.
// Main at 521b9f32: 4,135,795; with ScreenBot, 4,160,418.
// Same email review feature build: 4,161,640 B gzip.
// Settings › Keyboard and rebindable shortcuts: 4,163,937.
// Both together on main at 3f91add4: 4,165,193.
// With the dictate gestures and microphone indication: 4,166,041.
// Main at f17447de: 4,174,402; with this branch, 4,178,761.
// Main at 02abba39 with the presentation/MapLibre payload and polish: 4,467,610.
atMost("renderer gzip bytes", result.renderer.gzipBytes, 4_480_000);
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
// v0.0.18 scoped ScreenBot dictation and pinned public transport: 176,039 B.
electronFileBudget("main.js", 177_000);
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

// v0.0.18 settings add skeletons, motion, sections and Keyboard navigation. Moving
// InteractiveSwitch out of the shared layout saves ~3.1 KB in affected closures.
// Measured shell/initial: 19,493 / 54,628 B; microphone stays below its unchanged
// 12 KB limit. Adjust only measured feature closures; retain all boundary audits.
const lazyBudgets: Record<string, number> = {
  workspace: 800_000,
  largeCode: 600_000,
  // Sign-in recovery (Start again, session-mismatch guidance) and plugin setup
  // secrets for Bot processes bring the measured October closure to 51,380 bytes.
  // The Settings cleanup's shared Select (#187) adds about 21.6 KB to each plugin closure:
  // 73,336, 46,419, 40,512 and 36,231.
  // The Library API method adds shared client code: measured 73,850 bytes.
  // Main at 2090e228 measures 75,627 (unchanged by ScreenBot).
  pluginDetail: 76_500,
  pluginConnection: 46_800,
  pluginStudio: 40_900,
  privateSkills: 36_600,
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
  // forms.tsx no longer has a caller or manifest entry in the baseline build.
  // Lazy: loads only with a map or ranked-list message. Glass surfaces, spring
  // curves, the card-to-preview morph, photo pins and the weighted carousel
  // measured 207,406 B with MapLibre's CSS; the round-2 review fixes brought
  // it to 214,168 B.
  richPresentation: 219_000,
  mapRenderer: 925_000,
  inspector: 150_000,
  // Conversation attachment index; document parsers remain separately lazy.
  // Main at f17447de (#315): 6,725, unchanged by this branch.
  channelLibrary: 7_000,
  avatarPicker: 20_000,
  // The main window's half of ScreenBots: Bot list and durable delivery for the overlay.
  screenBotBridge: 3_500,
  // Settings › Keyboard: the screenbot trigger and the app's rebindable shortcuts, each with a
  // recorder, Change and Reset.
  keyboardSettings: 17_000,
  // Persistent ownership, reconnect recovery and handoff controls: 27,676 B.
  // This closure stays dynamic; noVNC retains its separate lazy boundary.
  botScreen: 28_000,
  vncProtocol: 280_000,
  // Main at f17447de (#315 gooey preview composer): 32,418, unchanged by this branch.
  fileAttachment: 32_500,
  pdfPreview: 1_500_000,
  docxPreview: 550_000,
  spreadsheetPreview: 550_000,
  routineSummary: 40_000,
  // Thinking-orb loading indicators, fetched on first use so startup stays lean.
  loadingOrb: 28_000,
  // Main's compact voice glow and recording bar measure 59,665 bytes; still lazy.
  // v0.0.13 glow smoothing and transition state add 4,479 bytes: 64,144 total.
  // Suspending the shared AudioContext when the last bar unmounts, and the level callback
  // screenbot dictation uses: 64,520.
  // The dimmed, pulsing timer while the microphone opens: 64,801.
  voiceMemo: 64_900,
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
  // select-style trigger with a filtered list, also on "You're already connected");
  // 152,506 with the web search step (a recommended provider, its key and a real check);
  // 153,026 with the Settings cleanup; 153,503 on main at 02abba39 with the presentation
  // contracts export.
  onboarding: 154_000,
  // Welcome, server address, and sign-in; loads only while signed out. Measured
  // October closure: 40,306; 44,595 after the QA fixes (cancellable connects, address
  // checks, and the shared layout's guards and styles); 61,766 with the setup screens'
  // shared motion CSS and transition helpers (see onboarding); 65,416 with the motion
  // review's shared layout and CSS; 66,735 with the cinematic pass's shared CSS (its own
  // pictures, the topology and the model picker live apart, with the setup screens);
  // 69,096 with the web search stage's shared tint and five-step progress.
  signIn: 69_500,
  // 40,608 with Messages (#165); 62,814 with the shared Select (#187).
  pluginSettings: 64_000,
  pluginSettingsDetail: 30_000,
  pluginManagement: 38_000,
  skillImport: 100_000,
  search: 100_000,
  groupAvatarEditor: 10_000,
  // Model and Voice notes navigation with the shared Radix chunks: 42,789 bytes;
  // 46,297 with the Timezone page.
  settingsInitial: 55_000,
  // The Voice notes entry and microphone icon bring the settings shell to 10,728;
  // 11,132 with the Messages entry and the Settings cleanup.
  // Shared SettingsLink navigation (#199/#201) brings the closure to 11,557.
  // v0.0.13 shared control styles: 13,550, without the ~21 KB Select dependency.
  // Shared controls/client code with message-color settings: 13,966 bytes.
  // The Keyboard entry and its icon: 14,714.
  settingsShell: 20_000,
  settingsAbout: 10_000,
  // Main already measures 33,930 with auto-review rules; 37,276 with Timezone.
  settingsGeneral: 42_000,
  settingsComputer: 31_000,
  // Dedicated network priority controls, including their on-demand stylesheet.
  settingsNetwork: 26_000,
  // Provider sign-in, model selection and testing now load only on Settings → Model.
  // Includes onboarding's shared searchable picker and compact popover (53,386 bytes).
  // v0.0.13 styled controls and dropdown wrapper: 56,267 bytes.
  settingsModel: 60_000,
  // Activity and Remote access stay in Server; measured 10,389 after extraction.
  // Connected version/update navigation and the moved machine controls (#201/#211)
  // measure 17,312. Browser network settings retain their separate lazy boundary.
  // v0.0.13 shared control styles: 18,849 bytes; network and Select remain lazy.
  // Same shared client change: 19,319 bytes.
  settingsServer: 25_000,
  // Dedicated Voice notes page: load retry, provider marks, busy indicators and
  // responsive fields. Still lazy; its measured closure is 40,488 bytes; 41,304 after the
  // Settings cleanup.
  // Saved-key replacement and explicit deletion (#197): 41,955.
  settingsTranscription: 44_500,
  // Search and Fetch pages with inlined 40 px WebP logos (~10 KB of the total).
  settingsProviders: 32_000,
  // Shares lucide's triangle-alert chunk with Providers. The signed-out
  // compatibility guard brings the measured October release closure to 10,250 bytes.
  // Unified server updates with stages, idle confirmation and restart recovery
  // (#201) measure 17,768; this UI remains lazy.
  // v0.0.13 compact shared buttons/styles: 18,677 bytes.
  settingsUpdates: 21_000,
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
