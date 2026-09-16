import {
  modelFixture,
  providerAccessFixture,
  activate,
  press,
  edit,
} from "../test/fixtures/model-session";
import { clampViewport } from "../src/ui";
import {
  connectionFixture,
  choose,
  settle,
  connectionScreen,
} from "../test/fixtures/provider-connection";
import {
  galleryWidths,
  writeTerminalGallery,
  type TerminalGalleryScenario,
} from "./terminal-gallery";
const scenarios = [
  ["inference", "Inference settings"],
  ["models", "Searchable inference models"],
  ["providers", "Connected and disconnected providers"],
  ["connection-choice", "Choose saved login or browser sign-in"],
  ["connection-browser", "Browser sign-in with cancellation"],
  ["connection-key", "Hidden API key entry"],
  ["connection-import-missing", "Missing local Claude login"],
  ["discovery-error", "Provider model discovery failed"],
  ["transcription", "Transcription settings"],
  ["audio-models", "Transcription model picker"],
  ["secret", "Masked API key entry"],
  ["error", "Save error with recommended action"],
  ["discard", "Unsaved changes"],
] as const;
const args = process.argv.slice(2);
if (args.includes("--list")) {
  for (const [id, title] of scenarios) console.log(`${id.padEnd(16)} ${title}`);
} else {
  const option = (name: string) => {
    const index = args.indexOf(name);
    return index < 0 ? undefined : args[index + 1];
  };
  const directory = option("--gallery");
  const requested = option("--scenario") ?? (directory ? "all" : "inference");
  const selected = scenarios.filter(([id]) => requested === "all" || requested === id);
  if (!selected.length) throw new Error(`Unknown scenario: ${requested}`);
  const data: TerminalGalleryScenario[] = [];
  for (const [id, title] of selected) {
    const { session: s, api } = modelFixture();
    if (id === "providers") {
      const catalog = api.catalog.bind(api);
      api.catalog = async (...args) => ({
        ...(await catalog(...args)),
        inference: { providerId: "openai", modelId: "reasoner", reasoning: "high" },
        providers: providerAccessFixture(),
      });
    }
    if (id === "discovery-error") {
      const catalog = api.catalog.bind(api);
      api.catalog = async (...args) => {
        const value = await catalog(...args);
        value.models = [];
        value.providers[0] = {
          ...value.providers[0]!,
          modelCount: 0,
          modelStatus: "unavailable",
          modelMessage:
            "The provider rejected model discovery (HTTP 401). Reconnect it or grant model-list access.",
        };
        return value;
      };
    }
    await s.load();
    if (["transcription", "audio-models", "secret", "error"].includes(id)) await press(s, "right");
    if (id === "models") await activate(s, "model");
    if (id === "providers") await activate(s, "provider");
    if (id === "audio-models") await activate(s, "browse-transcription");
    if (id === "secret") {
      await activate(s, "apiKey");
      s.handle("synthetic-preview-key", {});
    }
    if (id === "error") {
      await edit(s, "transcription-model", "speech-large");
      api.saveTranscription = async () => {
        throw new Error(
          "The audio server is unavailable. Check its base URL and start the service, then retry Save."
        );
      };
      await activate(s, "save");
    }
    if (id === "discard") {
      await activate(s, "thinking");
      await press(s, "escape");
    }
    const connection = id.startsWith("connection-")
      ? connectionFixture(id === "connection-key" ? "api_key" : "oauth")
      : null;
    if (connection && id === "connection-browser") {
      choose(connection.session, "browser");
      await settle(() => connection.session.actions().some((action) => action.id === "open"));
    }
    if (connection && id === "connection-key")
      connection.session.handle("synthetic-preview-key", {});
    if (connection && id === "connection-import-missing") {
      connection.api.importLogin = async () => {
        throw new Error(
          "No reusable Claude Code login found. Sign in with Claude Code first, or choose Browser sign-in."
        );
      };
      choose(connection.session, "import");
      await settle(() => connectionScreen(connection.session).includes("No reusable"));
    }
    const previewSession = connection?.session ?? s;
    const reports = Object.fromEntries(
      galleryWidths.map((width) => {
        const frame = previewSession.frame(width, true);
        const viewport = clampViewport(
          frame.body,
          frame.cursorLine,
          Math.max(3, 24 - frame.header.length - frame.footer.length - 1),
          0,
          false,
          frame.cursorEndLine
        );
        return [
          width,
          {
            full: [...frame.header, ...frame.body, ...frame.footer].join("\n"),
            terminal: [...frame.header, ...viewport.lines, ...frame.footer].join("\n"),
          },
        ];
      })
    );
    data.push({ id, title, reports });
    if (!directory) {
      const frame = previewSession.frame(
        Number(option("--width") ?? 90),
        Boolean(process.stdout.isTTY)
      );
      console.log([...frame.header, ...frame.body, ...frame.footer].join("\n"));
    }
    await connection?.session.dispose();
  }
  if (directory) console.log(writeTerminalGallery(directory, data, "model"));
}
