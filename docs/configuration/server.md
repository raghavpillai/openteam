# Server settings

Guided setup covers most installations. This page shows where to change each setting afterward.

## Where to change what

| Setting | Where to change it |
| --- | --- |
| Model provider | Desktop **Settings → Server**, or `openteam model` (sign in first with `openteam provider login`) |
| Model and reasoning level | Desktop **Settings → Server**, or `openteam model` |
| Web search and page fetching | **Settings → Providers** on desktop or iPhone |
| Voice transcription | Desktop **Settings → Server**, or `openteam model` |
| Connection mode, including Tailscale HTTPS | `openteam setup` |
| Tailscale HTTPS enable, status, disable | `openteam tailscale` or desktop Settings → Server → Remote access |
| API port, time zone, and tasks at once | `openteam setup --advanced` |
| Username and password | `openteam account update` |
| Accounts your bots use | **Marketplace** in the desktop app |

Model changes apply to new messages; a task that's already running keeps its settings. Search, fetch, and transcription changes apply to the next search, fetch, or voice note. Changes made with `openteam setup --advanced` restart the services they affect, which interrupts running tasks.

## Change setup options

Run this on the server host:

```sh
openteam setup --advanced
```

Advanced setup lets you change the [connection mode](remote-access.md), **API port** (default `8787`), time zone, and tasks at once. Running setup again keeps your account, data, and model settings.

**Time zone.** Setup uses the host's time zone. Routines you schedule in the app use the time zone of the device you schedule them on. Other routines use the server's time zone unless their schedule names one.

**Tasks at once.** This limits how many bot conversations the server works on at the same time, including helper tasks. Routine runs don't count toward it. The default is the number of CPU cores on the host, up to 8. Lower it if the host runs out of memory or your model provider rejects parallel requests. Each bot handles its chat messages one at a time; its routines can run alongside them.

## Configuration files

The [install directory](../getting-started/installation.md#where-openteam-is-installed) holds, among other files:

- `.env`: generated secrets and settings
- `compose.yaml`: the Docker services for your version
- `installation.json`: a record of how the server was installed

Setup and updates maintain these files, so change settings with the CLI instead of editing them. Don't put model API keys in `.env`; connect providers in the app or with `openteam provider login`. Include this directory in your [backups](../manage/backups.md).


## Desktop memory limits

The Compose stack limits each agent desktop to **10 GiB** by default. This includes
its headed Chrome, desktop services, native applications, and descendants of
commands launched in that desktop. It does not evict tabs or windows during
normal operation. Linux may kill an offending process when a hard limit is hit;
unsaved work in that process can be lost.

A separate ceiling protects against several desktops growing at once and includes
the shared Bun runtime. It is the smaller of **12 GiB** and **75% of the Linux
host's RAM** (Docker VM RAM on macOS). A ceiling is not a reservation. Swap is
disabled for the computer to avoid unlimited swapping. Other services and host
applications still need adequate RAM; these limits do not guarantee that an
otherwise overloaded host cannot run out of memory. Hitting the combined limit
may kill the shared runtime and restart the computer container.

Compose overrides in the install environment:

- `OPENTEAM_DESKTOP_MEMORY_LIMIT=10g`: each desktop's ceiling.
- `OPENTEAM_COMPUTER_MEMORY_LIMIT=12g`: the combined computer ceiling, also bounded
  by the 75% host rule. Use a smaller value to leave more room for other services.

Sizes use binary units: `10g` is 10 × 1024³ bytes. Recreate the computer and its
memory-init helper when changing these settings; this interrupts active work.
The two settings are independent: a desktop cannot exceed the remaining combined
budget even if it has not reached its own 10 GiB limit.

Enforcement requires Linux cgroup v2 and the `computer-memory-init` Compose
service. This small helper joins only the computer's PID/mount namespaces to make
its private cgroup tree writable and lower the combined limit when necessary. It
starts with `SYS_ADMIN`, `SYS_CHROOT`, and `SYS_PTRACE` and an unconfined AppArmor
profile, then drops every effective, permitted and inheritable capability and
sets `no_new_privs` before waiting for the computer to exit. It has no network,
Docker socket, credentials or host filesystem mounts. The computer retains its
administrator access and passwordless sudo support. The helper
restarts with the computer's PID namespace. Setup fails closed if the memory
controller cannot be initialized.

Agent processes enter their desktop cgroup before `setpriv` initializes the
desktop user's UID, GID, and supplementary groups. Children, including sudo
commands and daemonized native applications, inherit the group. The statically
linked launcher enters the group before executing the identity switch.
Ordinary commands cannot write the cgroup controls, but administrator commands
can explicitly change or bypass both the desktop and combined limits. These are
default resource budgets, not an isolation boundary against administrator access.
Destroying or restarting a failed desktop also clears its
orphaned descendants. Shared inference, browser automation helpers, plugin/MCP infrastructure and jobs that
are not attached to a desktop are covered by the combined limit.

Direct native development runs do not enable cgroups unless configured. Provider
login/import commands can still run as one-off containers without the helper.
Inspect effective kernel limits inside the computer at
`/sys/fs/cgroup/memory.max` and `/sys/fs/cgroup/desktops/*/memory.max`; Docker's
configured memory value alone may be higher than the host-adjusted limit.

References: [Docker memory limits](https://docs.docker.com/engine/containers/resource_constraints/)
and [Linux cgroup v2](https://www.kernel.org/doc/html/latest/admin-guide/cgroup-v2.html).
