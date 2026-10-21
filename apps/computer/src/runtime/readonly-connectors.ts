// The connector tools a readonly worker may call, as the reference allows them: a tool its server declares
// read-only, or one of the reference's known reads for that connector.
const READONLY_CONNECTOR_READS: Record<string, readonly string[]> = {
  gmail: ["get_draft", "get_me", "get_message", "get_thread", "list_drafts", "list_labels", "read_email", "search", "search_emails", "search_threads"],
  slack: [
    "slack_get_reactions", "slack_list_channel_members", "slack_read_canvas", "slack_read_channel", "slack_read_file", "slack_read_thread",
    "slack_read_user_profile", "slack_search_channels", "slack_search_emojis", "slack_search_public", "slack_search_public_and_private", "slack_search_users",
  ],
  "google-calendar": ["check_availability", "get_event", "list-calendars", "list-events", "list_calendars", "list_event_instances", "list_events", "search_events", "suggest_time"],
  "icloud-calendar": ["free_busy", "get_event", "get_events", "icloud_get_events", "icloud_list_calendars", "list_calendars", "list_events", "search_events"],
  "outlook-calendar": [
    "get-calendar-event", "get-calendar-view", "get-specific-calendar-event", "get_calendar_event", "get_free_busy", "list-calendar-events",
    "list-calendars", "list-specific-calendar-events", "list_calendar_events", "list_calendars", "list_event_instances", "list_events",
  ],
  notion: [
    "notion-ai-search", "notion-fetch", "notion-get-async-task", "notion-get-comments", "notion-get-session-status", "notion-get-teams",
    "notion-get-users", "notion-list-favorite-pages", "notion-list-private-pages", "notion-list-recent-pages", "notion-list-session-events",
    "notion-list-shared-pages", "notion-query-data-sources", "notion-query-meeting-notes", "notion-query-multiple-data-sources",
    "notion-query-sessions", "notion-read-session-event", "notion-search", "notion-search-agents", "notion-search-sessions", "notion-search-skills",
  ],
  linear: [
    "get_attachment", "get_initiative", "get_issue", "get_milestone", "get_project", "get_status_updates", "list_comments", "list_cycles",
    "list_initiatives", "list_issue_labels", "list_issue_statuses", "list_issues", "list_milestones", "list_projects", "list_teams",
  ],
};
const CONNECTOR_ALIASES: Record<string, string> = {
  gmail: "gmail", slack: "slack", notion: "notion", linear: "linear",
  calendar: "google-calendar", gcal: "google-calendar", "google-calendar": "google-calendar",
  icloud: "icloud-calendar", "icloud-calendar": "icloud-calendar", "icloud-caldav": "icloud-calendar", "apple-calendar": "icloud-calendar",
  outlook: "outlook-calendar", "outlook-calendar": "outlook-calendar", ms365: "outlook-calendar", "ms365-calendar": "outlook-calendar",
  "microsoft-365": "outlook-calendar", microsoft365: "outlook-calendar",
};

/** A connector tool a readonly worker may call; source is "<plugin>/<connector>". */
export const isReadonlyConnectorRead = (tool: { source: string; name: string; readOnly?: boolean }): boolean => {
  if (tool.readOnly === true) return true;
  const connector = CONNECTOR_ALIASES[tool.source.split("/")[0]!.trim().toLowerCase().replace(/[\s_]+/g, "-")];
  return connector !== undefined && READONLY_CONNECTOR_READS[connector]!.includes(tool.name);
};
