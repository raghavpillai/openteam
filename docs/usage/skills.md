# Skills

A skill is a saved set of instructions for a task you repeat. Bots use it to follow the same method and produce the same kind of result every time.

## When to use a skill

| To... | Use |
| --- | --- |
| Keep a fact or preference | [Memory](memory.md) |
| Repeat a method | A skill |
| Run work on a schedule | A [routine](routines.md), which can use a skill |

For example, a release-notes skill can define where to find changes, how to group them, the writing style, and what to check before finishing.

## Create a skill

1. Open **Marketplace**, then choose **Manage → Private skills**.
2. Choose **Create skill**, or **Import SKILL.md** to load an existing skill file.
3. Fill in:
   - **Skill name**
   - **When to use it**: a sentence that helps bots recognize when the skill applies
   - **Instructions**: the method itself
   - **Supporting files** (optional): templates, examples, or reference text, entered as JSON that maps each file path to its text
4. Under **Available to Bots**, choose which bots can use it.
5. Choose **Save skill**.

Good instructions are specific about inputs, steps, and the finished result:

> When preparing release notes, use only the supplied changes. Group them into Added, Changed, and Fixed. Explain the user-visible effect of each change, link the source, and flag anything that needs confirmation.

If the format matters, include an example of a good result as a supporting file. Don't put passwords or API keys in a skill; connect accounts through [plugins](plugins.md) instead.

You can also ask a bot to save a method it just used as a skill:

> Save how you prepared these release notes as a skill, so you can do it the same way next time.

Skills that bots save are available to all your bots. They don't appear under **Private skills**.

## Skills from plugins

Some plugins come with skills, such as instructions for working with that service. To turn them on for a bot, open the plugin's page and, under **Bot access**, turn on **Instructions and hooks** for that bot. To use the plugin's tools, the bot also needs access to its account.

| Plugin | Included skills |
| --- | --- |
| [Slack](../../packages/plugins/slack/README.md#skills-and-commands) | 8: `slack-messaging`, `slack-search`, `slack-docs`, `slack-api`, `slack-cli`, `create-slack-app`, `test-slack-app`, and `block-kit` |
| [Granola](../../packages/plugins/granola/README.md) | 3: `granola-context`, `granola-prep`, and `granola-review` |
| [Notion](../../packages/plugins/notion/README.md) | 14: `search`, `find`, `create-page`, `create-task`, `create-database-row`, `database-query`, `knowledge-capture`, `meeting-intelligence`, `research-documentation`, `spec-to-implementation`, `tasks-plan`, `tasks-build`, `tasks-explain-diff`, and `tasks-setup` |
| [1Password](../../packages/plugins/1password/README.md#capabilities) | `1password-environments`: work with Developer Environments and local `.env` mounts |
| Research Playbook | `source-led-research`: research claims, compare sources, and write sourced summaries |

Gmail, Google Calendar, Google Drive, GitHub, Linear, and Utility Lab provide tools without bundled skills. You can create a private skill that uses those tools.

Provider skills keep their original upstream instructions. Installing or updating Granola and Notion fetches their pinned skills automatically; you don't need to copy files yourself. Updating a plugin updates its included skills. Your private skills remain separate.

Slack and Granola also include commands. For example, ask for `/slack:summarize-channel #general` or `/granola-brief <meeting or topic>`. See their package guides for all commands and any extra setup. Slack's app-development skills may need the Slack CLI and a language runtime on the bot computer. The 1Password skill uses the desktop's environments; its desktop mount-validation hook is inactive on the separate bot computer.

## Test and improve a skill

Ask a bot to use the skill on a small task and check the result. If it missed a step, update the instructions and try again. Once it works reliably, use it in other conversations or in a [routine](routines.md).

To share a skill with others as a package, see [build a plugin](../development/plugins.md).
