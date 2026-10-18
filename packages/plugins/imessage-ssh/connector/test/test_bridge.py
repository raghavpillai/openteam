import base64
import hashlib
import json
import os
import sqlite3
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch
from urllib.error import HTTPError

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import bridge
import gateway
import server as stdio
from test_protocol2 import build_messages


class BridgeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        token = self.root / 'token'
        token.write_text('x' * 40)
        token.chmod(0o600)
        self.bridge = bridge.Bridge(self.root)
        self.http = gateway.make_server(self.bridge, port=0)
        self.thread = threading.Thread(target=self.http.serve_forever, daemon=True)
        self.thread.start()
        self.config = self.root / 'client.json'
        self.config.write_text(json.dumps({'endpoint': 'http://127.0.0.1:%s/mcp' % self.http.server_port, 'token': 'x' * 40}))
        self.config.chmod(0o600)

    def tearDown(self):
        self.http.shutdown()
        self.http.server_close()
        self.thread.join()
        self.temp.cleanup()

    def test_invalid_destinations_never_reach_ssh(self):
        for target in ('-oProxyCommand=x@mac', 'user@mac;id', 'user@mac/path', 'user@mac\n', 'mac', 'user@$(id)'):
            with self.assertRaises(ValueError):
                stdio.Client(target, self.config)

    def test_single_target_routes_authenticated_reads(self):
        client = stdio.Client('user@mac', self.config)
        with patch.object(self.bridge, 'connection') as connection:
            connection.return_value.execute.return_value = {'readable': True}
            client.check()
            connection.assert_called_once_with('user@mac')
            connection.return_value.execute.assert_called_once_with('status', {})

    def test_failed_ssh_does_not_pass_connect_check(self):
        client = stdio.Client('user@mac', self.config)
        with patch.object(self.bridge, 'connection', side_effect=OSError('secret stderr')):
            with self.assertRaises(ValueError):
                client.check()

    def test_wrong_internal_token_cannot_provision(self):
        client = stdio.Client('user@mac', self.config)
        client.config['token'] = 'wrong'
        with patch.object(self.bridge, 'connection') as connection:
            with self.assertRaises(HTTPError) as caught:
                client.check()
            caught.exception.close()
            connection.assert_not_called()

    def test_target_profiles_do_not_reuse_a_different_mac(self):
        directory = self.root / 'targets' / hashlib.sha256(b'user@mac').hexdigest()
        directory.mkdir(parents=True)
        (directory / 'config.json').write_text(json.dumps({'ssh_target': 'other@mac'}))
        with self.assertRaises(ValueError):
            self.bridge.connection('user@mac')

    def test_provision_uses_verified_host_fixed_python_and_public_key_only(self):
        directory = self.root / 'profile'
        directory.mkdir()
        (directory / 'id_ed25519').write_text('PRIVATE SENTINEL')
        (directory / 'id_ed25519.pub').write_text('PUBLIC SENTINEL')
        commands = []
        def run(command, **kwargs):
            commands.append(command)
            if command[0] == 'ssh-keygen':
                return subprocess.CompletedProcess(command, 0, b'mac ssh-ed25519 known')
            self.assertIn('StrictHostKeyChecking=yes', command)
            self.assertEqual(command[-2:], ['user@mac', '/usr/bin/python3 -'])
            self.assertIn(b'PUBLIC SENTINEL', kwargs['input'])
            self.assertNotIn(b'PRIVATE SENTINEL', kwargs['input'])
            self.assertIn(b"reader.execute", kwargs['input'])
            return subprocess.CompletedProcess(command, 0)
        with patch.object(bridge.subprocess, 'run', side_effect=run):
            config = self.bridge.provision('user@mac', directory)
        self.assertEqual(config['ssh_target'], 'user@mac')
        self.assertEqual(len(commands), 2)

    def test_stdio_startup_reads_internal_config_and_checks_mac(self):
        home = self.root / 'home'
        directory = home / '.config/openteam'
        directory.mkdir(parents=True)
        (directory / 'imessage-bridge.json').write_bytes(self.config.read_bytes())
        (directory / 'imessage-bridge.json').chmod(0o600)
        with patch.object(self.bridge, 'connection') as connection:
            connection.return_value.execute.return_value = {'readable': True}
            connection.return_value.listed_tools.return_value = gateway.TOOLS
            result = subprocess.run([sys.executable, stdio.__file__], env={**os.environ, 'HOME': str(home), 'IMESSAGE_SSH_TARGET': 'user@mac'},
                                    input=json.dumps({'jsonrpc': '2.0', 'id': 1, 'method': 'tools/list'}) + '\n', capture_output=True, text=True, timeout=5)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(len(json.loads(result.stdout)['result']['tools']), 7)

    def test_first_connection_installs_reader_and_restricted_key(self):
        mac = self.root / 'mac'
        messages = mac / 'Library/Messages'
        messages.mkdir(parents=True)
        build_messages(messages / 'chat.db')
        directory = self.root / 'new-profile'
        directory.mkdir()
        (directory / 'id_ed25519').write_text('private fixture')
        public = 'ssh-ed25519 ' + base64.b64encode(b'\x00\x00\x00\x0bssh-ed25519\x00\x00\x00\x20' + b'x' * 32).decode()
        (directory / 'id_ed25519.pub').write_text(public)
        original_run = subprocess.run
        def run(command, **kwargs):
            if command[0] == 'ssh-keygen':
                return subprocess.CompletedProcess(command, 0, b'mac ssh-ed25519 known')
            return original_run([sys.executable, '-'], env={**os.environ, 'HOME': str(mac)}, **kwargs)
        with patch.object(bridge.subprocess, 'run', side_effect=run):
            self.bridge.provision('user@mac', directory)
            before = (mac / '.ssh/authorized_keys').read_text()
            self.bridge.provision('user@mac', directory)
        self.assertEqual(before, (mac / '.ssh/authorized_keys').read_text())
        self.assertTrue(before.startswith('restrict,command='))
        self.assertIn(public, before)
        self.assertTrue((mac / '.local/share/openteam-imessage/reader.py').exists())

    def profile(self, target='user@mac'):
        directory = self.root / 'targets' / hashlib.sha256(target.encode()).hexdigest()
        directory.mkdir(parents=True)
        (directory / 'config.json').write_text(json.dumps({'ssh_target': target}))
        return directory

    def test_older_mac_helper_is_reinstalled_once_with_the_existing_key(self):
        self.profile()
        with patch.object(bridge, 'Gateway') as connection, patch.object(self.bridge, 'install') as install, \
                patch.object(self.bridge, 'provision') as provision:
            # A profile migrated from a single-Mac gateway keeps its key outside the target directory.
            connection.return_value.config = {'identity_file': '/legacy/id_ed25519', 'known_hosts_file': '/legacy/known_hosts'}
            connection.return_value.execute.return_value = {'readable': True, 'protocol_version': 1}
            self.bridge.connection('user@mac')
            self.bridge.connection('user@mac')
        install.assert_called_once_with('user@mac', Path('/legacy/id_ed25519.pub'), Path('/legacy/known_hosts'), allow_send=False)
        provision.assert_not_called()  # No new key is generated or authorized.
        connection.return_value.execute.assert_called_once_with('status', {})

    def test_current_helper_is_left_alone_and_unreachable_mac_is_rechecked(self):
        self.profile()
        with patch.object(bridge, 'Gateway') as connection, patch.object(self.bridge, 'install') as install:
            connection.return_value.execute.side_effect = [{'error': 'ssh_unavailable'}, {'protocolVersion': bridge.PROTOCOL}]
            self.bridge.connection('user@mac')
            self.bridge.connection('user@mac')
            self.bridge.connection('user@mac')
        install.assert_not_called()
        self.assertEqual(connection.return_value.execute.call_count, 2)

    def test_failed_reinstall_keeps_the_connection(self):
        self.profile()
        with patch.object(bridge, 'Gateway') as connection, patch.object(self.bridge, 'install', side_effect=subprocess.CalledProcessError(1, 'ssh')):
            connection.return_value.config = {'identity_file': '/k', 'known_hosts_file': '/h'}
            connection.return_value.execute.return_value = {'readable': True}
            self.assertIs(self.bridge.connection('user@mac'), connection.return_value)

    def test_connect_check_falls_back_for_a_bridge_without_new_tools(self):
        client = stdio.Client('user@mac', self.config)
        responses = [{'jsonrpc': '2.0', 'id': 'connect-check', 'error': {'code': -32602, 'message': 'Unknown read-only tool'}},
                     {'jsonrpc': '2.0', 'id': 'connect-check', 'result': {'isError': False, 'content': [{'type': 'text', 'text': '{"readable": true}'}]}}]
        with patch.object(client, 'rpc', side_effect=responses) as rpc:
            client.check()
        self.assertEqual([call.args[0]['params']['name'] for call in rpc.call_args_list], ['IMessageStatus', 'imessage_status'])

    def test_fetched_attachment_lands_on_the_computer(self):
        blocked = self.root / 'blocked'
        blocked.write_text('not a folder')
        folder = self.root / 'attachments'
        folder.mkdir()
        (folder / 'lease.pdf').write_bytes(b'older')
        payload = {'kind': 'fetch-attachment', 'filename': '../lease.pdf', 'mime': 'application/pdf', 'sizeBytes': 4,
                   'bytesBase64': base64.b64encode(b'%PDF').decode()}
        response = {'jsonrpc': '2.0', 'id': 1, 'result': {'isError': False, 'content': [{'type': 'text', 'text': json.dumps(payload)}]}}
        value = json.loads(stdio.land(response, (blocked / 'sub', folder))['result']['content'][0]['text'])
        self.assertEqual(value['path'], str(folder / 'lease (2).pdf'))
        self.assertNotIn('bytesBase64', value)
        self.assertEqual((folder / 'lease (2).pdf').read_bytes(), b'%PDF')
        error = {'jsonrpc': '2.0', 'id': 1, 'result': {'isError': True, 'content': [{'type': 'text', 'text': '{"error": "attachment_unavailable"}'}]}}
        self.assertEqual(stdio.land(error, (folder,)), error)


if __name__ == '__main__':
    unittest.main()
