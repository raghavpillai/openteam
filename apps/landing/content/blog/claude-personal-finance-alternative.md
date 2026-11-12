---
title: Claude Personal Finance vs a self-hosted finance bot with Plaid
seoTitle: "Claude Personal Finance vs a self-hosted bot with Plaid"
description: Claude now reads US bank accounts through Plaid, read-only. How that compares with OpenTeam's Plaid plugin, which runs on your server with your own keys.
date: 2026-11-07
category: Comparisons
image: /blog/images/claude-finance-bank-data-flow.png
imageAlt: A diagram of two paths for bank data. In Claude Personal Finance, your bank connects through Plaid to Claude. In OpenTeam, your bank connects through your own Plaid keys to a bot's computer on your server, with the model provider or local model you choose
related: ai-agent-own-computer, self-host-ai-agents, is-meta-muse-safe
---

**Claude Personal Finance, in beta since November 5, lets US Pro, Max and Ultra subscribers link up to 16 banks through Plaid and ask about two years of transactions. Access is read-only. OpenTeam, an open-source, self-hosted AI agent team, has a Plaid plugin that does similar reads on your own server. You bring your own Plaid developer keys, and the connection lives on a computer you control.**

We build OpenTeam, so weigh our view accordingly. Anthropic's side comes from its announcement and help center, and Plaid's from its docs, checked for this post. OpenTeam's side comes from the Plaid plugin's skills and scripts. We have no Plaid account, so we made no bank or Sandbox connection for this post. The OpenTeam screenshots are staged from the app's own components with sample data, and nothing here is a test result.

![Two paths for bank data: Claude Personal Finance connects your bank through Plaid to Claude; OpenTeam connects it through your own Plaid keys to a bot's computer on your server, with the model provider or local model you choose](/blog/images/claude-finance-bank-data-flow.png "Both read your bank through Plaid. The difference is whose computer holds the connection. Diagram: OpenTeam.")

## Claude Personal Finance vs OpenTeam with Plaid

Claude facts from Anthropic's pages linked below, as of November 7, 2026. OpenTeam facts from the Plaid plugin in its code and from Plaid's docs.

| | Claude Personal Finance | OpenTeam with the Plaid plugin |
|---|---|---|
| Who can use it | Pro, Max and Ultra in the US, in beta | Anyone running the server, with a Plaid developer account |
| Price | Pro from $20 a month, Max $100, Ultra $200 | Free; Plaid's free Trial plan covers 10 bank connections |
| Connecting a bank | Sign in through Plaid inside Claude | Open a Plaid link the bot sends, on any device |
| Banks | Up to 16, US only | US institutions; Trial plans are for US and Canadian teams |
| History | Up to 24 months | 180 days by default with the bundled link helper |
| What it reads | Balances, credit limits, transactions | Balances, transactions, recurring charges, holdings, loans |
| Investments and loans | Balances only | Holdings, investment activity and liabilities |
| Can it move money? | No | No; no command does |
| Where the connection lives | Anthropic's providers and Plaid | Your server and Plaid |
| Training | Hub chats aren't used for training | Your model provider's terms, or none with a local model |
| Open source | No | Yes, GPL-3.0 |

## What Claude Personal Finance does

Anthropic announced it on November 5: "Personal Finance starts rolling out in beta this week, on the Pro, Max, and Ultra plans in the US" ([Anthropic](https://claude.com/resources/articles/introducing-personal-finance-in-claude)). It isn't on Free, Team or Enterprise plans, and it works on the web, the desktop apps and the iOS and Android apps ([help center](https://support.claude.com/en/articles/18185620-use-personal-finance-in-claude)). Pro costs $20 a month, or $17 a month billed yearly, Max $100 and Ultra $200 ([pricing](https://claude.com/pricing)).

**Connecting.** You choose to link accounts with Plaid, pick your bank, sign in to it and choose the accounts to share, within 10 minutes. "You can link up to 16 banks" and "You can link US banks only." Bank, credit card, loan and investment accounts all work, and "Claude doesn't ask for or see your bank password."

**What Claude sees.** "Up to 24 months of transactions, including the amount, date, merchant, category, and your bank's description," plus account names, types and last four digits, balances and credit limits. For investment and loan accounts, "Claude reads balances and credit limits, not holdings, trades, rates, or terms." Balances "can be a day or two old."

**What it does with it.** It sorts spending by category and looks for "charges that hit twice, unexpected fees, or a bill that's crept up all year." You can ask for a weekly spending chart, a calendar of bills or a dashboard. The help center lists widgets for spending, cash flow, accounts, subscriptions and upcoming bills.

**What it can't do.** "Access is read-only, and Claude can't move, manage, or invest your money" ([Claude on X](https://x.com/claudeai/status/2118403114890137895)). It "isn't designed to give investment advice," and it has "no ads or sponsored recommendations." Linked accounts can't be used in scheduled tasks, Cowork tasks or Claude Code.

**Your data.** Chats in the Personal Finance hub "aren't used to train our models"; outside the hub, your privacy settings apply. Claude is designed not to save them to memory, and they stay in your history until you delete them. "The service providers that host Claude for us also handle bank data," and Plaid handles it under its own terms. You can unlink a bank in Claude or at [my.plaid.com](https://my.plaid.com).

## How OpenTeam's Plaid plugin works

OpenTeam's bundled Plaid plugin is a set of four skills, not a hosted service: setup, connections, financial data and troubleshooting. They drive Plaid's [official CLI](https://plaid.com/docs/resources/cli/) on a computer you choose, either the bot's own Linux computer on your server or a Mac or Linux computer you've connected.

![The OpenTeam Marketplace page for the Plaid plugin, with its installation steps and four skills: plaid-connections, plaid-financial-data, plaid-setup and plaid-troubleshooting](/blog/images/openteam-plaid-plugin-page.png "The plugin's own page lists its installation steps and four skills. Sample data. Image: OpenTeam.")

### Bring your own Plaid keys

You add the plugin in **Marketplace**, then ask a bot to set up Plaid. The setup skill downloads a pinned, checksum-verified build of Plaid's CLI. It then asks for your client ID and secret from Plaid's dashboard. Each goes into a card that saves it on your server and hands it to the bot's commands as an environment variable. The value never enters the conversation, and command output that contains it is redacted.

![An OpenTeam chat where the Finance bot installed Plaid's CLI and asks for keys: a saved Plaid client ID card and a Plaid Production secret card with a masked input and a Save securely button](/blog/images/openteam-plaid-secret-request.png "Keys go into masked cards, not the chat. Sample data. Image: OpenTeam.")

You choose Sandbox, Plaid's free test environment with fake banks, or Production for real ones. New Plaid teams in the US and Canada can get a free Trial plan with up to 10 bank connections, and removing one doesn't free a slot ([Plaid](https://plaid.com/docs/account/billing/)). You apply for it in Plaid's dashboard: "To connect to real financial institutions, apply for a Trial plan" ([Plaid](https://plaid.com/docs/resources/cli/)). Paid plans bill Transactions, Investments and Liabilities per connection each month, and Plaid doesn't publish a price list.

### Connect a bank from your phone

For real banks, the bot uses Plaid's [Hosted Link](https://plaid.com/docs/link/hosted-link/): it sends you a Plaid page to open on your phone or laptop. The link lasts an hour unless the bot sets another time. You sign in to your bank there, then tell the bot you're done. It collects the result, saves the connection and checks the accounts before saying they work. No tunnel, webhook or open port is needed.

![An OpenTeam chat where both Plaid keys show as saved, the bot sends a Connect your bank with Plaid link that expires at 10:05 AM, and after Done reports a connected checking account and Visa card](/blog/images/openteam-plaid-hosted-link-connected.png "The bank sign-in happens on Plaid's page, not in OpenTeam. Sample data. Image: OpenTeam.")

The link helper asks for transactions only unless you want more, with 180 days of history; it can also request investments, liabilities and Auth, which shares account and routing numbers. It targets US institutions.

### Ask about your money

Once a bank is connected, the bot reads it with the CLI's commands: balances, transaction lists and changes since the last sync, investment holdings and activity, and loans and credit cards. Bundled helpers add Plaid's recurring-payment streams and connection status. The skills tell the bot to keep pending charges, refunds and transfers apart, treat missing data as unknown rather than zero, and never invent figures.

![An OpenTeam chat where the Finance bot compares October and September spending in a table by category, lists recurring charges including a new gym membership, and notes two pending card charges it didn't count](/blog/images/openteam-plaid-spending-summary.png "What an answer looks like. These figures are invented for the illustration. Sample data. Image: OpenTeam.")

### Read-only by design

The CLI covers Balance, Transactions, Investments and Liabilities, and the helpers call only read endpoints, so no command moves money. Plaid's money-movement product, Transfer, is a separate product with its own application ([Plaid](https://plaid.com/docs/transfer/)). The bot reads your accounts when you ask.

### Where your bank data lives

Plaid's CLI, your keys and your bank connections live on the computer that runs it ([plugin](https://github.com/raghavpillai/openteam/tree/main/packages/plugins/plaid)). On the bot's computer, that's your server. Plugins are available to every bot, so any of your bots can answer money questions from the same connection.

Only the balances and transactions a task reads go to your model provider ([privacy](/docs/configuration/privacy)), under its terms and your account settings. With a [local model](/docs/configuration/models), they stay on your hardware. Plaid keeps its own copy under [its policy](https://plaid.com/legal/), and [my.plaid.com](https://my.plaid.com) shows and revokes the apps you've connected.

## Which should you choose?

- **Choose OpenTeam's Plaid plugin if** you want the connection on your own server, your own model provider or a local model, investment holdings and loan details, and bots that can use the same data in other work.
- **Choose Claude Personal Finance if** you're on Pro, Max or Ultra in the US and want read-only money answers inside Claude.

## Frequently asked questions

### Can Claude connect to my bank account?

Yes, in the US, on Pro, Max and Ultra plans, since the November 5, 2026 beta. You link up to 16 banks through Plaid, and access is read-only ([Anthropic](https://support.claude.com/en/articles/18185620-use-personal-finance-in-claude)).

### Can Claude Personal Finance move money or pay bills?

No. Anthropic says it "can't move, manage, or invest your money." OpenTeam's Plaid plugin is read-only too: its commands only read.

### Is it safe to connect my bank to an AI?

Both options use Plaid, so the AI never sees your bank password, and both only read. The transactions a task reads go to a model: Anthropic's for Claude, or the provider you choose for OpenTeam, including a local model. Connect only the accounts you need, and unlink them at [my.plaid.com](https://my.plaid.com) when you're done.

### Do I need a Plaid account to use OpenTeam's Plaid plugin?

Yes. You need a Plaid developer account and keys. Sandbox is free with test banks, and real banks need an approved plan, such as Plaid's free Trial with up to 10 connections for new US and Canadian teams.

### Is Claude Personal Finance available outside the US?

No. As of November 7, 2026, it's a US-only beta that links US banks only. OpenTeam runs on any machine with Docker, and its Plaid link helper targets US institutions.

### Can I self-host a budgeting AI assistant?

Yes. OpenTeam runs on your own computer, home server or VM ([how to self-host AI agents](/blog/self-host-ai-agents)), and its Plaid plugin reads balances, transactions, holdings and loans with your own Plaid keys.

## Try OpenTeam

Install the server with `curl -fsSL https://openteam.so/install | sh` on macOS or Linux, then follow the [quickstart](/docs/getting-started/quickstart). Add the Plaid plugin in **Marketplace** and ask a bot to set it up.
