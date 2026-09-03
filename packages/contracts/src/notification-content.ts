const notificationMetadata = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

/** Cross-process PostgreSQL advisory lock protecting the final push authorization/send boundary. */
export const PUSH_DELIVERY_ADVISORY_LOCK = {
  namespace: 0x4f50424f,
  key: 0x54505553,
} as const;

export const normalizeNotificationText = (value: string): string =>
  value.replace(/\s+/g, " ").trim();

export const notificationGraphemes = (value: string): string[] => {
  const normalized = normalizeNotificationText(value);
  const Segmenter = (
    Intl as unknown as {
      Segmenter?: new (
        locale?: string,
        options?: { granularity: "grapheme" }
      ) => { segment: (input: string) => Iterable<{ segment: string }> };
    }
  ).Segmenter;
  return Segmenter
    ? [...new Segmenter(undefined, { granularity: "grapheme" }).segment(normalized)].map(
        (part) => part.segment
      )
    : Array.from(normalized);
};

export const truncateNotificationText = (value: string, limit = 140): string => {
  const graphemes = notificationGraphemes(value);
  return graphemes.length <= limit
    ? graphemes.join("")
    : `${graphemes.slice(0, Math.max(0, limit - 1)).join("")}…`;
};

export type AgentNotificationKind = "agent-needs-input" | "agent-done";

export interface AgentNotificationPresentation {
  title: string;
  body: string;
  sound: "default" | null;
  urgency: "critical" | "normal";
}

/** Shared presentation contract for native macOS and iOS notifications. */
const agentNotificationTypeCatalog = {
  "agent-needs-input": {
    title: (botName: string) => `${botName} needs you`,
    fallbackBody: "Waiting for your input.",
    sound: "default",
    urgency: "critical",
  },
  "agent-done": {
    title: (botName: string) => botName,
    fallbackBody: "Open OpenTeam to see what it did.",
    sound: null,
    urgency: "normal",
  },
} as const satisfies Record<
  AgentNotificationKind,
  {
    title: (botName: string) => string;
    fallbackBody: string;
    sound: "default" | null;
    urgency: "critical" | "normal";
  }
>;

export const isAgentNotificationKind = (value: unknown): value is AgentNotificationKind =>
  typeof value === "string" && value in agentNotificationTypeCatalog;

export const agentNotificationDeliveryPolicy = (
  kind: AgentNotificationKind
): Pick<AgentNotificationPresentation, "sound" | "urgency"> => {
  const definition = agentNotificationTypeCatalog[kind];
  return { sound: definition.sound, urgency: definition.urgency };
};

export const agentNotificationPresentation = (input: {
  kind: AgentNotificationKind;
  botName: string;
  body?: string | null;
}): AgentNotificationPresentation => {
  const definition = agentNotificationTypeCatalog[input.kind];
  const botName = normalizeNotificationText(input.botName) || "OpenTeam";
  return {
    title: definition.title(botName),
    body: truncateNotificationText(input.body?.trim() ? input.body : definition.fallbackBody),
    ...agentNotificationDeliveryPolicy(input.kind),
  };
};

export const notificationApprovalReason = (details: unknown): string => {
  const record = notificationMetadata(details);
  for (const key of ["reason", "message", "description", "command", "title"]) {
    if (typeof record[key] === "string" && record[key].trim()) {
      return truncateNotificationText(record[key]);
    }
  }
  return "Waiting for your input.";
};

export const notificationMessageInputReason = (message: {
  content?: string | null;
  metadata?: unknown;
}): string | null => {
  const metadata = notificationMetadata(message.metadata);
  const type = typeof metadata.type === "string" ? metadata.type : "";
  if (
    (type === "widget" &&
      (typeof metadata.respondedValue === "string" || metadata.widgetDismissed === true)) ||
    (["secret-request", "secret_request"].includes(type) && metadata.secretProvided === true)
  ) {
    return null;
  }
  if (
    ![
      "widget",
      "user_form",
      "secret-request",
      "secret_request",
      "permission_request",
      "approval_required",
    ].includes(type)
  ) {
    return null;
  }
  if (message.content?.trim()) return truncateNotificationText(message.content);
  if (type === "widget" || type === "user_form") return "Asked you to answer a question.";
  return "Waiting for your input.";
};

export const notificationMessagePreview = (message: {
  content?: string | null;
  metadata?: unknown;
}): string => {
  const metadata = notificationMetadata(message.metadata);
  const type = typeof metadata.type === "string" ? metadata.type : "";
  if (
    (type === "widget" &&
      (typeof metadata.respondedValue === "string" || metadata.widgetDismissed === true)) ||
    (["secret-request", "secret_request"].includes(type) && metadata.secretProvided === true)
  ) {
    return "Open OpenTeam to see what it did.";
  }
  if (message.content?.trim()) return truncateNotificationText(message.content);
  const attachments = Array.isArray(metadata.attachments) ? metadata.attachments : [];
  if (attachments.length > 0) {
    const imageCount = attachments.filter((attachment) => {
      const item = notificationMetadata(attachment);
      return item.kind === "image" || String(item.mimeType ?? "").startsWith("image/");
    }).length;
    if (imageCount === attachments.length) {
      return imageCount === 1 ? "Sent an image." : `Sent ${imageCount} images.`;
    }
    return attachments.length === 1 ? "Sent an attachment." : `Sent ${attachments.length} files.`;
  }
  if (["sent_link", "link"].includes(type)) return "Sent a link.";
  if (
    ["secret-request", "secret_request", "permission_request", "approval_required"].includes(type)
  ) {
    return "Waiting for your input.";
  }
  if (["email_draft", "slack_draft"].includes(type)) return "Prepared a draft for you.";
  if (type === "widget" || type === "user_form") return "Asked you to answer a question.";
  return "Open OpenTeam to see what it did.";
};
