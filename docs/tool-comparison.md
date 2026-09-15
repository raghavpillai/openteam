# OpenTeam and captured Grokbot tools

Compared September 14, 2026 against the September 12 Grok Bot 0.47.0 box-harness capture. This is name and availability coverage, not certification of identical schemas, prompts, provider results, or private backend behavior.

OpenTeam exposes **59 first-party tools to a normal main agent**, including 13 formerly optional capabilities, and **46 in the original core subset**, versus **47 in the captured Grok main catalog**. **44 are shared**. OpenTeam additionally exposes ListAgents and ListGroups. GenerateImage, CloudAgent and request_scm_connect remain excluded at the user's request.

WakeParent is available in automation runs in both implementations; Grok's evidence for this tool is its separate automation prompt, not the 47-tool main catalog. OpenTeam's message schema and queue implementation are an adapter to that observed behavior. Including WakeParent, OpenTeam has 60 reachable first-party tool names across main and automation modes (47 in the original core subset). ExternalShell and ExternalRead are legacy catalog definitions hidden from current runs: use Shell/Read with machineId instead.

| Tool | Grok evidence | OpenTeam availability |
|---|---|---|
| `AddMcpServer` | Main catalog | Main catalog |
| `AuthenticateMcpServer` | Main catalog | Main catalog |
| `AwaitShell` | Main catalog | Main catalog |
| `CallDynamicTool` | Main catalog | Main catalog |
| `CheckSubagent` | Main catalog | Main catalog |
| `CloudAgent` | Main catalog | Intentionally excluded |
| `CopyFromBox` | Main catalog | Main catalog |
| `CopyToBox` | Main catalog | Main catalog |
| `CreateAgent` | Main catalog | Main catalog |
| `CreateChannel` | Main catalog | Main catalog |
| `DraftExternalMessage` | Main catalog | Main catalog |
| `ExternalRead` | Not in captured main catalog | Legacy definition; hidden |
| `ExternalShell` | Not in captured main catalog | Legacy definition; hidden |
| `GenerateImage` | Main catalog | Intentionally excluded |
| `GetDynamicTools` | Main catalog | Main catalog |
| `GetMcpServerStatus` | Main catalog | Main catalog |
| `GetPlugin` | Main catalog | Main catalog |
| `InstallPlugin` | Main catalog | Main catalog |
| `ListAgents` | Not in captured main catalog | Main catalog |
| `ListGroups` | Not in captured main catalog | Main catalog |
| `ListMachines` | Main catalog | Main catalog |
| `ListSections` | Main catalog | Main catalog |
| `MessageSubagent` | Main catalog | Main catalog |
| `ReactToMessage` | Main catalog | Main catalog |
| `Read` | Main catalog | Main catalog |
| `RecallMemory` | Main catalog | Main catalog |
| `RemoveMcpAccount` | Main catalog | Main catalog |
| `RenameMcpAccount` | Main catalog | Main catalog |
| `RestartMcpServers` | Main catalog | Main catalog |
| `Screenshot` | Main catalog | Main catalog |
| `SearchPlugins` | Main catalog | Main catalog |
| `SendFeedback` | Main catalog | Main catalog |
| `SendToAgent` | Main catalog | Main catalog |
| `SendToUser` | Main catalog | Main catalog |
| `SetMcpInstructions` | Main catalog | Main catalog |
| `Shell` | Main catalog | Main catalog |
| `StopSubagent` | Main catalog | Main catalog |
| `Task` | Main catalog | Main catalog |
| `TodoWrite` | Main catalog | Main catalog |
| `UninstallMcpServer` | Main catalog | Main catalog |
| `UninstallPlugin` | Main catalog | Main catalog |
| `UpdateAgent` | Main catalog | Main catalog |
| `UpdateChannel` | Main catalog | Main catalog |
| `WakeParent` | Automation prompt | Automation only |
| `WebFetch` | Main catalog | Main catalog |
| `WebSearch` | Main catalog | Main catalog |
| `create_bot_share_json` | Main catalog | Main catalog |
| `remap_user_form_targets` | Main catalog | Main catalog |
| `request_box_help` | Main catalog | Main catalog |
| `request_scm_connect` | Main catalog | Intentionally excluded |
| `request_user_form` | Main catalog | Main catalog |
| `update_state` | Main catalog | Main catalog |

Specialized workers expose additional tools outside this main-agent comparison:

- computerUse: Shell, Read and Computer.
- browserUse: Shell, Read and `browser_navigate`, `browser_snapshot`, `browser_click`, `browser_mouse_click_xy`, `browser_type`, `browser_fill`, `browser_select_option`, `browser_press_key`, `browser_scroll`, `browser_drag`, `browser_get_bounding_box`, `browser_highlight`, `browser_cdp`, `browser_tabs`, `browser_take_screenshot`.
- MCP connector tools vary by installed plugins, connected accounts and grants; there is no fixed global connector count.

Search providers are Exa, Tavily, Brave and Bing via SerpApi. Fetch providers are built-in HTTP, Exa Contents and Tavily Extract. Paid-provider successful calls still require usable account credentials; registration and fixture tests alone do not establish live provider success.

See [platform behavior and verification limits](platform-system-prompt.md). The latest gitignored evidence and reproducible inventory script are in findings/parity-implementation-2026-09-14/.

The thirteen added tools are `upload_file`, `download_file`, `FindContacts`, `FindIMessageChats`, `ChatItems`, `SearchIMessages`, `IMessageActivity`, `FetchIMessageAttachment`, `SendIMessage`, `CheckIMessagePermissions`, `ListCredentials`, `GetCredentialProviderStatus`, and `request_cookie_origin_approval`. See [native capabilities](native-capabilities.md) for configuration, guards and verification limits.
