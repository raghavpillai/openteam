import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

const componentSource = (name: string) =>
  readFile(new URL(`../src/renderer/components/openteam/${name}.tsx`, import.meta.url), "utf8");

describe("Grok group lifecycle UI parity", () => {
  test("matches the shipped group sidebar lifecycle menu", async () => {
    const sidebar = await componentSource("sidebar");
    const menu = sidebar.slice(
      sidebar.indexOf("function GroupContextMenu("),
      sidebar.indexOf("const ChannelRow")
    );

    for (const label of [
      "Pin",
      "Mark as Unread",
      "Edit Profile",
      "Copy conversation ID",
      "Hide from sidebar",
      "Delete",
    ]) {
      expect(menu).toContain(label);
    }
    expect(menu).toContain("<MoveMenu");
    expect(menu).not.toContain("Duplicate");
    expect(menu).not.toContain("Share as template");
    expect(menu.indexOf("Hide from sidebar")).toBeLessThan(menu.indexOf("> Delete"));
  });

  test("uses Grok's inline append/remove member interaction", async () => {
    const inspector = await componentSource("inspector");

    expect(inspector).toContain('className="sand-group-members-section"');
    expect(inspector).toContain("sand-group-member-open");
    expect(inspector).toContain("sand-group-member-name");
    expect(inspector).toContain("sand-group-member-add");
    expect(inspector).toContain("Add Member");
    expect(inspector).toContain("members.length >= 6");
    expect(inspector).toContain("members.length <= 1");
    expect(inspector).toContain("[...memberIds, candidate.id]");
    expect(inspector).toContain("Remove {removeMemberTarget?.name} from this conversation?");
    expect(inspector).toContain('memberMutationPending ? "Removing..." : "Remove"');
    expect(inspector).toContain("Removing failed. Check your connection and try again.");
    expect(inspector).not.toContain("Edit members");
    expect(inspector).not.toContain("Save members");
    expect(inspector).not.toContain("Search bots");
    expect(inspector).not.toContain("Shared project");
    expect(inspector).not.toContain("Round {latestRound.roundIndex + 1} of 3");
  });

  test("matches Grok's hidden-agent recovery and group deletion copy", async () => {
    const [app, sidebar, dialogs] = await Promise.all([
      readFile(new URL("../src/renderer/App.tsx", import.meta.url), "utf8"),
      componentSource("sidebar"),
      componentSource("desktop-dialogs"),
    ]);

    expect(sidebar).toContain("Hidden Bots ({hiddenAgentCount})");
    expect(sidebar).toContain("All bots are hidden");
    expect(sidebar).toContain("Show Hidden Bots");
    expect(sidebar).toContain('aria-label="Sidebar actions"');
    expect(sidebar).toContain("Hidden Bots stay active and keep their history");
    expect(sidebar).toContain("No hidden bots");
    expect(sidebar).toContain("Unhide");
    expect(app).toContain('title: "Open Hidden Bots"');
    expect(app).toContain("api.setChannelHidden(channel.id, false)");
    expect(dialogs).toContain("This permanently deletes the group and its chat history.");
    expect(dialogs).toContain("The Bots in it are not");
    expect(dialogs).toContain("deleted and remain available individually. This can't be undone.");
  });
});
