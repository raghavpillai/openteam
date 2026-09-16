# Provider-first model selection

The chat registry contains Anthropic, OpenAI API access, OpenAI ChatGPT subscription access, and
explicitly configured custom endpoints. Credentials stay with their provider. Transcription has
separate endpoint settings and credentials.

```mermaid
flowchart LR
  A[Choose provider] --> B{Connected?}
  B -->|No| C[Sign in]
  C --> A
  B -->|Yes| D[Request provider model catalog]
  D --> E{Discovery succeeded?}
  E -->|No| F[Show recovery action and no models]
  E -->|Yes| G[Filter chat models]
  G --> H[Choose model and thinking level]
  H --> I[Recheck access and save]
```

## Discovery protocols

| Provider | Discovery | Authentication |
| --- | --- | --- |
| OpenAI API | `https://api.openai.com/v1/models` | API key as Bearer token |
| Anthropic | `https://api.anthropic.com/v1/models` | API key and API version, or supported OAuth headers |
| ChatGPT subscription | Codex account model catalog | ChatGPT OAuth; separate from API-key access |
| OpenAI-compatible custom | `<base-url>/models` | Saved credential, or explicit `--no-auth` |
| Google-compatible custom | `<base-url>/models` with `/v1beta` base | Saved API key |

[OpenAI documents its model-list API](https://developers.openai.com/api/reference/resources/models/methods/list).
[Anthropic documents its paginated catalog and capability metadata](https://platform.claude.com/docs/en/api/models/list).
The [Codex implementation](https://github.com/openai/codex/blob/main/codex-rs/codex-api/src/endpoint/models.rs)
uses a separate subscription model endpoint.
[Ollama](https://docs.ollama.com/api/openai-compatibility),
[LM Studio](https://lmstudio.ai/docs/developer/openai-compat/models), and
[vLLM](https://docs.vllm.ai/en/latest/serving/online_serving/openai_compatible_server/)
offer OpenAI-compatible APIs. [Google documents its model-list format and pagination](https://ai.google.dev/api/models).

## Failure behavior and limits

- Disconnected providers remain available to connect, with no selectable models.
- Authentication errors, unavailable endpoints, malformed responses, timeouts, and invalid
  pagination show a recovery message. A failure in one provider does not hide another's models.
- Listing never falls back to the bundled catalog. It does not change the saved model or issue
  inference requests. Switching rechecks current access; newly discovered model definitions are
  saved so the runtime can load them after restarting.
- Known retired subscription models stay excluded. Hidden subscription catalog entries stay hidden.
- Capabilities take precedence when identifying chat versus transcription. Otherwise the registry
  uses known model families. Opaque custom IDs inherit the purpose of the endpoint the user added;
  model-list APIs cannot reliably prove every model's task or tool support.
- Provider-reported access does not prove quota, billing, generation success, or tool support.
  `openteam doctor` performs a real inference probe. Listing itself has no generation charges.
- Chat discovery must be supported by the endpoint. Transcription retains manual model entry for
  audio servers without a model-list endpoint.
- `--no-auth` uses no account credential. The OpenAI SDK sends the nonsecret placeholder
  `openteam-no-auth` on inference requests; discovery sends no Authorization header.

## Validation

`apps/computer/test/chat-provider-registry.test.ts` covers authentication isolation, disconnected
providers, rejected access, response failures, pagination, retirement, and model-type filtering.
`provider-registry.integration.test.ts` runs the actual provider CLI and Pi runtime against a local
HTTP server with isolated credentials. It adds an empty custom provider, discovers and selects a
model, restarts, completes an inference request, and verifies access revocation.

CLI tests cover provider-first keyboard navigation, sign-in handoff, preserved drafts, grouped
output, and terminal sizes. `bun run preview:model --gallery ../../output/model-ui` from `apps/cli`
renders the terminal states for visual review.
