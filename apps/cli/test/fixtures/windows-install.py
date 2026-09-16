"""Native Windows installer tests (PowerShell 5.1 and 7, compiled CLI, ConPTY).

Downloads go through the real PowerShell HTTP client to local fixture assets.
Docker preflight responses are explicitly simulated; this is not a server-stack test.
Every installation uses a temporary directory; user PATH is restored afterward.
"""
import functools
import hashlib
import http.server
import json
import os
from pathlib import Path
import re
import select
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import winreg

import pyte
from winpty import Backend, PtyProcess

sys.stdout.reconfigure(encoding='utf-8')
sys.stderr.reconfigure(encoding='utf-8')

OUTPUT = Path(sys.argv[1]).resolve()
ASSETS = OUTPUT / 'assets'
PASSED = []
KEYS = {'escape': '\x1b', 'enter': '\r', 'letter': 'x', 'space': ' ',
        'ctrl-c': '\x03', 'arrow': '\x1b[A', 'paste': 'cancel pasted text\r'}
SHELLS = [shutil.which(name) for name in ('powershell.exe', 'pwsh.exe')]
assert all(SHELLS), 'Both Windows PowerShell 5.1 and PowerShell 7 are required'
ANSI = re.compile(r'\x1b\[[0-?]*[ -/]*[@-~]')


def check(condition, message, output=''):
    if not condition:
        raise AssertionError(message + '\n' + output[-14000:])


def record(name, output):
    PASSED.append(name)
    (OUTPUT / (name + '.log')).write_text(output, encoding='utf-8')
    (OUTPUT / 'results.json').write_text(json.dumps(PASSED, indent=2), encoding='utf-8')
    print('PASS ' + name, flush=True)


def execute(args, env, terminal=False, key=None, columns=100, timeout=35):
    if not terminal:
        result = subprocess.run(args, env=env, stdin=subprocess.DEVNULL,
                                stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=timeout)
        return result.returncode, result.stdout.decode('utf-8', errors='replace'), set()
    child = PtyProcess.spawn(args, env=env, dimensions=(35, columns), backend=Backend.ConPTY)
    screen = pyte.Screen(columns, 35)
    stream = pyte.Stream(screen)
    transcript, visible, steps = '', '', set()
    sent = False
    deadline = time.monotonic() + timeout
    exited_at = None
    try:
        while time.monotonic() < deadline:
            if select.select([child], [], [], .05)[0]:
                try:
                    data = child.read(65536)
                except EOFError:
                    break
                transcript += data
                if '\x1b[6n' in data:
                    child.write('\x1b[1;1R')
                stream.feed(data)
                visible = '\n'.join(screen.display)
                steps.update(re.findall(r'Starting in ([1-5])s', visible))
                if key is not None and not sent and 'Starting in 5s' in visible:
                    child.write(key)
                    sent = True
            if not child.isalive():
                if exited_at is None:
                    exited_at = time.monotonic()
                # ConPTY can outlive its child. Drain, but never wait forever for EOF.
                if time.monotonic() - exited_at > .5:
                    break
        else:
            raise AssertionError('Windows terminal timed out\n' + transcript[-10000:])
        code = child.exitstatus
        check(code is not None, 'Terminal process did not exit', transcript)
        if key is not None:
            check(sent, 'Countdown did not accept keyboard input', transcript)
        return code, transcript + '\nFINAL SCREEN\n' + visible, steps
    finally:
        if child.isalive():
            child.terminate(force=True)
        child.close(force=True)


class Handler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *_):
        pass


server = http.server.ThreadingHTTPServer(
    ('127.0.0.1', 0), functools.partial(Handler, directory=str(ASSETS)))
threading.Thread(target=server.serve_forever, daemon=True).start()
asset_url = f'http://127.0.0.1:{server.server_port}'
# Preserve the account's exact original PATH value/type, including its absence.
with winreg.OpenKey(winreg.HKEY_CURRENT_USER, 'Environment') as registry:
    try:
        original_path = winreg.QueryValueEx(registry, 'Path')
    except FileNotFoundError:
        original_path = None

try:
    # Windows also searches System32 outside PATH. Hosted Windows runners ship
    # Docker there; hide those CLI files only on disposable Actions runners.
    hidden_tools = []
    for name in ('docker.exe', 'docker-compose.exe'):
        candidates = {Path(os.environ['SystemRoot']) / 'System32' / name}
        found = shutil.which(name)
        if found:
            candidates.add(Path(found))
        for executable in candidates:
            if not executable.is_file():
                continue
            check(os.environ.get('GITHUB_ACTIONS') == 'true',
                  'Run this suite on a disposable Windows runner without Docker on PATH.')
            hidden = executable.with_name(executable.name + '.openteam-test-disabled')
            check(not hidden.exists(), 'A previous test already hid ' + str(executable))
            executable.rename(hidden)
            hidden_tools.append((executable, hidden))
            print('Temporarily hiding runner Docker CLI: ' + str(executable), flush=True)
    with tempfile.TemporaryDirectory(prefix='openteam Windows install ') as temporary:
        base = Path(temporary)
        wrapper = base / 'bootstrap.ps1'
        wrapper.write_text(r'''
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding
# The production script supplies all download flags. Only the URL changes.
function Invoke-WebRequest {
  param([string]$Uri, [string]$OutFile, [switch]$UseBasicParsing)
  $name = ($Uri -split '/')[-1]
  if ($env:NATIVE_RAW_ONLY -and $name.EndsWith('.gz')) { throw 'Fixture: gzip unavailable' }
  if ($env:NATIVE_BAD_CHECKSUM -and $name -eq 'SHA256SUMS') { $name = 'bad-checksums' }
  $PSBoundParameters['Uri'] = "$env:NATIVE_ASSET_URL/$name"
  Microsoft.PowerShell.Utility\Invoke-WebRequest @PSBoundParameters
}
Invoke-Expression ([System.IO.File]::ReadAllText($env:NATIVE_INSTALL_SCRIPT))
''', encoding='ascii')
        for shell in SHELLS:
            label = Path(shell).stem
            scenarios = ['missing-docker', 'raw-fallback', 'bad-checksum', 'stopped',
                         'no-compose', 'old-compose', 'noninteractive', 'cancel-escape',
                         'cancel-enter', 'cancel-ctrl-c']
            for scenario in scenarios:
                name = f'{label}-bootstrap-{scenario}'
                directory = base / name
                directory.mkdir()
                installation = directory / 'server'
                bin_directory = directory / 'bin'
                path = os.pathsep.join([str(Path(os.environ['SystemRoot']) / 'System32'), str(Path(shell).parent)])
                if scenario not in ('missing-docker', 'raw-fallback', 'bad-checksum'):
                    path = str(ASSETS) + os.pathsep + path
                # Let each PowerShell edition build its own module path; inheriting the
                # PowerShell 7 runner's module path breaks 5.1's Get-FileHash autoload.
                env = {key: value for key, value in os.environ.items()
                       if key.upper() not in ('PATH', 'PSMODULEPATH')}
                env.update({'PATH': path, 'OPENTEAM_HOME': str(installation),
                            'OPENTEAM_BIN_DIR': str(bin_directory), 'OPENTEAM_VERSION': '0.0.1',
                            'NATIVE_ASSET_URL': asset_url,
                            'NATIVE_INSTALL_SCRIPT': str(OUTPUT / 'install.ps1'),
                            'NATIVE_DOCKER_MODE': scenario, 'TERM': 'xterm-256color',
                            'NO_COLOR': '1'})
                if scenario == 'raw-fallback':
                    env['NATIVE_RAW_ONLY'] = '1'
                if scenario == 'bad-checksum':
                    env['NATIVE_BAD_CHECKSUM'] = '1'
                cancel = scenario.startswith('cancel-')
                code, output, _ = execute(
                    [shell, '-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass',
                     '-File', str(wrapper)], env, terminal=cancel,
                    key=KEYS[scenario.removeprefix('cancel-')] if cancel else None)
                (OUTPUT / (name + '.log')).write_text(output, encoding='utf-8')
                cli = bin_directory / 'openteam.exe'
                cleaned = ' '.join(ANSI.sub('', output).split())
                if scenario == 'bad-checksum':
                    check(code != 0 and not cli.exists() and 'checksum did not match' in cleaned,
                          'Corrupt download was not rejected', output)
                else:
                    check(cli.is_file(), 'CLI was not installed', output)
                    check(hashlib.sha256(cli.read_bytes()).digest() ==
                          hashlib.sha256((ASSETS / 'openteam-windows-x64.exe').read_bytes()).digest(),
                          'Installed CLI differs from verified asset')
                    check('CLI installed' in cleaned and 'Download verified' in cleaned,
                          'Installer progress is missing', output)
                    check(not re.search(r'\\u[0-9a-fA-F]{4}', output),
                          'Installer printed escaped glyphs', output)
                    if cancel:
                        check(code == 0 and 'Setup cancelled' in cleaned and
                              'openteam setup' in cleaned, 'Cancellation was not actionable', output)
                    else:
                        expected = {
                            'missing-docker': 'Install Docker Desktop',
                            'raw-fallback': 'Install Docker Desktop',
                            'stopped': 'Open Docker Desktop',
                            'no-compose': '2.20.0',
                            'old-compose': '2.20.0',
                            'noninteractive': 'interactive terminal',
                        }[scenario]
                        check(code == 2 and expected in cleaned, 'Wrong preflight diagnosis', output)
                        check('Starting in' not in cleaned, 'Preflight failure started countdown', output)
                    version = subprocess.run([str(cli), '--version'], env=env, capture_output=True)
                    check(version.returncode == 0, 'Installed CLI is unusable')
                check(not installation.exists(), 'Blocked/cancelled setup wrote server files', output)
                record(name, output)
            for scenario in [*KEYS, 'continue', 'narrow']:
                name = f'{label}-countdown-{scenario}'
                result_path = base / (name + '.json')
                env = {**os.environ, 'TERM': 'xterm-256color', 'NO_COLOR': '1',
                       'COUNTDOWN_RESULT_PATH': str(result_path)}
                command = f"& '{ASSETS / 'countdown.exe'}'; exit $LASTEXITCODE"
                code, output, steps = execute(
                    [shell, '-NoLogo', '-NoProfile', '-Command', command], env,
                    terminal=True, key=KEYS.get(scenario), columns=40 if scenario == 'narrow' else 100)
                check(code == 0 and result_path.exists(), 'Countdown did not finish cleanly', output)
                result = json.loads(result_path.read_text())
                proceed = scenario in ('continue', 'narrow')
                check(result['proceed'] == proceed, 'Wrong countdown outcome', output)
                check(result['rawRestored'] and result['listenersRestored'],
                      'Countdown left terminal raw mode or input listeners behind', output)
                if proceed:
                    check(4900 <= result['elapsed'] < 7000, 'Countdown was not five seconds', output)
                    check(steps == set('12345'), 'Missing a visible countdown step', output)
                else:
                    check(result['elapsed'] < 2500, 'Keyboard cancellation was delayed', output)
                record(name, output)

finally:
    for executable, hidden in reversed(hidden_tools):
        hidden.rename(executable)
    server.shutdown()
    server.server_close()
    with winreg.OpenKey(winreg.HKEY_CURRENT_USER, 'Environment', 0, winreg.KEY_SET_VALUE) as registry:
        if original_path is None:
            try:
                winreg.DeleteValue(registry, 'Path')
            except FileNotFoundError:
                pass
        else:
            winreg.SetValueEx(registry, 'Path', 0, original_path[1], original_path[0])

print(f'{len(PASSED)} native Windows checks passed.', flush=True)
