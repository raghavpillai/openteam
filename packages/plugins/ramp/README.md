# Ramp

Connect Ramp's hosted MCP server with browser OAuth, then use its live tools and the included finance skills. Each OpenTeam account keeps independent OAuth credentials, tools, and activity. Ramp enforces the user's role and selected read-only or full access. Connections can be renewed through account settings.

If Ramp rejects authorization for a custom client, request allowlisting for the exact callback URL shown in OpenTeam. Server callbacks are shared across accounts within a deployment. Desktop sign-in can use a fixed loopback port configured in account settings. See [Ramp's connection guide](https://agents.ramp.com/docs/guides/connecting).

The package includes 22 official Ramp playbooks and supporting references from the commit pinned in `upstream.json`, plus an OpenTeam guide and runtime rule for MCP account routing. Originals remain unchanged under `upstream/`, with MIT notices in `LICENSE` and `upstream/LICENSE`. Upstream CLI examples are translated into live MCP calls; this plugin does not install or use the Ramp CLI. CLI-only and vendor-upload playbooks, duplicate setup instructions, and the separate Ramp Router connector guide are excluded. Operations absent from the connected tools use the Ramp web workflow.

Receipt uploads work through MCP. With Full access and the upload-link tool available, the Bot requests a one-time URL, uploads the local receipt file over HTTPS, and verifies the attachment. Interactive upload cards require support from the host. Vendor document uploads and some procurement/sourcing file uploads are unavailable through MCP; existing vendor upload batch status can still be checked.

Tools depend on Ramp permissions, business features, and access level. Test a small read before running a workflow. Bill approval can advance payment according to the business's Ramp settings.
