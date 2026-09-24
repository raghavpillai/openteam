# FAQ

Quick answers to common questions about OpenTeam.

## Do I have to host it myself?

Yes. OpenTeam runs on a machine you control, such as your own computer, a home server, or a cloud VM. The [quickstart](../getting-started/quickstart.md) walks you through it.

## Does it keep working when I close the app?

Yes. Bots and routines run on the server, so you can close the app and check back later. The server itself has to stay on. The one exception is work on [your own computer](../usage/computer.md#use-your-own-computer), which needs the desktop app open.

## What does it cost?

OpenTeam is open source under the GPL-3.0 license, and its code is on [GitHub](https://github.com/raghavpillai/openteam). You pay for the machine it runs on and for the services you connect, such as your model provider, web search, and transcription. Routines and `openteam doctor` also use your model provider.

## Can several bots work at the same time?

Yes. Different bots can work in parallel, up to the server's **tasks at once** setting. See [server settings](../configuration/server.md#change-setup-options). Each bot handles its own messages one at a time.

## Can different bots use different models?

Not currently. All bots use the model selected in **Settings → Server**. See [model providers](../configuration/models.md#choose-a-model).

## Is a bot using my computer's desktop?

No. Bots work on their own Linux computer on your server. They can only work on your own computer if you allow it in the desktop app, and even then they can't see or control your screen. See [computer and browser](../usage/computer.md).

## Is my data private?

Your conversations, files, and memory are stored on your server. Your model provider sees what bots send it to do their work, and connected services see the requests bots make to them. To keep model requests on your own hardware too, connect a [local model server](../configuration/models.md#use-your-own-model-server).

## Does signing in to ChatGPT or Claude connect my other accounts?

No. Your model provider, web search, voice transcription, and each plugin are set up separately. Connecting a plugin also doesn't give every bot access; you choose which bots can use it.

## Can other people use my server?

Each server has one account. You can sign in with it from all your devices, but there's no way to add other people yet. Group chats bring bots together, not people.

## Do I need a plugin for every website?

No. Bots can use any website in their browser. Plugins give them faster, more reliable access to supported services. For sites that need a sign-in, [sign the bot in](../usage/computer.md#sign-in-to-websites) once.

## Is there an iPhone or Android app?

There's an iPhone app in [public beta on TestFlight](https://testflight.apple.com/join/KFBFPkjP), which you can also build from source. There's no Android app. See [desktop and mobile](../getting-started/apps.md).

## Do updates back up my data?

Only partly. `openteam update` backs up the database so it can roll back a failed update. It doesn't back up files, sign-ins, or attachments. See [backups and restore](backups.md).
