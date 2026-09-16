# Skills

A skill is a reusable set of instructions for a task. Use one when you want a bot to follow the same method or produce the same kind of result each time.

## When to use a skill

Use chat for a one-off request, memory for a lasting fact or preference, and a skill for a repeatable procedure. A routine determines when work runs; it can use a skill as part of the work.

For example, a release-notes skill can define the source material, categories, writing style, and review steps for every release.

## Create a private skill

Open **Plugins → Manage → Private skills**. Create instructions or import a `SKILL.md` file, add any supporting files, and choose the bots that may use it.

A useful instruction might be:

> When preparing release notes, use only the supplied changes. Group them into Added, Changed, and Fixed. Explain the user-visible effect of each change, link the source, and flag anything that needs confirmation.

Include an example of a good result if format matters. Keep credentials in the account setup form, not in skill text or supporting files.

## Use skills from a plugin

Some plugins include skills alongside their tools. Enable the skills for the intended bot, and grant the bot any connected account they require.

A skill does not grant account access by itself. For example, a meeting-preparation skill still needs access to its calendar or notes source.

## Test and improve it

Ask the bot to use the skill on a small task. Check the result, clarify any missed step, and update the instructions. Test again after changing the workflow or its connected tools.

Once the process is reliable, ask for it in another conversation or use it in a [routine](routines.md).

To distribute a skill as a package, see the contributor guide to [building plugins](../development/plugins.md).
