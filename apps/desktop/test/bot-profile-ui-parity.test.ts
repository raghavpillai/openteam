import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

const componentSource = (name: string) =>
  readFile(new URL(`../src/renderer/components/openbot/${name}.tsx`, import.meta.url), "utf8");

describe("Grok bot-profile UI parity", () => {
  test("projects the optional label into the roster and autosaves silently", async () => {
    const [inspector, sidebar] = await Promise.all([
      componentSource("inspector"),
      componentSource("sidebar"),
    ]);

    expect(inspector).toContain("Label (optional)");
    expect(inspector).not.toContain('saveState === "saved" ? "Saved"');
    expect(inspector).toContain("BotTemplateSettingsFooter");
    expect(inspector).toContain("onShareAsTemplate(bot)");
    expect(sidebar).toContain("{bot.title}");
    expect(sidebar).toContain("max-w-24 shrink-0 truncate rounded-[4px]");
  });

  test("matches Grok's pinned-grid spacing and permits group channels", async () => {
    const sidebar = await componentSource("sidebar");

    expect(sidebar).toContain('channel?.kind === "bot_dm" || channel?.kind === "group"');
    expect(sidebar).toContain('className="col-start-1 row-start-1 pb-3 pt-2"');
    expect(sidebar).toContain(
      'className="grid w-full justify-center gap-x-2 gap-y-3 rounded-[12px] p-[6px]"'
    );
    expect(sidebar).toContain('gridTemplateColumns: "repeat(auto-fit, minmax(80px, max-content))"');
    expect(sidebar).toContain('<ChannelAvatar botById={botById} channel={channel} size="lg" />');
    expect(sidebar.match(/aria-label="Toggle compact sidebar"/g)?.length).toBe(1);
    expect(sidebar).toContain("<PanelLeftClose");
    expect(sidebar).not.toContain("<PanelLeftOpen");
    expect(sidebar).toContain("toggleCompactSidebar");
    expect(sidebar).toContain(
      'className="electron-drag flex h-[61px] shrink-0 items-end justify-center pb-px"'
    );
    expect(sidebar).toContain(
      'className="h-[0.5px] w-[54px] bg-[#dddddd] dark:bg-[#3a3a3a]"'
    );
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

    expect(sidebar).toContain('data-unread-indicator={unread && !needsAttention ? "true" : undefined}');
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

    expect(chat).toContain("BOT_TEMPLATE_REQUEST");
    expect(chat).toContain("TemplateAudienceQuestion");
    expect(chat).toContain("createBotTemplateDraft(selectedBot, audience)");
    expect(chat).toContain("BotTemplateCard");
    expect(sharing).toContain("Who should this template be for?");
    expect(sharing).toContain("Team templates can keep internal workflow details");
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
