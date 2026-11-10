"""Fast validation tests for the private endpoint routing boundary."""
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('computer_network', ROOT / 'docker/openteam-computer-network.py')
network = importlib.util.module_from_spec(spec)
spec.loader.exec_module(network)


class EndpointTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.path = Path(self.directory.name) / 'bridge.json'
        override = patch.object(network, 'HOST_BRIDGE_CONFIG', self.path)
        override.start()
        self.addCleanup(override.stop)

    def configure(self, endpoint, token='fixture-token'):
        self.path.write_text(json.dumps({'endpoint': endpoint, 'token': token}))
        self.path.chmod(0o600)

    def test_numeric_endpoints_and_ports(self):
        for endpoint, expected in [
            ('http://172.18.0.1:8799/mcp', ('-4', '172.18.0.1', '8799')),
            ('https://192.0.2.2/mcp', ('-4', '192.0.2.2', '443')),
            ('http://192.0.2.2/mcp', ('-4', '192.0.2.2', '80')),
            ('http://[fd75::2]:8800/mcp', ('-6', 'fd75::2', '8800')),
            ('http://[::ffff:172.18.0.1]:8799/mcp', ('-4', '172.18.0.1', '8799')),
        ]:
            with self.subTest(endpoint=endpoint):
                self.configure(endpoint)
                self.assertEqual(network.host_bridge_endpoint(), expected)

    def test_invalid_endpoint_never_reserves_a_route(self):
        for endpoint in [
            'http://172.18.0.1:0/mcp', 'http://172.18.0.1:65536/mcp',
            'http://user:password@172.18.0.1:8799/mcp',
            'http://172.18.0.1:8799/mcp?token=value', 'http://172.18.0.1:8799/mcp#value',
            'file:///etc/passwd', 'ftp://172.18.0.1:8799/mcp',
            'http://bridge.example:8799/mcp', 'http://[fe80::1%25eth0]:8799/mcp',
            'http://0.0.0.0:8799/mcp', 'http://224.0.0.1:8799/mcp',
            'http://[::]:8799/mcp', 'http://[ff02::1]:8799/mcp',
        ]:
            with self.subTest(endpoint=endpoint):
                self.configure(endpoint)
                self.assertIsNone(network.host_bridge_endpoint())

    def test_missing_empty_or_invalid_token(self):
        for token in ['', ' ', None, True, 123]:
            with self.subTest(token=token):
                self.configure('http://172.18.0.1:8799/mcp', token)
                self.assertIsNone(network.host_bridge_endpoint())

    def test_missing_malformed_oversized_and_nonobject_files(self):
        self.assertIsNone(network.host_bridge_endpoint())
        for raw in ['{', '[]', 'null', 'false', '{}', '"text"', 'x' * 16385,
                    '[' * 1100 + '0' + ']' * 1100]:
            with self.subTest(raw=raw[:20]):
                self.path.write_text(raw)
                self.path.chmod(0o600)
                self.assertIsNone(network.host_bridge_endpoint())
        self.path.write_bytes(b'\xff')
        self.assertIsNone(network.host_bridge_endpoint())

    def test_permissions_symlinks_directories_and_fifos(self):
        self.configure('http://172.18.0.1:8799/mcp')
        self.path.chmod(0o644)
        self.assertIsNone(network.host_bridge_endpoint())
        self.path.chmod(0o600)
        target = self.path.with_suffix('.target')
        self.path.rename(target)
        self.path.symlink_to(target)
        self.assertIsNone(network.host_bridge_endpoint())
        self.path.unlink()
        self.path.mkdir(mode=0o700)
        self.assertIsNone(network.host_bridge_endpoint())
        self.path.rmdir()
        os.mkfifo(self.path, 0o600)
        self.assertIsNone(network.host_bridge_endpoint())


if __name__ == '__main__':
    unittest.main()
