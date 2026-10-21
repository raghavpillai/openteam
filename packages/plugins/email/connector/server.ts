import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { createToolValidator } from "@openteam/plugin-sdk/json-schema";
import { Mailbox, type Cursor, type SearchMode } from "./mailbox";
import { loadSettings, type MailSettings } from "./settings";

type Args = Record<string, any>;
type Schema = { type: "object"; properties: Record<string, any>; required?: string[] };
type Context = { mailbox: Mailbox; settings: MailSettings; accountId: string };
export type Tool = {
  name: string;
  description: string;
  inputSchema: Schema;
  annotations: { readOnlyHint: boolean; destructiveHint: boolean };
  _meta?: Record<string, unknown>;
  run: (context: Context, args: Args) => Promise<unknown>;
};

/** Matches the server's HOST_ONLY_TOOL_META: OpenTeam calls the tool, Bots never see it. */
const HOST_ONLY = { "openteam/hostOnly": true };

const read = (
  definition: Pick<Tool, "name" | "description" | "inputSchema">,
  run: Tool["run"]
): Tool => ({
  ...definition,
  annotations: { readOnlyHint: true, destructiveHint: false },
  run,
});

const listEmailInboxes = (accountId: string) => ({
  name: "ListEmailInboxes",
  description:
    "List the email addresses you own. These are the inboxes you can search with SearchEmailThreads and draft from with DraftExternalMessage (providerIdentifier " +
    accountId +
    ").\nRead-only, takes no parameters. Call it when you need to know your own address, or before scoping a search to one inbox.",
  inputSchema: { type: "object", properties: {} } as Schema,
});

const searchEmailThreads = {
  name: "SearchEmailThreads",
  description:
    'Search the email in your inboxes and get back matching conversation threads, newest activity and best match first.\nEach thread lists its id, subject, participants, message count, and up to two matching messages with a snippet. To read a whole conversation, call ReadEmailThread with the thread id. Search first; do not guess thread ids.\nUse mode "keyword" for an exact phrase, address or identifier; leave it on "hybrid" otherwise.',
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        minLength: 1,
        maxLength: 1000,
        description:
          "What to look for: a topic, a phrase, a name or an address. Matched against subjects and bodies.",
      },
      inbox_email: {
        type: "string",
        description:
          "Search only this inbox. Must be one of your own addresses (see ListEmailInboxes); omit to search all of them.",
      },
      from_address: {
        type: "string",
        description: "Only messages sent from this exact address.",
      },
      after: {
        type: "string",
        description:
          "Only messages after this time, an ISO 8601 timestamp such as 2026-09-01T00:00:00Z.",
      },
      before: {
        type: "string",
        description:
          "Only messages before this time, an ISO 8601 timestamp such as 2026-09-01T00:00:00Z.",
      },
      limit: {
        type: "integer",
        minimum: 1,
        maximum: 25,
        description: "Maximum threads to return (default 10, max 25).",
      },
      mode: {
        type: "string",
        enum: ["hybrid", "keyword", "semantic"],
        description:
          '"hybrid" (default) ranks messages with every word above those with some, and suits most questions. "keyword" is exact-term matching: use it for a quoted phrase, an email address, an order or ticket number. "semantic" works like "hybrid" here: this mailbox has no meaning index.',
      },
    },
    required: ["query"],
  },
} as Pick<Tool, "name" | "description" | "inputSchema">;

const readEmailThread = {
  name: "ReadEmailThread",
  description:
    "Read one email conversation in full, oldest message first, by the thread_id that SearchEmailThreads returned. Do not invent thread ids.\nEach message shows who sent it, to whom, when, its delivery state, its body, and its stored attachments with the attachment_id to open each one. An image pasted into the body is listed as an inline attachment.",
  inputSchema: {
    type: "object",
    properties: {
      thread_id: {
        type: "string",
        minLength: 1,
        maxLength: 64,
        description: "A thread_id returned by SearchEmailThreads.",
      },
      max_messages: {
        type: "integer",
        minimum: 1,
        maximum: 50,
        description:
          "Most recent messages to include (default 20, max 50). Older ones are counted, not shown.",
      },
      body_max_chars: {
        type: "integer",
        minimum: 1,
        maximum: 50000,
        description:
          "Per-message body cap in characters (default 4000). Raise it only when a long message was cut off.",
      },
    },
    required: ["thread_id"],
  },
} as Pick<Tool, "name" | "description" | "inputSchema">;

const readEmailAttachment = {
  name: "ReadEmailAttachment",
  description:
    "Open one email attachment by the attachment_id that ReadEmailThread listed. Do not invent attachment ids.\nText-like attachments (plain text, CSV, JSON, calendar files) come back as text, cut off at 32 KB.\nAnything else (PDFs, images, spreadsheets, archives) is saved into an attachments folder on your computer and the result gives you its path; read it there with the Read tool or Shell, or attach it to a message by that path.\nImages pasted into a message body are listed as inline attachments and open the same way.\nAn attachment marked skipped was too large to store and cannot be opened.",
  inputSchema: {
    type: "object",
    properties: {
      attachment_id: {
        type: "string",
        minLength: 1,
        maxLength: 32,
        description: "An attachment_id listed by ReadEmailThread.",
      },
    },
    required: ["attachment_id"],
  },
} as Pick<Tool, "name" | "description" | "inputSchema">;

/**
 * Arguments that fall back to their default when out of range, like the reference's
 * `.catch(undefined)`, instead of failing the whole call.
 */
const DEFAULTED_WHEN_INVALID: Record<string, string[]> = {
  SearchEmailThreads: ["limit", "mode"],
  ReadEmailThread: ["max_messages", "body_max_chars"],
};
export function defaultInvalidArguments(tool: Pick<Tool, "name" | "inputSchema">) {
  const checks = (DEFAULTED_WHEN_INVALID[tool.name] ?? []).map((key) => ({
    key,
    valid: createToolValidator({ type: "object", properties: { [key]: tool.inputSchema.properties[key] } }),
  }));
  return (args: Args): Args => {
    const kept = { ...args };
    for (const { key, valid } of checks)
      if (key in kept && !valid({ [key]: kept[key] }).valid) delete kept[key];
    return kept;
  };
}

export const tools = (accountId: string): Tool[] => [
  read(listEmailInboxes(accountId), async ({ mailbox }) => mailbox.listInboxes()),
  read(searchEmailThreads, async ({ mailbox }, args) =>
    mailbox.search({ ...args, query: args.query, mode: args.mode as SearchMode })
  ),
  read(readEmailThread, async ({ mailbox }, args) =>
    mailbox.readThread(args.thread_id, args.max_messages, args.body_max_chars)
  ),
  read(readEmailAttachment, async ({ mailbox }, args) =>
    mailbox.readAttachment(args.attachment_id)
  ),
  {
    name: "send_reviewed_email",
    description:
      "OpenTeam calls this to verify a DraftExternalMessage card and, after the user presses Send, to send it.",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["verify", "send"],
          description: "verify checks the route; send delivers it",
        },
        draft: {
          type: "object",
          description: "The reviewed draft",
          properties: {
            from: { type: "string" },
            to: { type: "array", items: { type: "string" } },
            cc: { type: "array", items: { type: "string" } },
            subject: { type: "string" },
            body: { type: "string" },
            html: { type: "string" },
            replyToMessageId: { type: "string" },
          },
          required: ["from", "to", "subject", "body"],
          additionalProperties: false,
        },
      },
      required: ["action", "draft"],
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
    _meta: HOST_ONLY,
    run: async ({ mailbox, settings }, args) => {
      const draft = args.draft;
      if (String(draft.from).toLowerCase() !== settings.address)
        throw new Error(
          `This draft is from ${draft.from}, but this account sends as ${settings.address}`
        );
      if (args.action === "verify") {
        if (draft.replyToMessageId) await mailbox.ensureMessage(draft.replyToMessageId);
        // The card shows the replied-to message as "message <id> in <inbox>".
        return {
          identity: settings.address,
          sendingAddresses: [settings.address],
          ...(draft.replyToMessageId
            ? { thread: `message ${draft.replyToMessageId} in ${settings.address}` }
            : {}),
        };
      }
      const sent = await mailbox.send({
        to: draft.to,
        cc: draft.cc,
        subject: draft.subject,
        text: draft.body,
        html: draft.html,
        inReplyTo: draft.replyToMessageId,
      });
      if (!sent.accepted.length) throw new Error("The mail server accepted none of the recipients");
      return sent;
    },
  },
  {
    name: "poll_new_mail",
    description: "OpenTeam calls this to collect new INBOX mail for email routine triggers.",
    inputSchema: {
      type: "object",
      properties: {
        cursor: { type: ["object", "null"], description: "Cursor from the previous poll" },
      },
    },
    annotations: { readOnlyHint: true, destructiveHint: false },
    _meta: HOST_ONLY,
    run: ({ mailbox }, args) => mailbox.poll((args.cursor ?? null) as Partial<Cursor> | null),
  },
];

export async function serveEmail(env: Record<string, string | undefined> = process.env) {
  const accountId = env.OPENTEAM_PLUGIN_ACCOUNT_ID ?? "this account's id from GetMcpServerStatus";
  const definitions = tools(accountId);
  let ready: Promise<{ settings: MailSettings; mailbox: Mailbox }> | undefined;
  const connect = () =>
    (ready ??= (async () => {
      const settings = await loadSettings(env);
      const mailbox = new Mailbox(settings);
      await mailbox.verify();
      return { settings, mailbox };
    })().catch((error) => {
      ready = undefined;
      throw error;
    }));
  const redact = (message: string) =>
    env.EMAIL_PASSWORD && env.EMAIL_PASSWORD.length >= 4
      ? message.replaceAll(env.EMAIL_PASSWORD, "[redacted]")
      : message;
  const entries = new Map(
    definitions.map((entry) => [
      entry.name,
      { entry, defaults: defaultInvalidArguments(entry), validate: createToolValidator(entry.inputSchema) },
    ])
  );
  const server = new Server(
    { name: "openteam-email", version: "2.0.0" },
    { capabilities: { tools: {} } }
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    // Connecting lists tools: sign in first so a wrong password shows up on the account.
    try {
      await connect();
    } catch (error) {
      throw new Error(redact(error instanceof Error ? error.message : String(error)));
    }
    return { tools: definitions.map(({ run, ...definition }) => definition) };
  });
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      const match = entries.get(request.params.name);
      if (!match) throw new Error("Unknown tool");
      const args = match.defaults(request.params.arguments ?? {});
      const result = match.validate(args);
      if (!result.valid) throw new Error(`Invalid tool arguments: ${result.errorMessage}`);
      const { settings, mailbox } = await connect();
      const value = await match.entry.run({ mailbox, settings, accountId }, args);
      // The Bot-facing email tools return plain text.
      return {
        content: [
          { type: "text", text: typeof value === "string" ? value : JSON.stringify(value) },
        ],
      };
    } catch (error) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: redact(error instanceof Error ? error.message : "Email tool failed"),
          },
        ],
      };
    }
  });
  await server.connect(new StdioServerTransport());
}

if (import.meta.main) await serveEmail();
