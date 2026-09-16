# OpenTeam copy direction

The user selected [Introducing Grok Bot](https://x.ai/news/introducing-grok-bot) as
a tone reference on September 12, 2026. Use it as a writing reference when copy
needs improvement.

## Voice

Explain recognizable work in plain, conversational language. The reference
quickly establishes what agents do, where they work, and how someone works with
them. Its examples name actual jobs and outputs. That specificity makes the
product understandable without a long setup.

- Headings and paragraphs explain each feature and its practical benefit at a
  general level. Keep job-specific stories in the associated product visuals.
- Prefer concrete verbs: message, browse, check, save, run, review, connect.
- Use simple, indicative examples in components and visualizations. A meeting
  brief demonstrates a routine; a shared file demonstrates work across agents.
- Keep headings literal. “Bring your own inference” and “Connect your apps” are
  useful without their supporting paragraphs.
- Use natural sentences. Do not turn every point into a slogan or a pair of
  fragments. Leave strong existing copy alone.

## Positioning and scope

The core message remains:

> Digital workers that run on your compute and work in your apps. They have
> their own computer and shared workspace, remember your instructions, and
> delegate work to each other.

Explain the useful difference each capability makes through recognizable work.
Basic chat, file uploads, search controls, and routine interface actions do not
need their own sales pitch. Use brief, distinct feature sections with a clear
benefit in the heading and one short paragraph explaining its use. Each section
should make sense on its own. Let the accompanying visual demonstrate an
example rather than narrating a particular job in the paragraph. Section order
and final copy are still being discussed.

### Audience and examples

Write primarily for founders and operators doing general-purpose personal and
business work. Some readers are developers, but development tasks should not
dominate the examples. Assume modest technical familiarity, not knowledge of
agent infrastructure.

Useful roles include a chief of staff, travel planner, and finance manager.
Present these in the visuals as workers the user can configure. For the
recurring-work visual, show a morning brief of today's meetings: who the user
is meeting, relevant previous conversations, and what to review before each
call. Keep the accompanying paragraph about scheduling generally. This example
does not require a claim about event-source integrations.

The apps/plugins section should bring connected data, web search, tools, and
reusable skills together under a benefit-led heading such as "Bring your apps
and data." Keep each paragraph clear and short. The approved apps/data and
own-computer paragraphs in COPY-DRAFT.md set the desired level of detail.
Additional labels should help readers understand the visual example.

- **Specialized workers on your personal cloud.** Lead with workers tailored to
  particular jobs, their roles and instructions, and work continuing on the
  user's running server. Describe personal cloud as compute the user controls;
  do not imply OpenTeam supplies a managed cloud.
- **Their own computer, a shared workspace.** Explain how separate desktops and
  browser profiles let workers do real work while sharing files and context.
  Include approved access to the user's computer and file transfers where a
  concrete example makes them useful. Do not imply a separate physical server
  or security sandbox for every bot.
- **Specialists working together.** Explain how bots bring different context to
  a shared task, talk to each other, and delegate to specialized workers. Show
  one handoff in the visual; group chats and delegation support that example.
- **Memory the user owns.** Each bot remembers instructions and preferences,
  retrieves prior context, and can use shared memory. Show how that reduces
  repeated explanation over time. Keep experimental memory synthesis qualified;
  do not imply model training or guaranteed improvement.
- **Useful recurring work.** Explain routines and individual or group ownership
  in the paragraph. Show a scheduled meeting brief in the visual. Do not
  advertise the previously listed named event sources as available product
  integrations.
- **Apps, tools, and reusable workflows.** Combine app integrations, web search,
  research/file/code capabilities, the plugin marketplace, custom MCP
  connections, and reusable skills into one coherent explanation of how work
  gets done. Account setup and access still determine availability.
- **Control when it matters.** Briefly explain permissions, approvals, and
  private input. In the visual, show a worker asking for missing context,
  sensitive input, or action approval. Use one understandable interaction to
  demonstrate the controls.
- **Desktop and mobile.** Briefly explain continuing the same work across
  desktop and iPhone with shared state. Mention iOS only for mobile.
- **Bring your own inference.** Briefly cover ChatGPT/Claude sign-in, API keys,
  and compatible hosted or local model endpoints.
- **Simple server setup.** Show the one-command installer and guided setup.
  Keep the presentation short and approachable while retaining the actual
  runtime prerequisite and avoiding a promise of zero configuration.

Mac Contacts/Messages, ordinary chat organization, and bot template sharing are
outside the current homepage story. Public availability claims must still match
the current release. User-selected priorities take precedence over the earlier
feature inventory.

## Product facts

OpenTeam's own code and shipped UI determine its claims. The tone reference is
not evidence of OpenTeam capabilities.

- Agents run on the user's server. Work can continue after the client closes
  while that server stays on. Avoid guarantees of uninterrupted operation or
  successful completion of every task.
- The server stack needs a running Docker Engine for Linux containers and Compose
  2.20+. Linux can run the engine directly; Docker Desktop supplies the VM and
  engine on macOS and Windows. The Docker CLI alone is not a runtime.
- The OpenTeam desktop app provides the approval bridge for delegated task launches,
  including computer-use workers, and physical-host tools. Those operations need the
  app running and reachable from the server's computer container.
- Plugins connect apps and supply skills. Explain account access and tool
  approval controls where relevant.
- Skills save reusable instructions and supporting files.
- Distinguish saved memory from conversation context and browser state. Describe
  memory through useful remembered facts, preferences, and instructions.
- Keep sample tasks and recreated UI labeled. Use actual release availability
  when describing downloads, including the iPhone source build requirement.

## Editorial checks

Can a reader tell what to ask for, what the agent can do, and where the result
appears? Does each claim match the product? Is the sentence clearer than the
one it replaces?

Avoid vague lines such as “Keep the good parts” or “Pick the brains. We give
them hands.” Preserve OpenTeam's own wording and examples when adopting a
reference's tone.
