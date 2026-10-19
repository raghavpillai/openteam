// Only recognized provider codes become user-facing errors. Never copy arbitrary
// stderr (which can contain credentials, stack traces, or account data) into UI.
export class McpDiagnostics {
  private pending = "";
  private oversized = false;
  authenticationError?: string;

  write(text: string) {
    for (const part of text.split(/(?<=\n)/)) {
      if (!this.oversized) this.pending += part;
      if (this.pending.length > 16_384) {
        this.pending = "";
        this.oversized = true;
      }
      if (part.endsWith("\n")) this.endLine();
    }
  }

  end() {
    this.endLine();
  }

  private endLine() {
    if (!this.oversized) {
      try {
        const entry = JSON.parse(this.pending);
        if (entry?.app === "slack-mcp-server" && ["error", "fatal"].includes(entry.level) &&
          ["invalid_auth", "token_revoked", "token_expired", "not_authed", "account_inactive"].includes(entry.error)) {
          this.authenticationError = entry.error === "account_inactive"
            ? "Authentication failed: Slack reports that this account is inactive (account_inactive). Restore account access or connect an active Slack account."
            : `Authentication failed: Slack rejected the saved browser session (${entry.error}). Replace both the browser token and session cookie in account settings with values from the same current Slack session, then reconnect.`;
        }
      } catch {
        // Unstructured or incomplete logs are not evidence of an auth failure.
      }
    }
    this.pending = "";
    this.oversized = false;
  }
}
