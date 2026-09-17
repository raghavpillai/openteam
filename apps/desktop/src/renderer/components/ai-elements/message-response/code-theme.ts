import type { ThemeInput } from "streamdown";

const botLightTheme = {
  name: "bot-light",
  type: "light",
  colors: {
    "editor.background": "#fcfcfc",
    "editor.foreground": "#333333",
  },
  settings: [
    { settings: { background: "#fcfcfc", foreground: "#333333" } },
    {
      scope: ["comment", "punctuation.definition.comment"],
      settings: { foreground: "#686868" },
    },
    {
      scope: [
        "keyword",
        "storage.type.function",
        "storage.type.string",
        "storage.modifier",
        "constant.language",
      ],
      settings: { foreground: "#ae1d42" },
    },
    {
      scope: [
        "entity.name.function",
        "entity.name.function.call",
        "entity.name.command",
        "support.function",
      ],
      settings: { foreground: "#d67551" },
    },
    {
      scope: [
        "support.type",
        "entity.name.type",
        "constant.numeric",
        "constant.other.option",
        "constant.character.format.placeholder",
        "support.type.property-name",
      ],
      settings: { foreground: "#306493" },
    },
    {
      scope: ["string", "string.quoted", "string.interpolated"],
      settings: { foreground: "#a194d4" },
    },
    {
      scope: ["string.json", "support.type.property-name.json"],
      settings: { foreground: "#333333" },
    },
  ],
} satisfies ThemeInput;

export const botShikiTheme: [ThemeInput, ThemeInput] = [botLightTheme, "github-dark"];

