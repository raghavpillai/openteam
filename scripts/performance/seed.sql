\set ON_ERROR_STOP on
\if :{?bot_count}
\else
\set bot_count 1000
\endif
\if :{?messages_per_bot}
\else
\set messages_per_bot 20
\endif
\if :{?group_count}
\else
\set group_count 100
\endif
\if :{?long_transcript_count}
\else
\set long_transcript_count 0
\endif
\if :{?ios_stress_fixture}
\else
\set ios_stress_fixture false
\endif

DO $guard$
BEGIN
  IF current_database() <> 'openteam_perf_audit' THEN
    RAISE EXCEPTION 'Refusing to seed unexpected database: %', current_database();
  END IF;
END
$guard$;

INSERT INTO "Bot" (
  "id", "name", "title", "description", "instructions", "icon", "color", "namedBy",
  "notificationsEnabled", "hiddenFromSidebar", "defaultDirectory", "status",
  "onboardingStatus", "onboardingCompletedAt", "createdAt", "updatedAt"
)
SELECT
  md5('perf-bot-' || bot_number)::uuid,
  'Audit Bot ' || lpad(bot_number::text, 4, '0'),
  'Performance fixture',
  'Synthetic bot created only inside the isolated performance-audit database.',
  '',
  CASE bot_number % 4 WHEN 0 THEN '●' WHEN 1 THEN '◆' WHEN 2 THEN '■' ELSE '▲' END,
  CASE bot_number % 6
    WHEN 0 THEN '#4f7cff' WHEN 1 THEN '#f97316' WHEN 2 THEN '#22c55e'
    WHEN 3 THEN '#a855f7' WHEN 4 THEN '#ef4444' ELSE '#06b6d4'
  END,
  'user',
  true,
  false,
  '/workspace/bots/audit-bot-' || bot_number,
  'active',
  'completed',
  now(),
  timestamp '2026-01-01 00:00:00' + bot_number * interval '1 second',
  timestamp '2026-01-01 00:00:00' + bot_number * interval '1 second'
FROM generate_series(1, :bot_count) AS bot_number
ON CONFLICT ("id") DO NOTHING;

INSERT INTO "Conversation" ("id", "botId", "continuity", "createdAt", "updatedAt")
SELECT
  md5('perf-conversation-' || bot_number)::uuid,
  md5('perf-bot-' || bot_number)::uuid,
  'attached',
  timestamp '2026-01-01 00:00:00' + bot_number * interval '1 second',
  timestamp '2026-01-01 00:00:00' + bot_number * interval '1 second'
FROM generate_series(1, :bot_count) AS bot_number
ON CONFLICT ("id") DO NOTHING;

INSERT INTO "Channel" (
  "id", "kind", "name", "directKey", "workingDirectory", "createdAt", "updatedAt"
)
SELECT
  md5('perf-channel-' || bot_number)::uuid,
  'bot_dm',
  'Audit Bot ' || lpad(bot_number::text, 4, '0'),
  'bot:' || md5('perf-bot-' || bot_number)::uuid,
  null,
  timestamp '2026-01-01 00:00:00' + bot_number * interval '1 second',
  timestamp '2026-01-01 00:00:00' + bot_number * interval '1 second'
FROM generate_series(1, :bot_count) AS bot_number
ON CONFLICT ("id") DO NOTHING;

INSERT INTO "ChannelMember" ("channelId", "botId", "ordinal", "createdAt")
SELECT
  md5('perf-channel-' || bot_number)::uuid,
  md5('perf-bot-' || bot_number)::uuid,
  0,
  timestamp '2026-01-01 00:00:00' + bot_number * interval '1 second'
FROM generate_series(1, :bot_count) AS bot_number
ON CONFLICT ("channelId", "botId") DO NOTHING;

INSERT INTO "ChannelMessage" (
  "id", "channelId", "sender", "senderBotId", "content", "metadata", "createdAt"
)
SELECT
  md5('perf-message-' || bot_number || '-' || message_number)::uuid,
  md5('perf-channel-' || bot_number)::uuid,
  CASE WHEN message_number % 2 = 0 THEN 'agent'::"ChannelMessageSender"
       ELSE 'user'::"ChannelMessageSender" END,
  CASE WHEN message_number % 2 = 0 THEN md5('perf-bot-' || bot_number)::uuid ELSE null END,
  CASE
    WHEN message_number % 20 = 0 THEN
      E'Synthetic rich response for renderer profiling.\n\n```ts\nconst sample = ' || message_number || E';\n```\n\n- alpha\n- beta\n- gamma'
    WHEN message_number % 17 = 0 THEN
      'Synthetic performance link https://openteam.dev/audit/' || bot_number || '/' || message_number
    ELSE
      'Synthetic performance message ' || message_number || ' for Audit Bot ' ||
      lpad(bot_number::text, 4, '0') || '. ' || repeat('Representative plain text payload. ', 4)
  END,
  CASE
    WHEN message_number % 19 = 0 THEN jsonb_build_object(
      'attachments',
      jsonb_build_array(jsonb_build_object(
        'assetId', md5('perf-asset-' || bot_number || '-' || message_number) ||
          md5('perf-asset-tail-' || bot_number || '-' || message_number),
        'fileName', 'audit-report-' || bot_number || '-' || message_number || '.pdf',
        'mimeType', 'application/pdf',
        'byteSize', 4096 + message_number,
        'kind', 'pdf',
        'alt', 'Synthetic performance audit report'
      ))
    )
    ELSE '{}'::jsonb
  END,
  timestamp '2026-01-01 00:00:00' + bot_number * interval '1 day' + message_number * interval '1 minute'
FROM generate_series(1, :bot_count) AS bot_number
CROSS JOIN generate_series(1, :messages_per_bot) AS message_number
ON CONFLICT ("id") DO UPDATE SET
  "content" = EXCLUDED."content",
  "metadata" = EXCLUDED."metadata"
WHERE "ChannelMessage"."content" IS DISTINCT FROM EXCLUDED."content"
   OR "ChannelMessage"."metadata" IS DISTINCT FROM EXCLUDED."metadata";

INSERT INTO "Channel" (
  "id", "kind", "name", "directKey", "workingDirectory", "createdAt", "updatedAt"
)
SELECT
  md5('perf-group-' || group_number)::uuid,
  'group',
  'Audit Group ' || lpad(group_number::text, 4, '0'),
  null,
  '/workspace/projects/audit-group-' || group_number,
  timestamp '2026-06-01 00:00:00' + group_number * interval '1 second',
  timestamp '2026-06-01 00:00:00' + group_number * interval '1 second'
FROM generate_series(1, :group_count) AS group_number
ON CONFLICT ("id") DO NOTHING;

INSERT INTO "ChannelMember" ("channelId", "botId", "ordinal", "createdAt")
SELECT
  md5('perf-group-' || group_number)::uuid,
  md5('perf-bot-' || (((group_number + member_offset - 2) % :bot_count) + 1))::uuid,
  member_offset - 1,
  timestamp '2026-06-01 00:00:00' + group_number * interval '1 second'
FROM generate_series(1, :group_count) AS group_number
CROSS JOIN generate_series(1, LEAST(5, :bot_count)) AS member_offset
ON CONFLICT ("channelId", "botId") DO NOTHING;

-- Exercise both bot-owned and group-owned routine search/visibility paths at
-- the same scale as the sidebar fixture.
INSERT INTO "Routine" (
  "id", "botId", "channelId", "slug", "name", "prompt", "trigger",
  "scheduleText", "scheduleKind", "intervalSeconds", "timezone", "createdAt", "updatedAt"
)
SELECT
  md5('perf-bot-routine-' || bot_number)::uuid,
  md5('perf-bot-' || bot_number)::uuid,
  null,
  'audit-bot-routine-' || bot_number,
  'Audit Bot Routine ' || lpad(bot_number::text, 4, '0'),
  'Prepare a bounded synthetic performance report for bot ' || bot_number,
  '{"kind":"schedule"}'::jsonb,
  'Every hour',
  'interval'::"RoutineScheduleKind",
  3600,
  'UTC',
  timestamp '2026-06-02 00:00:00' + bot_number * interval '1 second',
  timestamp '2026-06-02 00:00:00' + bot_number * interval '1 second'
FROM generate_series(1, :bot_count) AS bot_number
ON CONFLICT ("id") DO NOTHING;

INSERT INTO "Routine" (
  "id", "botId", "channelId", "slug", "name", "prompt", "trigger",
  "scheduleText", "scheduleKind", "intervalSeconds", "timezone", "createdAt", "updatedAt"
)
SELECT
  md5('perf-group-routine-' || group_number)::uuid,
  null,
  md5('perf-group-' || group_number)::uuid,
  'audit-group-routine-' || group_number,
  'Audit Group Routine ' || lpad(group_number::text, 4, '0'),
  'Summarize synthetic group performance for channel ' || group_number,
  '{"kind":"schedule"}'::jsonb,
  'Every two hours',
  'interval'::"RoutineScheduleKind",
  7200,
  'UTC',
  timestamp '2026-06-03 00:00:00' + group_number * interval '1 second',
  timestamp '2026-06-03 00:00:00' + group_number * interval '1 second'
FROM generate_series(1, :group_count) AS group_number
ON CONFLICT ("id") DO NOTHING;

INSERT INTO "ChannelMessage" (
  "id", "channelId", "sender", "senderBotId", "content", "metadata", "createdAt"
)
SELECT
  md5('perf-group-message-' || group_number || '-' || message_number)::uuid,
  md5('perf-group-' || group_number)::uuid,
  CASE WHEN message_number % 3 = 0 THEN 'user'::"ChannelMessageSender"
       ELSE 'agent'::"ChannelMessageSender" END,
  CASE WHEN message_number % 3 = 0 THEN null
       ELSE md5('perf-bot-' || (((group_number + message_number - 2) % :bot_count) + 1))::uuid END,
  'Synthetic group message ' || message_number || ' in Audit Group ' || lpad(group_number::text, 4, '0') ||
    '. ' || repeat('Shared-room payload. ', 3),
  '{}'::jsonb,
  timestamp '2026-06-01 00:00:00' + group_number * interval '1 day' + message_number * interval '1 minute'
FROM generate_series(1, :group_count) AS group_number
CROSS JOIN generate_series(1, :messages_per_bot) AS message_number
ON CONFLICT ("id") DO NOTHING;

INSERT INTO "ChannelMessage" (
  "id", "channelId", "sender", "senderBotId", "content", "metadata", "createdAt"
)
SELECT
  md5('perf-long-message-' || message_number)::uuid,
  md5('perf-channel-1')::uuid,
  CASE WHEN message_number % 2 = 0 THEN 'agent'::"ChannelMessageSender"
       ELSE 'user'::"ChannelMessageSender" END,
  CASE WHEN message_number % 2 = 0 THEN md5('perf-bot-1')::uuid ELSE null END,
  CASE
    WHEN message_number % 25 = 0 THEN
      'Long-transcript Markdown fixture ' || message_number || '.\n\n> Quoted diagnostic text\n\n`inline code` and **emphasis**.'
    ELSE
      'Long transcript fixture ' || message_number || '. ' || repeat('This row exercises React and DOM scaling. ', 3)
  END,
  '{}'::jsonb,
  timestamp '2026-12-01 00:00:00' + message_number * interval '1 second'
FROM generate_series(1, :long_transcript_count) AS message_number
ON CONFLICT ("id") DO NOTHING;

-- A small, stable feature gallery keeps lazy-boundary and visual-parity checks independent
-- of the selected scale point. Audit Bot 0002 is the gallery channel.
INSERT INTO "ChannelMessage" (
  "id", "channelId", "sender", "senderBotId", "content", "metadata", "createdAt"
)
VALUES
  (
    md5('perf-gallery-plain')::uuid,
    md5('perf-channel-2')::uuid,
    'agent'::"ChannelMessageSender",
    md5('perf-bot-2')::uuid,
    'Feature gallery: plain text remains on the fast rendering path.',
    '{}'::jsonb,
    timestamp '2027-01-01 00:00:01'
  ),
  (
    md5('perf-gallery-markdown')::uuid,
    md5('perf-channel-2')::uuid,
    'agent'::"ChannelMessageSender",
    md5('perf-bot-2')::uuid,
    E'## Markdown gallery\n\n| Capability | Status |\n|---|---|\n| links | [OpenTeam](https://openteam.dev) |\n| CJK | 日本語、简体中文、한국어 |\n\n> Quoted text with **strong emphasis** and `inline code`.',
    '{}'::jsonb,
    timestamp '2027-01-01 00:00:02'
  ),
  (
    md5('perf-gallery-code')::uuid,
    md5('perf-channel-2')::uuid,
    'agent'::"ChannelMessageSender",
    md5('perf-bot-2')::uuid,
    E'```ts\ntype FrameBudget = 16.67;\nconst smooth = (durationMs: number) => durationMs < 50;\n```',
    '{}'::jsonb,
    timestamp '2027-01-01 00:00:03'
  ),
  (
    md5('perf-gallery-math')::uuid,
    md5('perf-channel-2')::uuid,
    'agent'::"ChannelMessageSender",
    md5('perf-bot-2')::uuid,
    E'Math loads only for math content:\n\n$$\\sum_{i=1}^{n} i = \\frac{n(n+1)}{2}$$',
    '{}'::jsonb,
    timestamp '2027-01-01 00:00:04'
  ),
  (
    md5('perf-gallery-mermaid')::uuid,
    md5('perf-channel-2')::uuid,
    'agent'::"ChannelMessageSender",
    md5('perf-bot-2')::uuid,
    E'```mermaid\nflowchart LR\n  Input --> Worker\n  Worker --> SmoothUI\n```',
    '{}'::jsonb,
    timestamp '2027-01-01 00:00:05'
  ),
  (
    md5('perf-gallery-combined')::uuid,
    md5('perf-channel-2')::uuid,
    'agent'::"ChannelMessageSender",
    md5('perf-bot-2')::uuid,
    E'### Combined capability parity\n\n日本語 text and $E = mc^2$.\n\n```js\nrequestAnimationFrame(() => console.log("paint"));\n```\n\n```mermaid\nsequenceDiagram\n  Renderer->>Utility: bounded job\n  Utility-->>Renderer: result\n```',
    '{}'::jsonb,
    timestamp '2027-01-01 00:00:06'
  )
ON CONFLICT ("id") DO NOTHING;

\if :ios_stress_fixture

BEGIN;

-- Opt-in, deterministic fixtures for native iOS CUA. Keeping these behind a
-- switch preserves the historical desktop scale points while making the
-- expensive mobile edge cases exactly reproducible.
INSERT INTO "Bot" (
  "id", "name", "title", "description", "instructions", "icon", "color", "namedBy",
  "notificationsEnabled", "hiddenFromSidebar", "defaultDirectory", "status",
  "onboardingStatus", "onboardingCompletedAt", "createdAt", "updatedAt"
)
VALUES (
  md5('perf-ios-stress-bot')::uuid,
  'iOS Stress Fixture',
  'Native iOS scale and truncation fixture',
  'Synthetic bot created only inside the isolated performance-audit database.',
  '',
  'S',
  '#4f7cff',
  'user',
  false,
  false,
  '/workspace/bots/ios-stress-fixture',
  'active',
  'completed',
  timestamp '2027-02-01 00:00:00',
  timestamp '2027-02-01 00:00:00',
  timestamp '2027-02-01 00:00:00'
)
ON CONFLICT ("id") DO UPDATE SET
  "name" = EXCLUDED."name",
  "title" = EXCLUDED."title",
  "description" = EXCLUDED."description",
  "instructions" = EXCLUDED."instructions",
  "icon" = EXCLUDED."icon",
  "color" = EXCLUDED."color",
  "namedBy" = EXCLUDED."namedBy",
  "notificationsEnabled" = EXCLUDED."notificationsEnabled",
  "hiddenFromSidebar" = EXCLUDED."hiddenFromSidebar",
  "defaultDirectory" = EXCLUDED."defaultDirectory",
  "status" = EXCLUDED."status",
  "onboardingStatus" = EXCLUDED."onboardingStatus",
  "onboardingCompletedAt" = EXCLUDED."onboardingCompletedAt",
  "createdAt" = EXCLUDED."createdAt",
  "updatedAt" = EXCLUDED."updatedAt";

INSERT INTO "Conversation" ("id", "botId", "continuity", "createdAt", "updatedAt")
VALUES (
  md5('perf-ios-stress-conversation')::uuid,
  md5('perf-ios-stress-bot')::uuid,
  'attached',
  timestamp '2027-02-01 00:00:00',
  timestamp '2027-02-01 00:00:00'
)
ON CONFLICT ("id") DO UPDATE SET
  "botId" = EXCLUDED."botId",
  "continuity" = EXCLUDED."continuity",
  "createdAt" = EXCLUDED."createdAt",
  "updatedAt" = EXCLUDED."updatedAt";

INSERT INTO "Channel" (
  "id", "kind", "name", "description", "directKey", "workingDirectory", "createdAt", "updatedAt"
)
VALUES (
  md5('perf-ios-stress-channel')::uuid,
  'bot_dm',
  'iOS Stress Fixture',
  '200 KB Markdown, wide/deep threads, and capped run activity.',
  'bot:' || md5('perf-ios-stress-bot')::uuid,
  null,
  timestamp '2027-02-01 00:00:00',
  timestamp '2027-02-01 00:00:00'
)
ON CONFLICT ("id") DO UPDATE SET
  "kind" = EXCLUDED."kind",
  "name" = EXCLUDED."name",
  "description" = EXCLUDED."description",
  "directKey" = EXCLUDED."directKey",
  "workingDirectory" = EXCLUDED."workingDirectory",
  "archivedAt" = null,
  "createdAt" = EXCLUDED."createdAt",
  "updatedAt" = EXCLUDED."updatedAt";

INSERT INTO "ChannelMember" ("channelId", "botId", "ordinal", "createdAt")
VALUES (
  md5('perf-ios-stress-channel')::uuid,
  md5('perf-ios-stress-bot')::uuid,
  0,
  timestamp '2027-02-01 00:00:00'
)
ON CONFLICT ("channelId", "botId") DO UPDATE SET
  "ordinal" = EXCLUDED."ordinal",
  "createdAt" = EXCLUDED."createdAt";

INSERT INTO "Channel" (
  "id", "kind", "name", "description", "directKey", "workingDirectory", "createdAt", "updatedAt"
)
VALUES (
  md5('perf-ios-routine-group')::uuid,
  'group',
  'iOS Routine Scale (250)',
  'Exactly 250 disabled routines for native list and editor profiling.',
  null,
  '/workspace/projects/ios-routine-scale',
  timestamp '2027-02-01 00:00:01',
  timestamp '2027-02-01 00:00:01'
)
ON CONFLICT ("id") DO UPDATE SET
  "kind" = EXCLUDED."kind",
  "name" = EXCLUDED."name",
  "description" = EXCLUDED."description",
  "directKey" = EXCLUDED."directKey",
  "workingDirectory" = EXCLUDED."workingDirectory",
  "archivedAt" = null,
  "createdAt" = EXCLUDED."createdAt",
  "updatedAt" = EXCLUDED."updatedAt";

INSERT INTO "ChannelMember" ("channelId", "botId", "ordinal", "createdAt")
VALUES (
  md5('perf-ios-routine-group')::uuid,
  md5('perf-ios-stress-bot')::uuid,
  0,
  timestamp '2027-02-01 00:00:01'
)
ON CONFLICT ("channelId", "botId") DO UPDATE SET
  "ordinal" = EXCLUDED."ordinal",
  "createdAt" = EXCLUDED."createdAt";

-- A 125-edge chain deliberately crosses the 100-message ancestor-context
-- ceiling. Its newest leaf is a stable deep-link target for truncation checks.
INSERT INTO "ChannelMessage" (
  "id", "channelId", "sender", "senderBotId", "content", "metadata", "createdAt"
)
VALUES (
  md5('perf-ios-deep-thread-root')::uuid,
  md5('perf-ios-stress-channel')::uuid,
  'agent',
  md5('perf-ios-stress-bot')::uuid,
  'iOS Deep Thread Stress - 125-message ancestor chain',
  jsonb_build_object('fixture', 'ios-deep-thread-root'),
  timestamp '2027-02-02 00:00:00'
)
ON CONFLICT ("id") DO UPDATE SET
  "channelId" = EXCLUDED."channelId",
  "sender" = EXCLUDED."sender",
  "senderBotId" = EXCLUDED."senderBotId",
  "content" = EXCLUDED."content",
  "metadata" = EXCLUDED."metadata",
  "createdAt" = EXCLUDED."createdAt";

INSERT INTO "ChannelMessage" (
  "id", "channelId", "sender", "senderBotId", "content", "metadata", "createdAt"
)
SELECT
  md5('perf-ios-deep-thread-reply-' || reply_number)::uuid,
  md5('perf-ios-stress-channel')::uuid,
  CASE WHEN reply_number % 2 = 0 THEN 'agent'::"ChannelMessageSender"
       ELSE 'user'::"ChannelMessageSender" END,
  CASE WHEN reply_number % 2 = 0 THEN md5('perf-ios-stress-bot')::uuid ELSE null END,
  'iOS deep-chain reply ' || lpad(reply_number::text, 3, '0') || ' of 125.',
  jsonb_build_object(
    'fixture', 'ios-deep-thread-reply',
    'branched', true,
    'replyTo', CASE
      WHEN reply_number = 1 THEN md5('perf-ios-deep-thread-root')::uuid
      ELSE md5('perf-ios-deep-thread-reply-' || (reply_number - 1))::uuid
    END
  ),
  timestamp '2027-02-02 00:00:00' + reply_number * interval '1 second'
FROM generate_series(1, 125) AS reply_number
ON CONFLICT ("id") DO UPDATE SET
  "channelId" = EXCLUDED."channelId",
  "sender" = EXCLUDED."sender",
  "senderBotId" = EXCLUDED."senderBotId",
  "content" = EXCLUDED."content",
  "metadata" = EXCLUDED."metadata",
  "createdAt" = EXCLUDED."createdAt";

-- ASCII keeps character and octet counts identical, so the payload is exactly
-- 200,000 bytes while still exercising headings, lists, emphasis, code, links,
-- and the mobile renderer's oversized-Markdown fallback.
WITH markdown_parts AS (
  SELECT
    E'# iOS 200 KB Markdown Stress\n\nA deterministic oversized Markdown fixture.\n\n' AS header,
    E'\n\n_End of deterministic 200,000-byte fixture._\n' AS footer,
    E'- [ ] bounded list item with **strong text**, `inline code`, and [OpenTeam](https://openteam.dev/audit)\n' AS filler
), markdown_payload AS (
  SELECT
    header || rpad('', 200000 - length(header) - length(footer), filler) || footer AS content
  FROM markdown_parts
)
INSERT INTO "ChannelMessage" (
  "id", "channelId", "sender", "senderBotId", "content", "metadata", "createdAt"
)
SELECT
  md5('perf-ios-markdown-200kb')::uuid,
  md5('perf-ios-stress-channel')::uuid,
  'agent',
  md5('perf-ios-stress-bot')::uuid,
  content,
  jsonb_build_object('fixture', 'ios-markdown-200kb', 'expectedBytes', 200000),
  timestamp '2027-02-02 01:00:00'
FROM markdown_payload
ON CONFLICT ("id") DO UPDATE SET
  "channelId" = EXCLUDED."channelId",
  "sender" = EXCLUDED."sender",
  "senderBotId" = EXCLUDED."senderBotId",
  "content" = EXCLUDED."content",
  "metadata" = EXCLUDED."metadata",
  "createdAt" = EXCLUDED."createdAt";

-- Every reply points straight at this root. The last 100 messages therefore
-- load one bounded slice of a single 250-reply thread on first channel entry.
INSERT INTO "ChannelMessage" (
  "id", "channelId", "sender", "senderBotId", "content", "metadata", "createdAt"
)
VALUES (
  md5('perf-ios-wide-thread-root')::uuid,
  md5('perf-ios-stress-channel')::uuid,
  'agent',
  md5('perf-ios-stress-bot')::uuid,
  'iOS Wide Thread Stress - 250 direct replies',
  jsonb_build_object('fixture', 'ios-wide-thread-root'),
  timestamp '2027-02-02 02:00:00'
)
ON CONFLICT ("id") DO UPDATE SET
  "channelId" = EXCLUDED."channelId",
  "sender" = EXCLUDED."sender",
  "senderBotId" = EXCLUDED."senderBotId",
  "content" = EXCLUDED."content",
  "metadata" = EXCLUDED."metadata",
  "createdAt" = EXCLUDED."createdAt";

INSERT INTO "ChannelMessage" (
  "id", "channelId", "sender", "senderBotId", "content", "metadata", "createdAt"
)
SELECT
  md5('perf-ios-wide-thread-reply-' || reply_number)::uuid,
  md5('perf-ios-stress-channel')::uuid,
  CASE WHEN reply_number % 2 = 0 THEN 'agent'::"ChannelMessageSender"
       ELSE 'user'::"ChannelMessageSender" END,
  CASE WHEN reply_number % 2 = 0 THEN md5('perf-ios-stress-bot')::uuid ELSE null END,
  'iOS direct thread reply ' || lpad(reply_number::text, 3, '0') || ' of 250. ' ||
    repeat('Bounded native thread payload. ', 2),
  jsonb_build_object(
    'fixture', 'ios-wide-thread-reply',
    'branched', true,
    'replyTo', md5('perf-ios-wide-thread-root')::uuid
  ),
  timestamp '2027-02-02 02:00:00' + reply_number * interval '1 second'
FROM generate_series(1, 250) AS reply_number
ON CONFLICT ("id") DO UPDATE SET
  "channelId" = EXCLUDED."channelId",
  "sender" = EXCLUDED."sender",
  "senderBotId" = EXCLUDED."senderBotId",
  "content" = EXCLUDED."content",
  "metadata" = EXCLUDED."metadata",
  "createdAt" = EXCLUDED."createdAt";

INSERT INTO "ChannelMessage" (
  "id", "channelId", "sender", "senderBotId", "content", "metadata", "createdAt"
)
VALUES (
  md5('perf-ios-activity-marker')::uuid,
  md5('perf-ios-stress-channel')::uuid,
  'agent',
  md5('perf-ios-stress-bot')::uuid,
  'iOS Activity Projection Stress - 101 runs, 1,001 run items, and 101 subagents',
  jsonb_build_object('fixture', 'ios-activity-projection'),
  timestamp '2027-02-03 00:00:00'
)
ON CONFLICT ("id") DO UPDATE SET
  "channelId" = EXCLUDED."channelId",
  "sender" = EXCLUDED."sender",
  "senderBotId" = EXCLUDED."senderBotId",
  "content" = EXCLUDED."content",
  "metadata" = EXCLUDED."metadata",
  "createdAt" = EXCLUDED."createdAt";

INSERT INTO "Routine" (
  "id", "botId", "channelId", "slug", "name", "prompt", "trigger", "provenance",
  "scheduleText", "scheduleKind", "intervalSeconds", "timezoneMode", "timezone", "enabled",
  "revision", "nextRunAt", "lastRunAt", "deletedAt", "createdAt", "updatedAt"
)
SELECT
  md5('perf-ios-group-routine-' || routine_number)::uuid,
  null,
  md5('perf-ios-routine-group')::uuid,
  'ios-cua-scale-' || lpad(routine_number::text, 3, '0'),
  'iOS Group Routine ' || lpad(routine_number::text, 3, '0'),
  'Deterministic disabled routine ' || routine_number || ' of 250 for native list profiling.',
  '{"kind":"schedule"}'::jsonb,
  'user',
  'Every two hours',
  'interval',
  7200,
  'installation',
  'UTC',
  false,
  1,
  null,
  null,
  null,
  timestamp '2027-02-01 01:00:00' + routine_number * interval '1 second',
  timestamp '2027-02-01 01:00:00' + routine_number * interval '1 second'
FROM generate_series(1, 250) AS routine_number
ON CONFLICT ("id") DO UPDATE SET
  "botId" = EXCLUDED."botId",
  "channelId" = EXCLUDED."channelId",
  "slug" = EXCLUDED."slug",
  "name" = EXCLUDED."name",
  "prompt" = EXCLUDED."prompt",
  "trigger" = EXCLUDED."trigger",
  "provenance" = EXCLUDED."provenance",
  "scheduleText" = EXCLUDED."scheduleText",
  "scheduleKind" = EXCLUDED."scheduleKind",
  "cronExpression" = null,
  "intervalSeconds" = EXCLUDED."intervalSeconds",
  "timezoneMode" = EXCLUDED."timezoneMode",
  "timezone" = EXCLUDED."timezone",
  "enabled" = EXCLUDED."enabled",
  "revision" = EXCLUDED."revision",
  "nextRunAt" = EXCLUDED."nextRunAt",
  "lastRunAt" = EXCLUDED."lastRunAt",
  "pausedAt" = null,
  "deletedAt" = EXCLUDED."deletedAt",
  "createdAt" = EXCLUDED."createdAt",
  "updatedAt" = EXCLUDED."updatedAt";

-- Completed internal messages back 101 completed channel runs. Keeping them
-- non-active avoids bloating bootstrap while channel-state must still select
-- and truncate the recent activity window.
INSERT INTO "Message" (
  "id", "botId", "conversationId", "role", "content", "status", "createdAt", "updatedAt"
)
SELECT
  md5('perf-ios-activity-user-message-' || run_number)::uuid,
  md5('perf-ios-stress-bot')::uuid,
  md5('perf-ios-stress-conversation')::uuid,
  'user',
  'iOS activity fixture run ' || lpad(run_number::text, 3, '0') || ' of 101.',
  'completed',
  timestamp '2027-02-03 01:00:00' + run_number * interval '1 second',
  timestamp '2027-02-03 01:00:00' + run_number * interval '1 second'
FROM generate_series(1, 101) AS run_number
ON CONFLICT ("id") DO UPDATE SET
  "botId" = EXCLUDED."botId",
  "conversationId" = EXCLUDED."conversationId",
  "role" = EXCLUDED."role",
  "content" = EXCLUDED."content",
  "status" = EXCLUDED."status",
  "createdAt" = EXCLUDED."createdAt",
  "updatedAt" = EXCLUDED."updatedAt";

INSERT INTO "Run" (
  "id", "botId", "conversationId", "userMessageId", "status", "origin", "channelId",
  "startedAt", "completedAt", "createdAt", "updatedAt"
)
SELECT
  md5('perf-ios-activity-run-' || run_number)::uuid,
  md5('perf-ios-stress-bot')::uuid,
  md5('perf-ios-stress-conversation')::uuid,
  md5('perf-ios-activity-user-message-' || run_number)::uuid,
  'completed',
  'user',
  md5('perf-ios-stress-channel')::uuid,
  timestamp '2027-02-03 01:00:00' + run_number * interval '1 second',
  timestamp '2027-02-03 01:00:00' + run_number * interval '1 second' + interval '500 milliseconds',
  timestamp '2027-02-03 01:00:00' + run_number * interval '1 second',
  timestamp '2027-02-03 01:00:00' + run_number * interval '1 second' + interval '500 milliseconds'
FROM generate_series(1, 101) AS run_number
ON CONFLICT ("id") DO UPDATE SET
  "botId" = EXCLUDED."botId",
  "conversationId" = EXCLUDED."conversationId",
  "userMessageId" = EXCLUDED."userMessageId",
  "status" = EXCLUDED."status",
  "origin" = EXCLUDED."origin",
  "channelId" = EXCLUDED."channelId",
  "startedAt" = EXCLUDED."startedAt",
  "completedAt" = EXCLUDED."completedAt",
  "createdAt" = EXCLUDED."createdAt",
  "updatedAt" = EXCLUDED."updatedAt";

INSERT INTO "RunItem" (
  "id", "runId", "upstreamItemId", "kind", "status", "title", "content",
  "startedAt", "completedAt", "createdAt", "updatedAt"
)
SELECT
  md5('perf-ios-activity-run-item-' || item_number)::uuid,
  md5('perf-ios-activity-run-101')::uuid,
  'ios-cua-item-' || item_number,
  'tool',
  'completed',
  'iOS activity item ' || lpad(item_number::text, 4, '0'),
  jsonb_build_object('fixture', 'ios-activity-run-item', 'ordinal', item_number),
  timestamp '2027-02-03 01:02:00' + item_number * interval '1 millisecond',
  timestamp '2027-02-03 01:02:00' + item_number * interval '1 millisecond',
  timestamp '2027-02-03 01:02:00' + item_number * interval '1 millisecond',
  timestamp '2027-02-03 01:02:00' + item_number * interval '1 millisecond'
FROM generate_series(1, 1001) AS item_number
ON CONFLICT ("id") DO UPDATE SET
  "runId" = EXCLUDED."runId",
  "upstreamItemId" = EXCLUDED."upstreamItemId",
  "kind" = EXCLUDED."kind",
  "status" = EXCLUDED."status",
  "title" = EXCLUDED."title",
  "content" = EXCLUDED."content",
  "startedAt" = EXCLUDED."startedAt",
  "completedAt" = EXCLUDED."completedAt",
  "createdAt" = EXCLUDED."createdAt",
  "updatedAt" = EXCLUDED."updatedAt";

-- Dedicated hidden children avoid converting any existing audit bot into a
-- subagent identity, which would otherwise remove it from the visible fixture.
INSERT INTO "Bot" (
  "id", "name", "title", "description", "instructions", "icon", "color", "namedBy",
  "notificationsEnabled", "hiddenFromSidebar", "defaultDirectory", "status",
  "onboardingStatus", "onboardingCompletedAt", "createdAt", "updatedAt"
)
SELECT
  md5('perf-ios-activity-child-bot-' || subagent_number)::uuid,
  'iOS Activity Child ' || lpad(subagent_number::text, 3, '0'),
  'Synthetic completed subagent',
  'Hidden child used only by the isolated iOS activity fixture.',
  '',
  'S',
  '#64748b',
  'system',
  false,
  true,
  '/workspace/bots/ios-activity-child-' || subagent_number,
  'active',
  'completed',
  timestamp '2027-02-03 02:00:00' + subagent_number * interval '1 second',
  timestamp '2027-02-03 02:00:00' + subagent_number * interval '1 second',
  timestamp '2027-02-03 02:00:00' + subagent_number * interval '1 second'
FROM generate_series(1, 101) AS subagent_number
ON CONFLICT ("id") DO UPDATE SET
  "name" = EXCLUDED."name",
  "title" = EXCLUDED."title",
  "description" = EXCLUDED."description",
  "instructions" = EXCLUDED."instructions",
  "icon" = EXCLUDED."icon",
  "color" = EXCLUDED."color",
  "namedBy" = EXCLUDED."namedBy",
  "notificationsEnabled" = EXCLUDED."notificationsEnabled",
  "hiddenFromSidebar" = EXCLUDED."hiddenFromSidebar",
  "defaultDirectory" = EXCLUDED."defaultDirectory",
  "status" = EXCLUDED."status",
  "onboardingStatus" = EXCLUDED."onboardingStatus",
  "onboardingCompletedAt" = EXCLUDED."onboardingCompletedAt",
  "createdAt" = EXCLUDED."createdAt",
  "updatedAt" = EXCLUDED."updatedAt";

INSERT INTO "Subagent" (
  "id", "parentBotId", "childBotId", "parentRunId", "parentChannelId", "currentRunId",
  "launchCallId", "description", "prompt", "subagentType", "model", "fileAttachments",
  "runInBackground", "status", "result", "error", "outputPath", "startedAt", "completedAt",
  "stoppedAt", "createdAt", "updatedAt"
)
SELECT
  md5('perf-ios-activity-subagent-' || subagent_number)::uuid,
  md5('perf-ios-stress-bot')::uuid,
  md5('perf-ios-activity-child-bot-' || subagent_number)::uuid,
  md5('perf-ios-activity-run-101')::uuid,
  md5('perf-ios-stress-channel')::uuid,
  null,
  'ios-cua-launch-' || subagent_number,
  'iOS completed task ' || lpad(subagent_number::text, 3, '0'),
  'Exercise the bounded native subagent activity projection.',
  'executor',
  null,
  '[]'::jsonb,
  true,
  'completed',
  'Synthetic fixture completed.',
  null,
  '/workspace/bots/ios-activity-child-' || subagent_number || '/output.txt',
  timestamp '2027-02-03 02:00:00' + subagent_number * interval '1 second',
  timestamp '2027-02-03 02:00:00' + subagent_number * interval '1 second' + interval '500 milliseconds',
  null,
  timestamp '2027-02-03 02:00:00' + subagent_number * interval '1 second',
  timestamp '2027-02-03 02:00:00' + subagent_number * interval '1 second' + interval '500 milliseconds'
FROM generate_series(1, 101) AS subagent_number
ON CONFLICT ("id") DO UPDATE SET
  "parentBotId" = EXCLUDED."parentBotId",
  "childBotId" = EXCLUDED."childBotId",
  "parentRunId" = EXCLUDED."parentRunId",
  "parentChannelId" = EXCLUDED."parentChannelId",
  "currentRunId" = EXCLUDED."currentRunId",
  "launchCallId" = EXCLUDED."launchCallId",
  "description" = EXCLUDED."description",
  "prompt" = EXCLUDED."prompt",
  "subagentType" = EXCLUDED."subagentType",
  "model" = EXCLUDED."model",
  "fileAttachments" = EXCLUDED."fileAttachments",
  "runInBackground" = EXCLUDED."runInBackground",
  "status" = EXCLUDED."status",
  "result" = EXCLUDED."result",
  "error" = EXCLUDED."error",
  "outputPath" = EXCLUDED."outputPath",
  "startedAt" = EXCLUDED."startedAt",
  "completedAt" = EXCLUDED."completedAt",
  "stoppedAt" = EXCLUDED."stoppedAt",
  "createdAt" = EXCLUDED."createdAt",
  "updatedAt" = EXCLUDED."updatedAt";

INSERT INTO "SubagentAttempt" (
  "id", "subagentId", "parentRunId", "parentChannelId", "parentToolCallId", "childRunId",
  "description", "prompt", "fileAttachments", "runInBackground", "status", "result", "error",
  "startedAt", "completedAt", "stoppedAt", "createdAt", "updatedAt"
)
SELECT
  md5('perf-ios-activity-subagent-attempt-' || subagent_number)::uuid,
  md5('perf-ios-activity-subagent-' || subagent_number)::uuid,
  md5('perf-ios-activity-run-101')::uuid,
  md5('perf-ios-stress-channel')::uuid,
  'ios-cua-tool-call-' || subagent_number,
  null,
  'iOS completed task ' || lpad(subagent_number::text, 3, '0'),
  'Exercise the bounded native subagent activity projection.',
  '[]'::jsonb,
  true,
  'completed',
  'Synthetic fixture completed.',
  null,
  timestamp '2027-02-03 02:00:00' + subagent_number * interval '1 second',
  timestamp '2027-02-03 02:00:00' + subagent_number * interval '1 second' + interval '500 milliseconds',
  null,
  timestamp '2027-02-03 02:00:00' + subagent_number * interval '1 second',
  timestamp '2027-02-03 02:00:00' + subagent_number * interval '1 second' + interval '500 milliseconds'
FROM generate_series(1, 101) AS subagent_number
ON CONFLICT ("id") DO UPDATE SET
  "subagentId" = EXCLUDED."subagentId",
  "parentRunId" = EXCLUDED."parentRunId",
  "parentChannelId" = EXCLUDED."parentChannelId",
  "parentToolCallId" = EXCLUDED."parentToolCallId",
  "childRunId" = EXCLUDED."childRunId",
  "description" = EXCLUDED."description",
  "prompt" = EXCLUDED."prompt",
  "fileAttachments" = EXCLUDED."fileAttachments",
  "runInBackground" = EXCLUDED."runInBackground",
  "status" = EXCLUDED."status",
  "result" = EXCLUDED."result",
  "error" = EXCLUDED."error",
  "startedAt" = EXCLUDED."startedAt",
  "completedAt" = EXCLUDED."completedAt",
  "stoppedAt" = EXCLUDED."stoppedAt",
  "createdAt" = EXCLUDED."createdAt",
  "updatedAt" = EXCLUDED."updatedAt";

-- Fail the seed instead of silently producing a weaker stress point. Counts
-- use deterministic ID sets so unrelated CUA mutations cannot create a false
-- pass, and the recursive check proves the leaf is 125 reply edges from root.
DO $ios_fixture_guard$
DECLARE
  actual_count integer;
  markdown_bytes integer;
  deep_depth integer;
BEGIN
  SELECT octet_length("content") INTO markdown_bytes
  FROM "ChannelMessage"
  WHERE "id" = md5('perf-ios-markdown-200kb')::uuid;
  IF markdown_bytes IS DISTINCT FROM 200000 THEN
    RAISE EXCEPTION 'Expected 200000-byte iOS Markdown fixture, got %', markdown_bytes;
  END IF;

  SELECT count(*) INTO actual_count
  FROM "ChannelMessage"
  WHERE "id" IN (
    SELECT md5('perf-ios-wide-thread-reply-' || reply_number)::uuid
    FROM generate_series(1, 250) AS reply_number
  )
    AND "metadata" -> 'branched' = 'true'::jsonb
    AND "metadata" ->> 'replyTo' = md5('perf-ios-wide-thread-root')::uuid::text;
  IF actual_count <> 250 THEN
    RAISE EXCEPTION 'Expected 250 direct iOS thread replies, got %', actual_count;
  END IF;

  WITH RECURSIVE ancestry AS (
    SELECT "id", "metadata", 0 AS depth
    FROM "ChannelMessage"
    WHERE "id" = md5('perf-ios-deep-thread-reply-125')::uuid

    UNION ALL

    SELECT parent."id", parent."metadata", ancestry.depth + 1
    FROM ancestry
    INNER JOIN "ChannelMessage" AS parent
      ON parent."id" = (ancestry."metadata" ->> 'replyTo')::uuid
    WHERE ancestry.depth < 126
      AND ancestry."metadata" -> 'branched' = 'true'::jsonb
  )
  SELECT max(depth) INTO deep_depth FROM ancestry;
  IF deep_depth IS DISTINCT FROM 125 THEN
    RAISE EXCEPTION 'Expected 125-edge iOS deep thread, got %', deep_depth;
  END IF;

  SELECT count(*) INTO actual_count
  FROM "Routine"
  WHERE "id" IN (
    SELECT md5('perf-ios-group-routine-' || routine_number)::uuid
    FROM generate_series(1, 250) AS routine_number
  )
    AND "channelId" = md5('perf-ios-routine-group')::uuid
    AND "deletedAt" IS NULL;
  IF actual_count <> 250 THEN
    RAISE EXCEPTION 'Expected 250 iOS group routines, got %', actual_count;
  END IF;

  SELECT count(*) INTO actual_count
  FROM "Run"
  WHERE "id" IN (
    SELECT md5('perf-ios-activity-run-' || run_number)::uuid
    FROM generate_series(1, 101) AS run_number
  )
    AND "channelId" = md5('perf-ios-stress-channel')::uuid;
  IF actual_count <> 101 THEN
    RAISE EXCEPTION 'Expected 101 iOS channel runs, got %', actual_count;
  END IF;

  SELECT count(*) INTO actual_count
  FROM "RunItem"
  WHERE "id" IN (
    SELECT md5('perf-ios-activity-run-item-' || item_number)::uuid
    FROM generate_series(1, 1001) AS item_number
  )
    AND "runId" = md5('perf-ios-activity-run-101')::uuid;
  IF actual_count <> 1001 THEN
    RAISE EXCEPTION 'Expected 1001 iOS run items, got %', actual_count;
  END IF;

  SELECT count(*) INTO actual_count
  FROM "SubagentAttempt"
  WHERE "id" IN (
    SELECT md5('perf-ios-activity-subagent-attempt-' || subagent_number)::uuid
    FROM generate_series(1, 101) AS subagent_number
  )
    AND "parentChannelId" = md5('perf-ios-stress-channel')::uuid;
  IF actual_count <> 101 THEN
    RAISE EXCEPTION 'Expected 101 iOS subagent attempts, got %', actual_count;
  END IF;
END
$ios_fixture_guard$;

ANALYZE "Message";
ANALYZE "Run";
ANALYZE "RunItem";
ANALYZE "Subagent";
ANALYZE "SubagentAttempt";

COMMIT;

SELECT
  md5('perf-ios-stress-bot')::uuid AS ios_stress_bot_id,
  md5('perf-ios-stress-channel')::uuid AS ios_stress_channel_id,
  md5('perf-ios-routine-group')::uuid AS ios_routine_group_id,
  md5('perf-ios-markdown-200kb')::uuid AS ios_markdown_message_id,
  md5('perf-ios-wide-thread-root')::uuid AS ios_wide_thread_root_id,
  md5('perf-ios-deep-thread-reply-125')::uuid AS ios_deep_thread_leaf_id;

\endif

-- Seeded routines must be runnable from the same editor exercised by the UI
-- acceptance pass. A Routine without its current immutable revision can be
-- listed and edited, but Run now cannot create a valid execution.
INSERT INTO "RoutineRevision" (
  "id", "routineId", "revision", "name", "prompt", "scheduleText", "scheduleKind",
  "cronExpression", "intervalSeconds", "timezoneMode", "timezone", "enabled", "source",
  "createdAt"
)
SELECT
  md5('perf-routine-revision-' || routine."id"::text || '-' || routine."revision")::uuid,
  routine."id",
  routine."revision",
  routine."name",
  routine."prompt",
  routine."scheduleText",
  routine."scheduleKind",
  routine."cronExpression",
  routine."intervalSeconds",
  routine."timezoneMode",
  routine."timezone",
  routine."enabled",
  'performance-seed',
  routine."createdAt"
FROM "Routine" AS routine
ON CONFLICT ("routineId", "revision") DO NOTHING;

INSERT INTO "Event" ("topic", "entityId", "payload", "createdAt")
VALUES (
  'performance.fixture.updated',
  md5('perf-bot-1')::uuid,
  jsonb_build_object(
    'botCount', :bot_count,
    'messagesPerBot', :messages_per_bot,
    'groupCount', :group_count,
    'longTranscriptCount', :long_transcript_count
  ),
  now()
);

ANALYZE "Bot";
ANALYZE "Conversation";
ANALYZE "Channel";
ANALYZE "ChannelMember";
ANALYZE "ChannelMessage";
ANALYZE "Routine";
ANALYZE "SearchDocument";
ANALYZE "Event";

SELECT
  (SELECT count(*) FROM "Bot") AS bots,
  (SELECT count(*) FROM "Channel") AS channels,
  (SELECT count(*) FROM "ChannelMessage") AS channel_messages,
  (SELECT count(*) FROM "Routine") AS routines,
  (SELECT count(*) FROM "SearchDocument") AS search_documents,
  pg_size_pretty(pg_database_size(current_database())) AS database_size;
