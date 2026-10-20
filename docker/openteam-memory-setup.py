#!/usr/bin/python3
"""Initialize only the container's private cgroup v2 tree, before serving work."""
import os
from pathlib import Path
import time

if not os.environ.get('OPENTEAM_DESKTOP_MEMORY_LIMIT'):
    raise SystemExit(0)
root = Path('/sys/fs/cgroup')
if not (root / 'cgroup.controllers').exists():
    raise SystemExit('Per-desktop limits require cgroup v2')
# The bootstrap helper remounts this namespace's own cgroup, never the host tree.
deadline = time.monotonic() + 60
while True:
    try:
        ready = Path('/tmp/openteam-memory-ready')
        info = ready.lstat()
        if not ready.is_symlink() and info.st_uid == 0 and info.st_mode & 0o777 == 0o600:
            ceiling = int(ready.read_text().strip())
            if ceiling > 0 and (root / 'memory.max').read_text().strip() == str(ceiling):
                break
    except (OSError, ValueError):
        pass
    if time.monotonic() >= deadline:
        raise SystemExit('Cannot enforce desktop memory limits; memory-init helper did not become ready')
    time.sleep(.1)
(root / 'supervisor').mkdir(exist_ok=True)
# cgroup v2 disallows internal processes when enabling domain controllers.
# Move tini, this setup process and the entrypoint to a supervisor leaf. runc exec
# follows PID 1 there, so health checks and docker exec continue to work.
for attempt in range(100):
    pids = (root / 'cgroup.procs').read_text().split()
    for pid in pids:
        try:
            (root / 'supervisor/cgroup.procs').write_text(pid)
        except ProcessLookupError:
            pass
    if not (root / 'cgroup.procs').read_text().strip():
        break
    time.sleep(.01)
else:
    raise SystemExit('Could not drain the container cgroup; refusing unbounded startup')
(root / 'cgroup.subtree_control').write_text('+memory')
(root / 'desktops').mkdir(exist_ok=True)
(root / 'desktops/cgroup.subtree_control').write_text('+memory')
os.chmod(root / 'desktops', 0o755)
print('Per-desktop memory controller ready', flush=True)
