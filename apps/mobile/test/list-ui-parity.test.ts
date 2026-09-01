import { describe, expect, test } from "bun:test";

const source = (path: string) => Bun.file(new URL(`../${path}`, import.meta.url)).text();

describe("mobile virtual-list UI parity", () => {
  test("new conversation keeps creation controls and six-member behavior", async () => {
    const route = await source("app/new.tsx");

    expect(route).toContain("<FlatList");
    expect(route).not.toContain("ScrollView");
    expect(route).not.toContain("availableBots.map");
    expect(route).toContain("availableBots.length > BOT_ROSTER_SEARCH_THRESHOLD");
    expect(route).toContain("toggleBoundedSelection(current, botId, { max: GROUP_MEMBER_LIMIT })");
    expect(route).toContain("{selectedBotIds.length}/{GROUP_MEMBER_LIMIT}");
    expect(route).toContain("minHeight: 58");
    expect(route).toContain("size={38}");
    expect(route).toContain('accessibilityRole="checkbox"');
    expect(route).toContain('placeholder={mode === "bot" ? "Research Bot" : "Launch team"}');
    expect(route).toContain("await createGroup(name, selectedBotIds)");
    expect(route).toContain('router.replace({ pathname: "/chat/[channelId]"');
    expect(route).toContain(
      'mode === "group" && availableBots.length > BOT_ROSTER_SEARCH_THRESHOLD'
    );
    expect(route).toContain("ListFooterComponent={showStickyCreateAction ? null : footer}");
    expect(route).toContain("{showStickyCreateAction ? (");
    expect(route).toContain("styles.actionSurface");
    expect(route).toContain("style={styles.list}");
  });

  test("details keeps native Bot parity, routine controls, member rules, and destructive action", async () => {
    const [route, profile, routineDetail] = await Promise.all([
      source("app/details/[channelId].tsx"),
      source("src/components/bot-profile-screen.tsx"),
      source("app/routine/[channelId]/[routineId].tsx"),
    ]);

    expect(route.match(/<FlatList/g)).toHaveLength(1);
    expect(profile.match(/<FlatList/g)).toHaveLength(1);
    expect(routineDetail.match(/<FlatList/g)).toHaveLength(1);
    expect(route).not.toContain("ScrollView");
    expect(profile).not.toContain("ScrollView");
    expect(route).not.toContain("availableBots.map");
    expect(route).toContain(
      "toggleBoundedSelection(current, candidateId, { min: 1, max: GROUP_MEMBER_LIMIT })"
    );
    expect(route).toContain("{memberIds.length}/{GROUP_MEMBER_LIMIT}");
    expect(route).toContain("minHeight: 58");
    expect(route).toContain("minHeight: 78");
    expect(route).toContain("setRoutineEnabled(routine, enabled)");
    expect(route).toContain("RoutineEditorSheet");
    expect(routineDetail).toContain("RoutineEditorSheet");
    expect(route).toContain("<FlatList<GroupDetailRow>");
    expect(route).toContain("data={groupDetailRows}");
    expect(route).toContain('kind: "routine"');
    expect(route).not.toContain("? botRoutines.map((routine, index) => (");
    expect(route).toContain("accessibilityLabel={label}");
    expect(route).toContain('accessibilityLabel="Create group routine"');
    expect(route).toContain("Delete Bot");
    expect(route).toContain("Turn Off Notifications");
    expect(route).toContain("New Routine");
    expect(profile).toContain("BOT_AVATAR_SHAPES.map");
    expect(profile).toContain("Reset to default");
    expect(profile).toContain("How this Bot&apos;s mark looks everywhere");
    expect(profile).toContain("routineSummary(routine)");
    expect(routineDetail).toContain("describeRoutineSchedule(routine.schedule)");
    expect(routineDetail).toContain("setRoutineEnabled(previous, enabled)");
    expect(routineDetail).toContain("routineExecutionStatus(execution.status)");
    expect(route).toContain("Save changes");
    expect(route).toContain("!bot && availableBots.length > BOT_ROSTER_SEARCH_THRESHOLD");
    expect(route).toContain("ListFooterComponent={showStickySaveAction ? null : footer}");
    expect(route).toContain("{showStickySaveAction ? (");
    expect(route).toContain("styles.actionSurface");
    expect(route.match(/style=\{styles\.list\}/g)).toHaveLength(1);
    expect(profile.match(/style=\{styles\.list\}/g)).toHaveLength(1);
  });

  test("settings keeps every alert, hidden action, appearance, and account control", async () => {
    const [route, home] = await Promise.all([
      source("app/settings.tsx"),
      source("src/components/settings-home.tsx"),
    ]);

    expect(route).toContain("<SectionList");
    expect(route).not.toContain("ScrollView");
    expect(route).not.toContain("hiddenBots.map");
    expect(route).toContain("totalBotCount > BOT_ROSTER_SEARCH_THRESHOLD");
    expect(route).toContain("setBotNotifications(botId, enabled)");
    expect(route).toContain("setBotHidden(botId, false)");
    expect(route).toContain("Still active while hidden");
    expect(route).toContain("Finishes and approval requests");
    expect(route).toContain("stickySectionHeadersEnabled={false}");
    expect(route).toContain("Save connection");
    expect(route).toContain("SERVER ENDPOINT");
    expect(route).toContain("this device’s secure storage");
    expect(route).toContain("Sign Out");
    expect(route).toContain("PluginManagerSheet");
    expect(route).toContain("Manage plugins");
    expect(route).toContain("AppearanceSheet");
    expect(route).toContain('accessibilityLabel="Appearance"');
    expect(route).not.toContain("this iPhone");
    expect(route).toContain("<SettingsHome");
    expect(route).toContain("authenticatedUserForServer(connection.serverUrl)");
    expect(home).toContain('title="Usage"');
    expect(home).toContain('title="Plugins"');
    expect(home).toContain('title="Notifications"');
    expect(home).toContain('title="Appearance"');
    expect(home).toContain('title="Send Feedback"');
  });

  test("login exposes the self-hosted endpoint in the shared mobile auth gate", async () => {
    const authGate = await source("src/components/auth-gate.tsx");

    expect(authGate).toContain("SERVER ENDPOINT");
    expect(authGate).toContain('accessibilityLabel="Server endpoint"');
    expect(authGate).toContain("Use HTTPS except for trusted local");
    expect(authGate).toContain("development.");
    expect(authGate).toContain("saveServerConnection({ serverUrl })");
    expect(authGate).toContain("authenticateConnection(connection.serverUrl, username, password)");
    expect(authGate).toContain("automaticallyAdjustKeyboardInsets");
    expect(authGate).toContain('keyboardDismissMode="interactive"');
    expect(authGate).toContain('stage === "credentials" && styles.credentialsHero');
    expect(authGate).toContain(
      'stage === "credentials" && keyboardVisible && styles.keyboardHiddenHero'
    );
    expect(authGate).toContain(
      'accessibilityElementsHidden={stage === "credentials" && keyboardVisible}'
    );
    expect(authGate).toContain('hasCompleteCredentials\n                        ? "Sign In"');
    expect(authGate).toContain(': "Connect"');
    expect(authGate).toContain("onChangeText={updateServerUrl}");
    expect(authGate).toContain("onChangeText={updateUsername}");
    expect(authGate).toContain("onChangeText={updatePassword}");
    expect(authGate).not.toContain("autoFocus={!serverUrl}");
    expect(authGate).not.toContain("editingServer");
  });

  test("home uses indexed pin lookup, stable rows, and a singleton formatter", async () => {
    const route = await source("app/index.tsx");

    expect(route).toContain("selectPinnedRows(rows, pinnedIds)");
    expect(route).toContain("new Set(pinnedIds)");
    expect(route).not.toContain("rows.find");
    expect(route).not.toContain("pinnedIds.includes");
    expect(route.match(/new Intl.DateTimeFormat/g)).toHaveLength(1);
    expect(route).toContain("memo(function ChannelRow");
    expect(route).toContain("MOBILE_VIRTUAL_LIST_TUNING");
    expect(route).toContain("accessibilityState={{ busy: working }}");
    expect(route).toContain('row.hasApproval ? "Approval required" : null');
    expect(route).toContain("const unreadCount = row.channel.unreadCount ?? 0");
    expect(route).toContain('router.push({ pathname: "/chat/[channelId]"');
  });

  test("modal search dismisses into chat so child sheets do not dismiss the conversation", async () => {
    const route = await source("app/search.tsx");

    expect(route).toContain("router.dismissTo({");
    expect(route).not.toContain('router.replace({\n        pathname: "/chat/[channelId]"');
  });

  test("conversation history keeps native list windowing at scale", async () => {
    const route = await source("app/chat/[channelId].tsx");

    expect(route).toContain("<FlatList");
    expect(route).toContain("MOBILE_VIRTUAL_LIST_TUNING");
    expect(route).toContain("{...MOBILE_VIRTUAL_LIST_TUNING}");
    expect(route).toContain("maintainVisibleContentPosition");
    expect(route).toContain("onScrollToIndexFailed");
    expect(route).toContain("deriveThreads(messages)");
    expect(route).toContain("ThreadSheet");
    expect(route).toContain("threadReplyCount");
    expect(route).toContain("cancelRun(activeRun.id)");
    expect(route).toContain("RunActivitySheet");
    expect(route).toContain("snapshot.runItems.filter");
    expect(route).toContain("snapshot.subagents.filter");
    expect(route).toContain("collapseA2ATimeline(mainMessages");
    expect(route).toContain("A2AActivityRow");
    expect(route).toContain("A2AExchangeSheet");
    expect(route).toContain("setA2APeerId(peer.id)");
  });

  test("A2A exchanges collapse into a dedicated view-only native transcript", async () => {
    const sheet = await source("src/components/a2a-exchange-sheet.tsx");
    const bubble = await source("src/components/message-bubble.tsx");

    expect(sheet).toContain("View-only exchange");
    expect(sheet).toContain("a2aProjectionFor(item)");
    expect(sheet).toContain("alignRight={outgoing}");
    expect(sheet).toContain("hideA2ALabel");
    expect(sheet).toContain("readOnly");
    expect(sheet).not.toContain("<Composer");
    expect(sheet).not.toContain("onReact: (messageId");
    expect(sheet).not.toContain("onWidgetResponse: (messageId");
    expect(sheet).not.toContain("onSecretSubmit: (messageId");
    expect(sheet).not.toContain("onReact(item.id");
    expect(sheet).not.toContain("onWidgetResponse(item.id");
    expect(sheet).not.toContain("onSecretSubmit(item.id");
    expect(bubble).toContain("!readOnly ? (");
    expect(bubble).toContain("readOnly={readOnly}");
    expect(bubble).toContain("disabled={readOnly}");
    expect(bubble).toContain("speakerName ??");
    const richCard = await source("src/components/rich-message-card.tsx");
    expect(richCard).toContain("if (!value || pending || readOnly) return");
    expect(richCard).toContain("editable={!pending && !readOnly}");
    expect(richCard).toContain("disabled={!value.trim() || pending || readOnly}");
  });

  test("message rendering includes native Markdown, code, links, and thread controls", async () => {
    const bubble = await source("src/components/message-bubble.tsx");
    const markdown = await source("src/components/mobile-markdown.tsx");

    expect(bubble).toContain("messageNeedsMobileMarkdown");
    expect(bubble).toContain("<MobileMarkdown");
    expect(bubble).toContain("threadReplyCount");
    expect(bubble).toContain("{actionsOpen ? (");
    expect(bubble).toContain("styles.richActionTarget");
    expect(bubble).toContain('richMessageWrap: { width: "88%" }');
    expect(bubble).toContain("boundedMobileAccessibilitySummary(displayContent)");
    expect(bubble).toContain("hitSlop={6}");
    expect(markdown).toContain('block.type === "code"');
    expect(markdown).toContain('accessibilityRole="link"');
    expect(markdown).toContain("parseMobileMarkdown");
    expect(markdown).toContain("codeScroller: { flexGrow: 0 }");
  });

  test("the performance fixture seeds real Markdown line breaks", async () => {
    const seed = await source("../../scripts/performance/seed.sql");

    expect(seed).toContain("E'Synthetic rich response for renderer profiling.\\n\\n```ts");
    expect(seed).toContain("E';\\n```\\n\\n- alpha\\n- beta\\n- gamma'");
  });

  test("plugin management covers install, accounts, removal, and Bot access", async () => {
    const manager = await source("src/components/plugin-manager-sheet.tsx");

    expect(manager).toContain("installPlugin(plugin.key");
    expect(manager).toContain("uninstallPlugin(install.pluginKey)");
    expect(manager).toContain("authenticatePlugin(connection.id)");
    expect(manager).toContain("disconnectPlugin(connection.id)");
    expect(manager).toContain("planPluginSkillAccess(accessPluginKey, bot, enabled)");
    expect(manager).toContain(
      "planPluginConnectionGrant(accessPluginKey, bot, connection.id, enabled)"
    );
    expect(manager).toContain("executePluginAccessTransition(transition");
  });

  test("shared computer keeps frame failures visible without removing takeover controls", async () => {
    const route = await source("app/computer/[botId].tsx");

    expect(route).toContain("const [frameError, setFrameError]");
    expect(route).toContain(
      'onError={() => setFrameError("The latest computer frame could not be loaded")}'
    );
    expect(route).toContain("onLoad={() => setFrameError(null)}");
    expect(route).toContain("styles.frameErrorOverlay");
    expect(route).toContain('controlling ? "You have control"');
    expect(route).toContain('controlling ? "Return control" : "Take control"');
  });
});
