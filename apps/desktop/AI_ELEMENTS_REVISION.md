# AI Elements source revision

The source-owned components under `src/renderer/components/ai-elements` are reviewed adaptations of the corresponding AI Elements components at:

- Repository: `vercel/ai-elements`
- Commit: `6a9d5b1822ffb10bba4bd97175f01edd7d8651cd`
- Retrieved: 2026-08-24

The components are intentionally checked into OpenTeam, following AI Elements' source-owned distribution model. OpenTeam removes Next.js and AI SDK message-type coupling while preserving the conversation, prompt, message, and tool interaction patterns.

The 2026-08-24 UI pass expanded this set with AI Elements-style message actions and shimmer states, moved rich Streamdown rendering behind a lazy boundary, and standardized every surrounding control on source-owned shadcn primitives.
