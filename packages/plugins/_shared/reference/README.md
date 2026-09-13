# Google connector reference

These JSON files pin the public `tools/list` responses retrieved on September 12, 2026 from:

- https://gmailmcp.googleapis.com/mcp/v1
- https://calendarmcp.googleapis.com/mcp/v1
- https://drivemcp.googleapis.com/mcp/v1

They contain public interface metadata, no credentials or account data. Google provides the definitions; OpenTeam implements the operations against the generally available REST APIs. Reference input names, enums and descriptions are retained, with documented compatibility aliases and local extensions. This does not make the adapters Google's official MCP servers.

Reference documentation: https://developers.google.com/workspace/gmail/api/reference/mcp , https://developers.google.com/workspace/calendar/api/v3/reference/mcp , https://developers.google.com/workspace/drive/api/reference/mcp . Google licenses documentation under CC BY 4.0 and code samples under Apache 2.0; see https://developers.google.com/terms/site-policies . Attribution and provenance must accompany exports that embed these definitions. The generate script includes this notice in Google packages.

Refresh intentionally, review schema/behavior changes, implement them, and run the contract and behavioral tests before changing package versions. Never infer runtime parity from a matching name or input schema alone.
