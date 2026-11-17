#!/usr/bin/env python3
"""Regression checks for the computer/helper restart readiness handshake.

Run with Python's standard library; real-kernel restart evidence is separate.
"""
import importlib.util
import os
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

REPO = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('memory_setup', REPO / 'docker/openteam-memory-setup.py')
setup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(setup)
read_starttime = setup.init_starttime


class MemoryReadinessTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.ready = self.root / 'ready'
        (self.root / 'memory.max').write_text('2147483648\n')
        self.ready.write_text('2147483648 12345 98765\n')
        self.ready.chmod(0o600)
        # Host tests need neither root nor Linux namespaces. File opens, modes,
        # no-follow handling and cgroup ceiling reads still use real files.
        real_fstat, real_stat = os.fstat, os.stat
        self.uid = 0
        self.addCleanup(patch.stopall)
        patch.object(setup.os, 'fstat', side_effect=lambda fd: SimpleNamespace(
            st_mode=real_fstat(fd).st_mode, st_uid=self.uid)).start()
        patch.object(setup, 'init_starttime', return_value=98765).start()
        patch.object(setup.os, 'stat', side_effect=lambda path, *a, **kw:
                     SimpleNamespace(st_ino=12345) if str(path) == '/proc/1/ns/mnt'
                     else real_stat(path, *a, **kw)).start()

    def test_current_namespace_and_finite_ceiling_are_required(self):
        self.assertTrue(setup.helper_ready(self.root, self.ready))
        for ceiling in ('max\n', '0\n', '1073741824\n'):
            with self.subTest(ceiling=ceiling):
                (self.root / 'memory.max').write_text(ceiling)
                self.assertFalse(setup.helper_ready(self.root, self.ready))

    def test_stale_legacy_and_malformed_markers_fail_closed(self):
        for marker in ('2147483648\n', '2147483648 12345\n',
                       '2147483648 12345 98764\n', '2147483648 12345 0\n', '2147483648 12344 98765\n', '',
                       '0 12345 98765\n', '-1 12345 98765\n', 'max 12345 98765\n',
                       '2147483648 12345 98765 extra\n', '2147483648 12345 98765',
                       '+2147483648 12345 98765\n', '2147483648 012345 98765\n',
                       '2147483648 12345 98765\n' + ' ' * 200):
            with self.subTest(marker=marker):
                self.ready.write_text(marker)
                self.assertFalse(setup.helper_ready(self.root, self.ready))
        self.ready.write_bytes(b'\xff\xfe')
        self.assertFalse(setup.helper_ready(self.root, self.ready))

    def test_requires_root_owned_private_regular_file_without_symlinks(self):
        self.uid = 1000
        self.assertFalse(setup.helper_ready(self.root, self.ready))
        self.uid = 0
        for mode in (0o644, 0o400, 0o1600):
            self.ready.chmod(mode)
            self.assertFalse(setup.helper_ready(self.root, self.ready))
        self.ready.chmod(0o600)
        link = self.root / 'link'
        link.symlink_to(self.ready)
        self.assertFalse(setup.helper_ready(self.root, link))
        fifo = self.root / 'fifo'
        os.mkfifo(fifo, 0o600)
        self.assertFalse(setup.helper_ready(self.root, fifo))
        self.assertFalse(setup.helper_ready(self.root, self.root))
        self.ready.unlink()
        self.assertFalse(setup.helper_ready(self.root, self.ready))

    def test_stale_marker_waits_before_touching_cgroups_then_accepts_fresh_helper(self):
        (self.root / 'cgroup.controllers').write_text('memory\n')
        (self.root / 'cgroup.procs').write_text('')
        self.ready.write_text('2147483648 12344 98765\n')
        with patch.object(setup, 'Path', side_effect=lambda p:
                          self.root if p == '/sys/fs/cgroup' else self.ready), \
             patch.dict(os.environ, OPENTEAM_DESKTOP_MEMORY_LIMIT='512m'):
            def publish_after_wait(seconds):
                self.assertEqual(seconds, .1)
                self.assertFalse((self.root / 'supervisor').exists())
                self.ready.write_text('2147483648 12345 98765\n')
            with patch.object(setup.time, 'sleep', side_effect=publish_after_wait) as sleep:
                setup.main()
            sleep.assert_called_once_with(.1)
        self.assertTrue((self.root / 'supervisor').is_dir())
        self.assertEqual((self.root / 'desktops/cgroup.subtree_control').read_text(), '+memory')

    def test_wait_is_bounded_and_does_not_touch_cgroups_without_helper(self):
        (self.root / 'cgroup.controllers').touch()
        with patch.object(setup, 'Path', return_value=self.root), \
             patch.dict(os.environ, OPENTEAM_DESKTOP_MEMORY_LIMIT='512m'), \
             patch.object(setup, 'helper_ready', return_value=False), \
             patch.object(setup.time, 'monotonic', side_effect=[0, 0, 60]), \
             patch.object(setup.time, 'sleep') as sleep:
            with self.assertRaisesRegex(SystemExit, 'helper did not become ready'):
                setup.main()
            sleep.assert_called_once_with(.1)
        self.assertFalse((self.root / 'supervisor').exists())

    def test_no_desktop_limit_skips_readiness_for_one_off_commands(self):
        with patch.dict(os.environ, {}, clear=True), patch.object(setup, 'Path') as path:
            setup.main()
            path.assert_not_called()

    def test_pid1_starttime_parser_handles_spaces_and_parentheses_in_comm(self):
        for comm in ('tini', 'a name (with) parentheses)'):
            contents = '1 (' + comm + ') S ' + ' '.join(['0'] * 18 + ['98765', '0']) + '\n'
            with self.subTest(comm=comm), patch.object(setup, 'Path') as path:
                path.return_value.read_text.return_value = contents
                self.assertEqual(read_starttime(), 98765)

    def test_c_publisher_uses_the_entered_namespace_and_publishes_after_cap_drop(self):
        source = (REPO / 'docker/openteam-memory-init.c').read_text()
        self.assertIn('fstat(fd, &namespace)', source)
        self.assertLess(source.index('fstat(fd, &namespace)'), source.index('setns(fd, CLONE_NEWNS)'))
        publish = source.index('dprintf(ready_fd, "%llu %llu %llu\\n", budget, (unsigned long long)namespace.st_ino, starttime)')
        self.assertLess(source.index('write_limit("/sys/fs/cgroup/memory.swap.max", 0)'), publish)
        self.assertLess(source.index('syscall(SYS_capset, &header, data)'), publish)
        self.assertLess(source.index('prctl(PR_SET_NO_NEW_PRIVS'), publish)
        self.assertLess(source.index('mkstemp(ready)'), publish)
        self.assertIn('rename(ready, "/tmp/openteam-memory-ready")', source)


if __name__ == '__main__':
    unittest.main()
