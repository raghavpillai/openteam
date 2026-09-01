import { describe, expect, test } from "bun:test";
import {
  BOT_TEMPLATE_REQUEST,
  BOT_TEMPLATE_SHARING_ENABLED,
  botTemplateShareUrl,
  parseBotTemplate,
  parseBotTemplateShareUrl,
  serializeBotTemplate,
} from "../src/renderer/lib/bot-template";

describe("OpenBot template sharing", () => {
  test("ships the Grok-parity template-sharing flow", () => {
    expect(BOT_TEMPLATE_SHARING_ENABLED).toBe(true);
  });

  test("exports only reusable profile and instruction fields", () => {
    const exported = JSON.parse(
      serializeBotTemplate({
        name: "Research Bot",
        title: "research",
        description: "Finds primary sources.",
        instructions: "Cite every claim.",
        icon: "leaf",
        color: "#10b981",
        notificationsEnabled: true,
      })
    );

    expect(exported).toEqual({
      format: "openbot.bot-template",
      version: 1,
      bot: {
        name: "Research Bot",
        title: "research",
        description: "Finds primary sources.",
        instructions: "Cite every claim.",
        icon: "leaf",
        color: "#10b981",
        notificationsEnabled: true,
      },
    });
  });

  test("matches Grok's fixed conversational share request", () => {
    expect(BOT_TEMPLATE_REQUEST).toBe(
      "Create a template of yourself that I can share with somebody else."
    );
  });

  test("round-trips a shareable OpenBot deep link", () => {
    const bot = {
      name: "מחקר 🌱",
      title: "research",
      description: "Finds primary sources.",
      instructions: "Cite every claim.",
      icon: "leaf",
      color: "#10b981",
      notificationsEnabled: true,
    };
    const link = botTemplateShareUrl(bot);

    expect(link).toStartWith("grokbot://app/v1/template/add?data=");
    expect(parseBotTemplateShareUrl(link)).toEqual(bot);
    expect(parseBotTemplate(serializeBotTemplate(bot))).toEqual(bot);
    expect(parseBotTemplateShareUrl(link.replace("grokbot:", "https:"))).toBeNull();
  });
});
