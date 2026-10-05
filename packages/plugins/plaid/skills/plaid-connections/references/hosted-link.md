# Hosted Link

Use the setup skill's `scripts/plaid-link.py` with Python 3 on the computer holding the credentials and Items. When transferring to another machine, keep `plaid-api.py` alongside it. It shares the CLI's environment/config resolution.

```sh
python3 <setup-skill>/scripts/plaid-link.py create --products transactions
python3 <setup-skill>/scripts/plaid-link.py status --session <session-id>
python3 <setup-skill>/scripts/plaid-link.py complete --session <session-id>
```

`create` returns a session ID, Plaid URL and expiration. Send the URL to the user in OpenTeam; they can open it on any device. Default lifetime is one hour (`--lifetime <seconds>` changes it). No localhost server, tunnel, webhook endpoint, or Plaid SMS/email delivery is needed. Products supported: transactions, investments, liabilities, auth; request only the user's desired products. Transactions requests 180 days of history. This helper currently targets US institutions.

Keep the session ID in the conversation with its computer/environment. When the user says “done,” call `complete` for that session. If multiple unfinished sessions are ambiguous, resolve which one they used. If pending, check again after a short interval or the user's next message. An exited/expired session has not connected a bank; a new URL is needed after expiration. Completed session details are available from Plaid for six hours; finish promptly.

`complete` exchanges successful public tokens, saves Items into the existing CLI config and verifies `/accounts/get`. It preserves existing Items and journals exchanges so a config-write or verification failure can resume without another exchange. Repeating completion verifies existing saved Items; it does not restore removed ones. `EXCHANGE_UNCERTAIN` means an interrupted exchange needs investigation, not automatic relinking.

`status: completed` reports previously saved completion; `complete` performs a fresh account check and returns `connected`. After that, normal balance/transaction commands use the saved Item ID. A new Item can take time to make transactions available; report readiness errors rather than zero activity.

Sessions persist beside the CLI config in `hosted-link/`. Keep the returned session ID for resuming; plugin updates do not remove session state. Existing bank connections continue to work without relinking.

[Plaid Hosted Link](https://plaid.com/docs/link/hosted-link/)
