import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

const componentSource = (name: string) =>
  readFile(new URL(`../src/renderer/components/openbot/${name}.tsx`, import.meta.url), "utf8");

describe("Grok bot-profile UI parity", () => {
  test("opens Bot settings from Grok's compact header identity control", async () => {
    const header = await componentSource("desktop-header");

    expect(header).toContain('aria-label="View conversation details"');
    expect(header).toMatch(
      /aria-label="View conversation details"[\s\S]*?<BotAvatar[\s\S]*?\{selected\.name\}/
    );
    expect(header).toMatch(/changeDetails\(true\);\s*onShowSettings\(\);/);
    expect(header).toContain("aria-label={selected.name}");
    expect(header).toContain("OpenBot's Computer");
    expect(header).toContain('aria-label="Back to details"');
    expect(header).toContain('aria-label="Close details"');
    expect(header).not.toContain("Back to bot details");
    expect(header).not.toContain("Hide details");
    expect(header).not.toContain("Rename chat");
    expect(header).not.toContain("<Pencil");
  });

  test("projects the optional label into the roster and autosaves silently", async () => {
    const [inspector, sidebar] = await Promise.all([
      componentSource("inspector"),
      componentSource("sidebar"),
    ]);

    expect(inspector).toContain("Label (optional)");
    expect(inspector).toContain('aria-label="Bot name"');
    expect(inspector).toContain('placeholder="Bob"');
    expect(inspector).toContain('aria-label="Bot label"');
    expect(inspector).toContain('aria-label="Bot description"');
    expect(inspector).toContain('aria-label="Notifications"');
    expect(inspector).toContain('aria-label="Computer preview"');
    expect(inspector).toContain('aria-label="Settings"');
    expect(inspector).not.toContain("Back to bot details");
    expect(inspector).not.toContain('saveState === "saved" ? "Saved"');
    expect(inspector).toContain("BotTemplateSettingsFooter");
    expect(inspector).toContain("onShareAsTemplate(bot)");
    expect(sidebar).toContain("{bot.title}");
    expect(sidebar).toContain("max-w-24 shrink-0 truncate rounded-[4px]");
  });

  test("matches Grok's details-pane and computer accessibility structure", async () => {
    const [app, main, avatar, screen, routines, sidebar] = await Promise.all([
      readFile(new URL("../src/renderer/App.tsx", import.meta.url), "utf8"),
      readFile(new URL("../src/main/index.ts", import.meta.url), "utf8"),
      componentSource("avatar-picker"),
      componentSource("bot-screen"),
      componentSource("routine-summary"),
      componentSource("sidebar"),
    ]);

    expect(app).toContain('aria-label="Conversation details"');
    expect(app).toContain('aria-label="Resize details"');
    expect(app).not.toContain('aria-label="Resize details sidebar"');
    expect(app).toContain("const DEFAULT_INSPECTOR_WIDTH = 320");
    expect(app).toContain("forcedCompact={forcedSidebarCompact}");
    expect(app).toContain("detailsOpen={visibleDetailsOpen}");
    expect(app).toContain("const renderedInspectorWidth = clampInspectorWidth(");
    expect(app).not.toContain(
      "setInspectorWidth((width) => clampInspectorWidth(width, viewportWidth, effectiveSidebarWidth))"
    );
    expect(sidebar).toContain("const compact = forcedCompact || storedCompact");
    expect(sidebar).toContain('forcedCompact && "!w-[88px]"');
    expect(sidebar).toContain('data-sidebar-forced-compact={forcedCompact ? "true" : "false"}');
    expect(sidebar).toContain('resizer.setAttribute("aria-valuenow", String(visibleWidth))');
    expect(main).toContain("minWidth: 512");
    expect(main).toContain("minHeight: 520");
    expect(avatar).toContain('aria-label="Edit Bot avatar"');
    expect(screen).toContain('aria-label="Open computer"');
    expect(screen).toContain("onPointerMove");
    expect(screen).toContain('action: "drag"');
    expect(routines).toContain('aria-label="Routines"');
    expect(routines).toContain('role="list"');
  });

  test("matches Grok's pinned-grid spacing and permits group channels", async () => {
    const sidebar = await componentSource("sidebar");

    expect(sidebar).toContain('channel?.kind === "bot_dm" || channel?.kind === "group"');
    expect(sidebar).toContain('className="col-start-1 row-start-1 pb-3 pt-2"');
    expect(sidebar).toContain(
      'className="grid w-full justify-center gap-x-2 gap-y-3 rounded-[12px] p-[6px]"'
    );
    expect(sidebar).toMatch(
      /gridTemplateColumns:\s*"repeat\(auto-fit, minmax\(80px, max-content\)\)"/
    );
    expect(sidebar).toContain('<ChannelAvatar botById={botById} channel={channel} size="lg" />');
    expect(sidebar.match(/aria-label="Toggle compact sidebar"/g)?.length).toBe(1);
    expect(sidebar).toContain("<PanelLeftClose");
    expect(sidebar).not.toContain("<PanelLeftOpen");
    expect(sidebar).toContain("toggleCompactSidebar");
    expect(sidebar).toContain(
      'className="electron-drag flex h-[61px] shrink-0 items-end justify-center pb-px"'
    );
    expect(sidebar).toContain('className="h-[0.5px] w-[54px] bg-[#dddddd] dark:bg-[#3a3a3a]"');
    expect(sidebar).toContain('data-compact-header-divider=""');
  });

  test("shows Grok's green presence dot on every working sidebar avatar", async () => {
    const sidebar = await componentSource("sidebar");

    expect(sidebar).toContain('data-working-indicator=""');
    expect(sidebar).toContain("bg-[#5bc67a]");
    expect(sidebar).toContain(
      "bottom-0.5 right-0.5 size-2 shadow-[0_0_0_2px_var(--working-dot-ring,var(--sidebar))]"
    );
    expect(sidebar).toContain(
      "bottom-0.5 right-0.5 size-2.5 shadow-[0_0_0_3.333px_var(--working-dot-ring,var(--sidebar))]"
    );
    expect(sidebar).not.toContain("working-presence-pulse");
    expect(sidebar.match(/active=\{working\}/g)?.length).toBe(4);
    expect(sidebar).toContain("active={working && !(needsAttention || unread)}");
  });

  test("shows Grok's blue unread badge on compact Bot and group avatars", async () => {
    const sidebar = await componentSource("sidebar");

    expect(sidebar).toMatch(
      /data-unread-indicator=\{\s*unread && !needsAttention \? "true" : undefined,?\s*\}/
    );
    expect(sidebar).toContain('needsAttention ? "bg-amber-500" : "bg-[#3062bf]"');
    expect(sidebar).toContain("bottom-[7px] right-[7px] z-20 size-2 rounded-full border-2");
    expect(sidebar).toContain('selected ? "border-selected" : "border-sidebar"');
    expect(sidebar).toContain("active={working && !(needsAttention || unread)}");
  });

  test("matches Grok's viewport-aware more-unreads navigator", async () => {
    const sidebar = await componentSource("sidebar");

    expect(sidebar).toContain("function UnreadJumpPill({");
    expect(sidebar).toContain('data-more-unreads="above"');
    expect(sidebar).not.toContain('data-more-unreads="below"');
    expect(sidebar).toContain("bg-[#2d63bb] py-1 pl-1 pr-2");
    expect(sidebar).toContain("transparent 0px, black 28px, black 100%");
    expect(sidebar).toContain("setSidebarTopFade(viewport.scrollTop > 5)");
    expect(sidebar).toContain("sidebarUnreadJumpTargets(metrics");
    expect(sidebar).toContain("viewport.scrollTo({ top });");
    expect(sidebar).toContain("virtualJumpHandlersRef.current.get(group)");
    expect(sidebar).toContain('scrollToIndex(index, { align: "center" })');
    expect(sidebar).toContain("VIRTUAL_SECTIONS_JUMP_KEY");
    expect(sidebar).not.toContain('viewport.querySelectorAll<HTMLElement>("[data-channel-id]")');
  });

  test("gives group chats Grok's pin, section, unread, and profile paths", async () => {
    const sidebar = await componentSource("sidebar");

    expect(sidebar).toContain("function GroupContextMenu({");
    expect(sidebar).toContain('if (channel.kind === "group")');
    expect(sidebar).toContain('onGroupAction(channel, "togglePin")');
    expect(sidebar).toContain('onGroupAction(channel, "toggleUnread")');
    expect(sidebar).toContain('onGroupAction(channel, "editProfile")');
    expect(sidebar).toContain('onGroupAction(channel, "copyConversationId")');
    expect(sidebar).toContain('onBotAction(bot, "shareAsTemplate")');
  });

  test("uses Grok's conversational template workflow instead of a clipboard export", async () => {
    const [chat, sharing] = await Promise.all([
      componentSource("chat-pane"),
      componentSource("bot-template-share"),
    ]);

    expect(chat).toContain('import("./bot-template-share")');
    expect(chat).toContain("BotTemplateConversationFlow");
    expect(chat).toContain("onSubmitPrompt={(content) => enqueueDurableSend(content, [])}");
    expect(sharing).toContain("BOT_TEMPLATE_REQUEST");
    expect(sharing).toContain("onSubmitPrompt(BOT_TEMPLATE_REQUEST)");
    expect(sharing).toContain("TemplateAudienceQuestion");
    expect(sharing).toContain("createBotTemplateDraft(bot, audience)");
    expect(sharing).toContain("BotTemplateCard");
    expect(sharing).toContain("Who should this template be for?");
    expect(sharing).toContain("Team stays inside your workspace");
    expect(sharing).toContain("People in your team can use it");
    expect(sharing).toContain("Anyone with the link can use it");
    expect(sharing).toContain("I’ll pull together a shareable template of this bot.");
    expect(sharing).toContain("View Details");
    expect(sharing).toContain("Publishing…");
    expect(sharing).toContain("Copy link");
    expect(sharing).toContain("View shared template");
  });

  test("matches Grok's context-menu move and pin states for bots and groups", async () => {
    const sidebar = await componentSource("sidebar");
    const moveMenu = sidebar.slice(
      sidebar.indexOf("function MoveMenu("),
      sidebar.indexOf("function BotContextMenu(")
    );
    const botMenu = sidebar.slice(
      sidebar.indexOf("function BotContextMenu("),
      sidebar.indexOf("function GroupContextMenu(")
    );
    const groupMenu = sidebar.slice(
      sidebar.indexOf("function GroupContextMenu("),
      sidebar.indexOf("const ChannelRow")
    );

    expect(moveMenu).toContain("Move to new section");
    expect(moveMenu).toContain("<ContextMenuSubTrigger>");
    expect(moveMenu).toContain("Move to");
    expect(moveMenu).toContain("New section");
    for (const menu of [botMenu, groupMenu]) {
      expect(menu).toContain("showMove = true");
      expect(menu.indexOf('"togglePin"')).toBeLessThan(menu.indexOf("<MoveMenu"));
      expect(menu).toContain("{showMove && (");
    }
    expect(sidebar.match(/showMove=\{false\}/g)?.length).toBe(2);
  });

  test("uses Grok's section spacing and motion constants", async () => {
    const [sidebar, styles] = await Promise.all([
      componentSource("sidebar"),
      readFile(new URL("../src/renderer/styles.css", import.meta.url), "utf8"),
    ]);

    expect(sidebar).toContain("gap-[10px]");
    expect(sidebar).toContain("duration-[120ms]");
    expect(sidebar).toContain("sidebar-collapsible-open_200ms_cubic-bezier(0.165,0.84,0.44,1)");
    expect(sidebar).toContain('easing: "cubic-bezier(0.25, 1.15, 0.4, 1)"');
    expect(sidebar).toContain("data-section-drop-edge={dropEdge}");
    expect(sidebar).toContain('className={cn("relative", isDragging && "opacity-40")}');
    expect(sidebar).toContain("deleteDialogTarget?.name");
    expect(styles).toContain("transform: translateY(-1px)");
  });
});
