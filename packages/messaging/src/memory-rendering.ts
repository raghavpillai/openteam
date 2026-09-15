// Prompt rendering ported from the independently hashed ecc8113 sand-memory.ts.
// The database/file adapters supply records and deployment paths; wording and
// character-budget behavior are checked against reference-generated fixtures.
import { renderMemoryConversationScopeStory, type MemoryScopeStory } from "./memory-scopes";
export type MemorySource =
  | { kind: "agent" }
  | { kind: "conversation" }
  | { kind: "sibling"; sessionId: string };
export interface PromptMemoryRecord {
  content: string;
  createdAt: number;
  source?: MemorySource;
  via: string;
}
export interface PromptMemoryRecall {
  profile: PromptMemoryRecord[];
  recent: PromptMemoryRecord[];
}
export interface ProjectMemoryBlock {
  slug: string;
  name: string;
  ownShardDir?: string;
  recall: PromptMemoryRecall;
}
export interface ProjectMemoryRecall {
  injected: ProjectMemoryBlock[];
  alsoMemberOf: Array<{ slug: string; name: string }>;
}

const MEMORY_RECENT_PROMPT_CHAR_BUDGET = 4e3;

const SAND_RECALL_MEMORY_TOOL_NAME = "RecallMemory";

const MEMORY_UPDATE_STATE_GUIDANCE =
  'To CHANGE memory, prefer the update_state tool (target "memory"): action "write" with a fact and a tier (profile | log | note), or action "forget" with the exact text of a recorded fact.';

const USER_MEMORY_MORE_HINT_ON_DISK = `on disk \u2014 call ${SAND_RECALL_MEMORY_TOOL_NAME} (scope "user") or grep the user-memory/ folder`;

const USER_MEMORY_MORE_HINT_SERVER = `not shown \u2014 call ${SAND_RECALL_MEMORY_TOOL_NAME} (scope "user")`;

const USER_MEMORY_PROMPT_HEADER =
  "User memory: durable facts shared across every assistant this user runs \u2014 their name, timezone, lasting preferences, and anything all of the user's assistants should know. This is separate from your own memory (shown below) and is visible to all of them.";

const MEMORY_USER_PROFILE_CHAR_BUDGET = 4e3;

const MEMORY_USER_RECENT_CHAR_BUDGET = 2e3;

const MEMORY_PROJECT_PROFILE_CHAR_BUDGET = 2500;

const MEMORY_PROJECT_RECENT_CHAR_BUDGET = 1500;

export function formatMemoryDate(createdAtMs: number) {
  if (!Number.isFinite(createdAtMs) || createdAtMs <= 0) return "unknown date";
  return new Date(createdAtMs).toISOString().slice(0, 10);
}

export function factLine(memory: PromptMemoryRecord) {
  return `- (learned ${formatMemoryDate(memory.createdAt)}) ${memory.content}`;
}

export function agentMemorySourceTag(source: MemorySource) {
  switch (source.kind) {
    case "agent":
      return null;
    case "conversation":
      return "this conversation";
    case "sibling":
      return `via session ${source.sessionId}`;
  }
}

export function sourcedFactLine(memory: PromptMemoryRecord) {
  const tag = memory.source === void 0 ? null : agentMemorySourceTag(memory.source);
  if (tag === null) return factLine(memory);
  return `- (learned ${formatMemoryDate(memory.createdAt)}) [${tag}] ${memory.content}`;
}

export function renderMemorySystemPrompt(
  recall: PromptMemoryRecall,
  location2: string | null,
  opts?: { conversationMemory?: MemoryScopeStory; nativeMemory?: MemoryScopeStory }
) {
  const { profile, recent } = recall;
  const conversationMemory = opts?.conversationMemory;
  const nativeMemory = opts?.nativeMemory;
  const legacyFacts = nativeMemory !== void 0 && [...profile, ...recent].some((fact) => fact.source && fact.source.kind !== "agent");
  const conversationScoped = conversationMemory !== void 0 || legacyFacts;
  const renderFact = conversationScoped ? sourcedFactLine : factLine;
  const lines2 = [
    "Memory: durable facts you have learned about the user and their world.",
    conversationScoped
      ? "Agent-wide facts persist across every conversation with this agent; facts saved to this conversation's memory persist for this conversation and the agent's conversations with the same audience. Rely on them so you stay consistent and avoid re-asking what you already know."
      : "These persist across every conversation with this agent, even after the chat is cleared. Rely on them so you stay consistent and avoid re-asking what you already know.",
  ];
  if (location2 != null) {
    lines2.push(
      `Your memory lives in a folder at ${location2}: profile.md holds who the user is (kept in mind every turn) and log/ holds dated history.`,
      `Call ${SAND_RECALL_MEMORY_TOOL_NAME} to search for older facts that are not listed here (you can also read or grep those files with Read and Shell on your own computer). ${MEMORY_UPDATE_STATE_GUIDANCE}`
    );
  } else {
    lines2.push(
      `Call ${SAND_RECALL_MEMORY_TOOL_NAME} to search for older facts that are not listed here. ${MEMORY_UPDATE_STATE_GUIDANCE}`
    );
  }
  if (conversationMemory !== void 0) {
    lines2.push(`Where to save: ${renderMemoryConversationScopeStory(conversationMemory)}`);
  }
  if (nativeMemory !== void 0) {
    lines2.push('Where to save: scope "agent" (default) is your memory across every conversation with this bot. scope "project" writes your shard in a project you have joined and requires project=<slug>.');
    lines2.push(["owner", "sender"].includes(nativeMemory.userScope)
      ? 'scope "user" is durable facts about the owner, shared across their assistants.'
      : 'scope "user" is the owner\'s memory across their agents and cannot be written from this conversation.');
    if (nativeMemory.teamShared) lines2.push('This assistant is shared with the team, so scope "agent" is team-wide memory everyone who talks to it sees. Mention a save or forget in your reply.');
    if (legacyFacts) lines2.push("Older room records below remain visible only to their original audience. New memories are saved across this bot's conversations.");
  }
  if (conversationScoped && (profile.length > 0 || recent.length > 0)) {
    lines2.push(
      "Facts saved from this conversation are tagged [this conversation] and facts from another conversation with the same audience are tagged [via session <id>]; untagged facts are agent-wide."
    );
  }
  if (profile.length > 0) {
    lines2.push("About the user:");
    for (const memory of profile) lines2.push(renderFact(memory));
  }
  if (recent.length > 0) {
    lines2.push("Recently:");
    let budget = MEMORY_RECENT_PROMPT_CHAR_BUDGET;
    let shown = 0;
    for (const memory of recent) {
      const line = renderFact(memory);
      if (shown > 0 && line.length > budget) break;
      lines2.push(line);
      budget -= line.length;
      shown += 1;
    }
    const omitted = recent.length - shown;
    if (omitted > 0) {
      lines2.push(
        location2 != null
          ? `(${omitted} more log facts on disk \u2014 call ${SAND_RECALL_MEMORY_TOOL_NAME} or grep the log/ folder for them.)`
          : `(${omitted} more log facts not shown \u2014 call ${SAND_RECALL_MEMORY_TOOL_NAME} to search them.)`
      );
    }
  }
  if (profile.length === 0 && recent.length === 0) {
    lines2.push("No facts recorded yet.");
  }
  return lines2.join("\n");
}

export function provenancedFactLine(record2: PromptMemoryRecord) {
  const via = record2.via.trim();
  const tag = via.length > 0 ? ` [via ${via}]` : "";
  return `- (learned ${formatMemoryDate(record2.createdAt)})${tag} ${record2.content}`;
}

export function appendBudgetedProvenancedFacts(
  lines2: string[],
  records2: PromptMemoryRecord[],
  charBudget: number,
  moreLabel: string,
  moreHint: string
) {
  let budget = charBudget;
  let shown = 0;
  for (const record2 of records2) {
    const line = provenancedFactLine(record2);
    if (shown > 0 && line.length > budget) break;
    lines2.push(line);
    budget -= line.length;
    shown += 1;
  }
  const omitted = records2.length - shown;
  if (omitted > 0) {
    lines2.push(`(${omitted} more shared ${moreLabel} ${moreHint} for them.)`);
  }
}

export function renderUserMemorySystemPrompt(
  recall: PromptMemoryRecall,
  ctx: { userMemoryDir?: string; ownShardDir?: string }
) {
  const { profile, recent } = recall;
  const hasFacts = profile.length > 0 || recent.length > 0;
  const lines2 = [
    USER_MEMORY_PROMPT_HEADER,
    "Precedence: when a shared user fact conflicts with your OWN memory, prefer your own \u2014 it is curated for your role and may deliberately override a shared default.",
  ];
  if (ctx.userMemoryDir != null && ctx.ownShardDir != null) {
    lines2.push(
      `User memory lives under ${ctx.userMemoryDir}, split into one shard folder per assistant so every file has a single writer. Your own shard is at ${ctx.ownShardDir} (a profile.md and log/YYYY-MM.md you can read and grep with Read and Shell on your own computer). Call ${SAND_RECALL_MEMORY_TOOL_NAME} (scope "user") to search shared facts that are not listed here. To CHANGE shared user memory, prefer the update_state tool (target "memory", scope "user", action "write" or "forget"). Never edit another assistant's shard.`
    );
  } else {
    lines2.push(
      `Every assistant writes its own shard of user memory; yours is kept for you and is not a file on your computer. Call ${SAND_RECALL_MEMORY_TOOL_NAME} (scope "user") to search shared facts that are not listed here. To CHANGE shared user memory, use the update_state tool (target "memory", scope "user", action "write" or "forget").`
    );
  }
  lines2.push(
    'To fix or replace a shared fact another assistant recorded, write the corrected fact into YOUR shard via update_state \u2014 the newest wins on conflict. Record a fact here only when it is clearly about the user and useful to every assistant; keep role-specific facts in your own memory (scope "agent").'
  );
  if (hasFacts) {
    lines2.push(
      "Shared facts are tagged [via <assistant>] so you can tell which assistant learned each one."
    );
  }
  const moreHint =
    ctx.userMemoryDir != null && ctx.ownShardDir != null
      ? USER_MEMORY_MORE_HINT_ON_DISK
      : USER_MEMORY_MORE_HINT_SERVER;
  if (profile.length > 0) {
    lines2.push("About the user (shared):");
    appendBudgetedProvenancedFacts(
      lines2,
      profile,
      MEMORY_USER_PROFILE_CHAR_BUDGET,
      "profile facts",
      moreHint
    );
  }
  if (recent.length > 0) {
    lines2.push("Recently (shared):");
    appendBudgetedProvenancedFacts(
      lines2,
      recent,
      MEMORY_USER_RECENT_CHAR_BUDGET,
      "log facts",
      moreHint
    );
  }
  if (!hasFacts) {
    lines2.push("No shared facts recorded yet.");
  }
  return lines2.join("\n");
}

export function projectMemoryActivity(recall: PromptMemoryRecall) {
  let newest = 0;
  for (const record2 of [...recall.profile, ...recall.recent]) {
    if (record2.createdAt > newest) newest = record2.createdAt;
  }
  return newest;
}

export function selectProjectMemoryBlocks(blocks: ProjectMemoryBlock[], injectedCap: number) {
  const cap = Number.isFinite(injectedCap) && injectedCap > 0 ? Math.floor(injectedCap) : 0;
  const ordered = [...blocks].sort((a, b2) => {
    const factsA = hasProjectFacts(a) ? 1 : 0;
    const factsB = hasProjectFacts(b2) ? 1 : 0;
    if (factsA !== factsB) return factsB - factsA;
    const activity = projectMemoryActivity(b2.recall) - projectMemoryActivity(a.recall);
    if (activity !== 0) return activity;
    if (a.slug === b2.slug) return 0;
    return a.slug < b2.slug ? -1 : 1;
  });
  return {
    injected: ordered.slice(0, cap),
    alsoMemberOf: ordered.slice(cap).map((block) => ({ slug: block.slug, name: block.name })),
  };
}

export function hasProjectFacts(block: ProjectMemoryBlock) {
  return block.recall.profile.length > 0 || block.recall.recent.length > 0;
}

export function renderProjectMemorySystemPrompt(
  recall: ProjectMemoryRecall,
  ctx: { projectsRootDir?: string }
) {
  if (ctx.projectsRootDir == null) return "";
  const lines2 = [
    "Project memory: durable facts shared by every assistant that has joined a project \u2014 the project's decisions, conventions, and state. Projects are optional and opt-in; joining one lets its memory into your prompt below.",
    "Precedence across memory tiers: on conflict prefer your OWN memory first, then project memory, then user memory \u2014 the most specific wins.",
    `Projects live under ${ctx.projectsRootDir}: each is a folder <slug>/ holding a project.md (frontmatter name/description) and memory/by-agent/<assistantId>/ shards (one per contributing assistant, a standard profile.md + log/). Read and grep those folders with Read and Shell on your own computer; prefer the update_state tool for every CHANGE:`,
    '  - Define a project: update_state target "project", action "create", project=<slug>, name=... (optional description). If the slug already exists this is create-is-join.',
    `  - Join or leave: update_state target "project", action "join" or "leave", project=<slug>. Only projects you have joined load below; to see who else is a member, grep the assistants' projects.json files.`,
    `  - Write project facts with update_state target "memory", scope "project", project=<slug>, action "write" or "forget" (never another assistant's shard); newest wins on conflict. Record a fact here only when it is about the project and useful to every member.`,
  ];
  for (const block of recall.injected) {
    const header =
      block.ownShardDir != null
        ? `Project "${block.name}" (${block.slug}) \u2014 your shard: ${block.ownShardDir}:`
        : `Project "${block.name}" (${block.slug}):`;
    lines2.push(header);
    const grepHint = `on disk \u2014 grep this project's memory/ folder`;
    if (block.recall.profile.length > 0) {
      lines2.push("About this project (shared):");
      appendBudgetedProvenancedFacts(
        lines2,
        block.recall.profile,
        MEMORY_PROJECT_PROFILE_CHAR_BUDGET,
        "profile facts",
        grepHint
      );
    }
    if (block.recall.recent.length > 0) {
      lines2.push("Recently (shared):");
      appendBudgetedProvenancedFacts(
        lines2,
        block.recall.recent,
        MEMORY_PROJECT_RECENT_CHAR_BUDGET,
        "log facts",
        grepHint
      );
    }
    if (!hasProjectFacts(block)) {
      lines2.push("No shared facts recorded yet for this project.");
    }
  }
  if (recall.alsoMemberOf.length > 0) {
    const pointers = recall.alsoMemberOf
      .map((pointer) => `${pointer.name} (${pointer.slug})`)
      .join(", ");
    lines2.push(
      `Also a member of: ${pointers} \u2014 grep those project folders for their memory.`
    );
  }
  return lines2.join("\n");
}
