import type {
  ChannelMessageView,
  RichMessageCloudAgent,
  RichMessageComputerHandoff,
  RichMessageComputerHandoffState,
  RichMessageSecretRequest,
  RichMessageWidget,
  RichMessageWidgetOption,
} from "@openbot/contracts";

export type RichMessageMetadata = Record<string, unknown>;

export const richMessageMetadata = (value: unknown): RichMessageMetadata =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as RichMessageMetadata) : {};

export const parseRichMessageWidget = (value: unknown): RichMessageWidget | null => {
  const candidate = richMessageMetadata(value);
  const options = Array.isArray(candidate.options)
    ? candidate.options.flatMap((option) => {
        const item = richMessageMetadata(option);
        if (typeof item.label !== "string") return [];
        const style =
          item.style === "default" || item.style === "primary" || item.style === "danger"
            ? item.style
            : undefined;
        return [
          {
            label: item.label,
            ...(typeof item.value === "string" ? { value: item.value } : {}),
            ...(typeof item.description === "string" ? { description: item.description } : {}),
            ...(style ? { style } : {}),
          } satisfies RichMessageWidgetOption,
        ];
      })
    : [];
  return typeof candidate.prompt === "string" && options.length > 0
    ? {
        prompt: candidate.prompt,
        options,
        ...(typeof candidate.helpText === "string" ? { helpText: candidate.helpText } : {}),
        ...(candidate.multiSelect === true ? { multiSelect: true } : {}),
        ...(candidate.allowCustom === true ? { allowCustom: true } : {}),
        ...(candidate.dismissOnMoveOn === true ? { dismissOnMoveOn: true } : {}),
      }
    : null;
};

export const parseRichMessageSecretRequest = (value: unknown): RichMessageSecretRequest | null => {
  const candidate = richMessageMetadata(value);
  return typeof candidate.label === "string" &&
    typeof candidate.connector === "string" &&
    typeof candidate.field === "string"
    ? {
        label: candidate.label,
        connector: candidate.connector,
        field: candidate.field,
        ...(typeof candidate.description === "string"
          ? { description: candidate.description }
          : {}),
      }
    : null;
};

export const parseRichMessageCloudAgent = (value: unknown): RichMessageCloudAgent | null => {
  const candidate = richMessageMetadata(value);
  const nested = richMessageMetadata(
    candidate.bot ?? candidate.agent ?? candidate.cloudAgent ?? candidate.template ?? candidate
  );
  const name = typeof nested.name === "string" ? nested.name.trim() : "";
  if (!name) return null;
  const statusSource = candidate.status ?? nested.status;
  const published = statusSource === "published" || candidate.published === true;
  const stringField = (key: string) =>
    typeof nested[key] === "string" && nested[key] ? (nested[key] as string) : undefined;
  return {
    ...(typeof candidate.id === "string" ? { id: candidate.id } : {}),
    ...(typeof candidate.sourceBotId === "string" ? { sourceBotId: candidate.sourceBotId } : {}),
    name,
    ...(stringField("title") ? { title: stringField("title") } : {}),
    ...(stringField("description") ? { description: stringField("description") } : {}),
    ...(stringField("instructions") ? { instructions: stringField("instructions") } : {}),
    ...(stringField("icon") ? { icon: stringField("icon") } : {}),
    color: stringField("color") ?? "#925df2",
    status: published ? "published" : "draft",
  };
};

export const parseRichMessageComputerHandoff = (
  value: unknown
): RichMessageComputerHandoff | null => {
  const candidate = richMessageMetadata(value);
  const reason = typeof candidate.reason === "string" ? candidate.reason.trim() : "";
  return reason ? { reason } : null;
};

export const widgetOptionValue = (option: RichMessageWidgetOption): string =>
  option.value ?? option.label;

export const widgetOptionLetter = (index: number): string => String.fromCharCode(65 + index);

export const toggleWidgetSelection = (
  selected: ReadonlySet<string>,
  value: string
): ReadonlySet<string> => {
  const next = new Set(selected);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
};

export const widgetResponseValue = (
  widget: RichMessageWidget,
  selected: ReadonlySet<string>,
  custom: string
): string =>
  [
    ...widget.options.flatMap((option) =>
      selected.has(widgetOptionValue(option)) ? [widgetOptionValue(option)] : []
    ),
    ...(widget.allowCustom && custom.trim() ? [custom.trim()] : []),
  ].join("\n");

export interface ResolvedWidgetAnswer {
  value: string;
  label: string;
  optionIndex: number | null;
}

export const resolvedWidgetAnswers = (
  widget: RichMessageWidget,
  respondedValue: string
): ResolvedWidgetAnswer[] => {
  const known = new Map(
    widget.options.map((option, index) => [widgetOptionValue(option), { option, index }])
  );
  const values = widget.multiSelect ? respondedValue.split("\n") : [respondedValue];
  return values.filter(Boolean).map((value) => {
    const match = known.get(value);
    return {
      value,
      label: match?.option.label ?? value,
      optionIndex: match?.index ?? null,
    };
  });
};

export const secretRequestPlaceholder = (label: string): string =>
  `Paste ${/^(?:a|an|the|your|my)\s/i.test(label) ? label : `your ${label}`}`;

export type RichMessageProjection =
  | {
      kind: "widget";
      metadata: RichMessageMetadata;
      widget: RichMessageWidget;
      state: "active" | "responded" | "dismissed";
      respondedValue: string | null;
    }
  | {
      kind: "secret-request";
      metadata: RichMessageMetadata;
      request: RichMessageSecretRequest;
      provided: boolean;
    }
  | {
      kind: "cloud-agent";
      metadata: RichMessageMetadata;
      agent: RichMessageCloudAgent;
    }
  | {
      kind: "computer-handoff";
      metadata: RichMessageMetadata;
      handoff: RichMessageComputerHandoff;
      state: RichMessageComputerHandoffState;
    };

export const projectRichMessage = (
  message: Pick<ChannelMessageView, "metadata">
): RichMessageProjection | null => {
  const metadata = richMessageMetadata(message.metadata);
  if (metadata.type === "widget") {
    const widget = parseRichMessageWidget(metadata.widget);
    if (!widget) return null;
    const respondedValue =
      typeof metadata.respondedValue === "string" ? metadata.respondedValue : null;
    return {
      kind: "widget",
      metadata,
      widget,
      state:
        respondedValue !== null
          ? "responded"
          : metadata.widgetDismissed === true
            ? "dismissed"
            : "active",
      respondedValue,
    };
  }
  if (metadata.type === "secret-request") {
    const request = parseRichMessageSecretRequest(metadata.secretRequest ?? metadata.secret);
    return request
      ? {
          kind: "secret-request",
          metadata,
          request,
          provided: metadata.secretProvided === true,
        }
      : null;
  }
  if (metadata.type === "computer-handoff") {
    const handoff = parseRichMessageComputerHandoff(metadata.computerHandoff);
    if (!handoff) return null;
    const rawState = metadata.computerHandoffState;
    const state: RichMessageComputerHandoffState =
      rawState === "active" ||
      rawState === "completed" ||
      rawState === "skipped" ||
      rawState === "dismissed"
        ? rawState
        : "requested";
    return { kind: "computer-handoff", metadata, handoff, state };
  }
  if (
    metadata.type === "cloud-agent" ||
    metadata.type === "cloud_agent" ||
    metadata.type === "cloud-agent-card" ||
    metadata.type === "bot-template"
  ) {
    const agent = parseRichMessageCloudAgent(
      metadata.cloudAgent ?? metadata.agent ?? metadata.botTemplate ?? metadata.template ?? metadata
    );
    return agent ? { kind: "cloud-agent", metadata, agent } : null;
  }
  return null;
};
