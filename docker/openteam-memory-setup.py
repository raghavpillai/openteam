#!/usr/bin/python3
"""Initialize only the container's private cgroup v2 tree, before serving work."""
import errno
import os
from pathlib import Path
import stat
import time

def init_starttime():
    # stat's comm field can contain spaces and parentheses; field 22 follows it.
    return int(Path('/proc/1/stat').read_text().rsplit(')', 1)[1].split()[19])


def helper_ready(root, ready):
    # Open once without following symlinks, then validate that same file. A
    # stale marker can have the correct budget while this boot is still read-only.
    try:
        fd = os.open(ready, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC)
        with os.fdopen(fd) as marker:
            info = os.fstat(marker.fileno())
            if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or stat.S_IMODE(info.st_mode) != 0o600:
                return False
            contents = marker.read(129)
            ceiling, namespace, starttime = map(int, contents.split())
            if len(contents) > 128 or contents != f'{ceiling} {namespace} {starttime}\n':
                return False
        return (ceiling > 0 and namespace == os.stat('/proc/1/ns/mnt').st_ino
                and starttime > 0 and starttime == init_starttime()
                and (root / 'memory.max').read_text().strip() == str(ceiling))
    except (OSError, ValueError, IndexError):
        return False


def main():
    if not os.environ.get('OPENTEAM_DESKTOP_MEMORY_LIMIT'):
        return
    root = Path('/sys/fs/cgroup')
    if not (root / 'cgroup.controllers').exists():
        raise SystemExit('Per-desktop limits require cgroup v2')
    # The bootstrap helper remounts this namespace's own cgroup, never the host tree.
    deadline = time.monotonic() + 60
    while not helper_ready(root, Path('/tmp/openteam-memory-ready')):
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
            try:
                (root / 'cgroup.subtree_control').write_text('+memory')
                break
            except OSError as error:
                # A concurrent docker exec/health probe can enter the root between
                # draining it and enabling the controller. Drain and retry that
                # specific race; every other setup failure still fails closed.
                if error.errno != errno.EBUSY:
                    raise
        time.sleep(.01)
    else:
        raise SystemExit('Could not drain the container cgroup; refusing unbounded startup')
    (root / 'desktops').mkdir(exist_ok=True)
    (root / 'desktops/cgroup.subtree_control').write_text('+memory')
    os.chmod(root / 'desktops', 0o755)
    print('Per-desktop memory controller ready', flush=True)


if __name__ == '__main__':
    main()
