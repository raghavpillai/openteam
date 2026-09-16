# Server settings

Most installations only need guided setup and the app's Server settings. Change one setting at a time, then check that the server is healthy.

## Choose the right control

| I want to change | Where to do it |
| --- | --- |
| Provider, model, or reasoning level | Desktop Settings → Server, or `openteam model` |
| Network address, port, or time zone | `openteam setup --advanced` |
| Number of simultaneous bot turns | `openteam setup --advanced` |
| Owner username or password | `openteam account update` |
| Web search or page fetching | Desktop Settings → Server → Web search / Web fetch |
| Voice transcription | Desktop Settings → Server → Transcription |
| Connected app accounts | Plugins |

Provider, search, and fetch changes apply to subsequent work. Network and installation settings may restart services when applied.

## Run guided setup again

```sh
openteam setup
openteam setup --advanced
```

Regular setup lets you reconnect or change inference. Advanced setup also exposes the connection mode, API port, time zone, and concurrency. Reconfiguring an existing installation preserves its owner account; use the account command to change credentials.

The time zone matters for routines that use the installation's fallback. Each routine can also retain its own saved zone, so check the routine after changing the server setting.

## Balance simultaneous work

The concurrency setting limits the number of bot turns that run at once. A single bot still handles its own turns in order. Start with the default and reduce it if the host is short on memory or your model provider rejects concurrent requests.

## Configuration files

The default installation directory is `~/.openteam`. Guided setup maintains its `.env`, Compose file, and installation record. Prefer the CLI to editing derived network values by hand.

Keep generated secrets and the configuration directory with your backups. Do not put model-provider API keys into `.env`; connect providers through the supported setup controls.

If you need a less common environment option, consult the [operator configuration reference](../reference/server-configuration.md). For connection problems, start with [troubleshooting](../manage/troubleshooting.md).
