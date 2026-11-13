# Chat and teamwork

Chat with one bot for focused work. Start a group chat when several bots should work on the same thing together.

## Ask for work

Send the task along with the files, links, and decisions the bot needs. Say where the result should go and when it should check with you:

> Read the attached proposal, list any missing requirements, and draft questions for the vendor. Keep everything in this chat; don't contact them.

When a bot asks a question or needs information, it waits for your answer in the conversation.

## Reply, attach, and search

- **Reply to a message** to tie your follow-up to it. On desktop, hover over the message and choose **Reply**. On iPhone and iPad, swipe the message to the right, or long-press it and choose **Reply**.
- **Start a thread** to follow up on one message without crowding the conversation. On iPhone and iPad, long-press the message and choose **Start a thread**. On desktop, a message with a thread shows its number of replies; select it to open the thread and reply there.
- **Attach files or images** the bot should work from. See [files and results](files.md).
- **Dictate** instead of typing with [voice notes](../configuration/transcription.md).
- **Search** messages, bots, groups, files, links, and routines. On desktop, press **⌘K** on macOS or **Ctrl+K** on Windows and Linux. On iPhone and iPad, tap **Search** in the conversation list. Choose a message result to open it in context.

To delete a bot and its chat history, choose **Delete bot** in the bot's settings on desktop, or long-press its conversation on iPhone or iPad and choose **Delete bot**. This can't be undone.

## Maps and ranked places

Bots can show places as an interactive map or a ranked list, alongside their explanation, in a private bot conversation. Select a pin or place card for the supplied details, open the map fullscreen, or follow the source, website, or directions link. A measured route can show stops, distance, and travel time. Rich place cards are not currently delivered to group chats or external services.

The desktop app uses MapLibre with OpenFreeMap tiles; iPhone and iPad use Apple MapKit. Place search is separate: add [OpenStreetMap or Google Maps](../integrations/maps.md) for place lookup and routes. Ratings, reviews, photos, and opening status appear only when a source supplies them. Check the source before relying on opening hours or directions.

## If a message doesn't send

A message that fails to send shows **Not delivered** with **Retry**. **Delivery unconfirmed** means the app couldn't tell whether the server accepted the message; **Retry** checks and sends it again if needed. On desktop, the message's **…** menu shows what went wrong and offers **Delete message**. On iPhone and iPad, long-press an unsent message and choose **Discard** to remove it.

## Create a group chat

On iPhone and iPad, tap **+**, then **New Group Chat**. Pick the bots, choose **Next**, name the group, and choose **Create**.

The desktop app has no button for this. Ask a bot to start a group chat with the bots you name. Group chats work in both apps once they exist, and a group can have up to six bots.

Give each bot a clear role so they can split the work:

> Research: collect the source material. Docs: turn it into a one-page brief. Keep source links in the shared file and flag any disagreements for me.

Every bot in the group can reply. They take turns, so they build on each other's messages instead of talking over each other. To address one bot, @mention it.

## Hand off work between bots

All bots share the `/workspace` folder, so one bot can pick up another's files. Make handoffs specific: name the file, the next step, and any open questions.

> Continue from /workspace/launch/brief.md. Verify the dates before you edit the recommendation.

Bots can also message each other and hand tasks to helpers on their own. While a bot's helpers are still working, its conversation shows **Working in the background**.
