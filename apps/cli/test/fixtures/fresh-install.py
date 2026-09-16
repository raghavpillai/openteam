"""Exercise the real release binary and installer in an empty Linux home.

Only release download URLs are redirected to fixture assets. Docker commands use
real executables and a separate empty engine, never the host's Docker socket.
The successful setup uses a tiny Compose fixture and cancels before account setup.
"""
import errno
import fcntl
import hashlib
import http.server
import json
import os
from pathlib import Path
import pty
import re
import select
import shutil
import signal
import struct
import subprocess
import termios
import threading
import time

BASE = Path('/home/tester')
TOOLS = BASE / 'download-tools'
TOOLS.mkdir()
# Preserve real curl, including file transfer and failure behavior. Do not add a
# production URL override or weaken the installer's checksum verification.
(TOOLS / 'curl').write_text('''#!/usr/bin/python3
import os,sys
from pathlib import Path
args=sys.argv[1:]
for i,arg in enumerate(args):
 if arg.startswith('https://'):
  name='latest.json' if arg.endswith('/releases/latest') else arg.rsplit('/',1)[-1]
  if os.environ.get('FRESH_BAD_CHECKSUM') and name=='SHA256SUMS': name='bad-checksums'
  if os.environ.get('FRESH_RAW_ONLY') and name.endswith('.gz'): sys.exit(22)
  path=Path('/fixtures/assets')/name
  if not path.is_file(): sys.exit(22)
  args[i]=path.as_uri()
os.execv('/usr/bin/curl',['curl',*args])
''')
(TOOLS / 'curl').chmod(0o755)
binary_asset = next(p for p in Path('/fixtures/assets').glob('openteam-linux-*') if p.suffix != '.gz')
ansi = re.compile(r'\x1b\[[0-?]*[ -/]*[@-~]')
passed = []

def check(condition, message, output=''):
    if not condition:
        raise AssertionError(message + '\n' + output[-12000:])

def environment(name, docker=False, compose=False):
    directory = BASE / name
    directory.mkdir()
    tools = directory / 'tools'
    tools.mkdir()
    if docker:
        (tools / 'docker').symlink_to('/opt/docker/docker')
    config = directory / 'docker-config'
    config.mkdir()
    if compose:
        plugins = config / 'cli-plugins'
        plugins.mkdir()
        (plugins / 'docker-compose').symlink_to('/opt/docker/docker-compose')
    env = {**os.environ, 'PATH': f'{tools}:{TOOLS}:/usr/bin:/bin',
           'DOCKER_CONFIG': str(config), 'DOCKER_HOST': 'tcp://engine:2375',
           'TERM': 'xterm-256color', 'NO_COLOR': '1', 'OPENTEAM_VERSION': '0.0.1',
           'OPENTEAM_BIN_DIR': str(directory / 'bin')}
    return directory, env

def execute(args, env, terminal=False, columns=80, cancel_at=None, timeout=45):
    if not terminal:
        process = subprocess.run(args, env=env, stdin=subprocess.DEVNULL,
                                 stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=timeout)
        return process.returncode, process.stdout.decode(errors='replace')
    pid, master = pty.fork()
    if pid == 0:
        fcntl.ioctl(0, termios.TIOCSWINSZ, struct.pack('HHHH', 30, columns, 0, 0))
        os.execvpe(args[0], args, env)
    output = b''
    deadline = time.monotonic() + timeout
    cancelled = False
    try:
        while time.monotonic() < deadline:
            ready, _, _ = select.select([master], [], [], .1)
            if ready:
                try:
                    data = os.read(master, 65536)
                except OSError as error:
                    if error.errno == errno.EIO: break
                    raise
                if not data: break
                output += data
                if cancel_at and cancel_at.lower() in ansi.sub('', output.decode(errors='replace')).lower() and not cancelled:
                    time.sleep(.1)
                    os.write(master, b'\x1b')
                    cancelled = True
        else:
            os.killpg(pid, signal.SIGKILL)
            raise AssertionError('CLI timed out\n' + output.decode(errors='replace')[-10000:])
    finally:
        os.close(master)
        _, status = os.waitpid(pid, 0)
    if cancel_at: check(cancelled, 'The setup screen did not appear', output.decode(errors='replace'))
    return os.waitstatus_to_exitcode(status), output.decode(errors='replace')

def record(name, output):
    passed.append(name)
    print(f'PASS {name}\n{ansi.sub("", output).strip()}\n', flush=True)

def bootstrap(name, env_options=None, terminal=False, raw=False, bad=False, columns=80):
    directory, env = environment(name, **(env_options or {}))
    if raw: env['FRESH_RAW_ONLY'] = '1'
    if bad: env['FRESH_BAD_CHECKSUM'] = '1'
    installation = directory / 'installation'
    code, output = execute(['/bin/sh', '/fixtures/install.sh', '--dir', str(installation)], env, terminal, columns)
    cli = directory / 'bin/openteam'
    check(code == (1 if bad else 2), 'Wrong bootstrap exit code', output)
    if bad:
        check(not cli.exists() and 'checksum did not match' in output, 'Bad binary was installed', output)
    else:
        check(cli.is_file() and os.access(cli, os.X_OK), 'CLI was not installed', output)
        check(hashlib.sha256(cli.read_bytes()).digest() == hashlib.sha256(binary_asset.read_bytes()).digest(), 'CLI checksum changed')
        check('OpenTeam CLI installed at' in output and 'Server setup paused' in output, 'Missing installed/paused distinction', output)
        check('The docker command was not found' in ' '.join(output.split()), 'Missing Docker diagnosis', output)
        check('Install Docker Engine' in ' '.join(output.split()), 'Missing recovery instructions', output)
    check(not installation.exists(), 'Preflight wrote server configuration')
    record(name, output)
    return directory, env, cli

directory, env, cli = bootstrap('missing-docker-piped')
bootstrap('missing-docker-tty-40', terminal=True, columns=40)
bootstrap('raw-download-fallback', raw=True)
bootstrap('checksum-mismatch', bad=True)
for command in ['--version', '--help']:
    code, output = execute([str(cli), command], env)
    check(code == 0, 'Installed CLI unusable without Docker', output)
    record('cli-' + command.lstrip('-'), output)
for command in ['install', 'setup', 'doctor']:
    target = directory / (command + '-installation')
    code, output = execute([str(cli), command, '--dir', str(target)], env)
    check(code == 2 and 'Install Docker Engine' in ' '.join(output.split()), 'Missing Docker did not block ' + command, output)
    check(not target.exists(), 'Missing Docker changed installation')
    record(command + '-without-docker', output)

scenarios = [
    ('engine-stopped', {'DOCKER_HOST': 'unix:///tmp/engine-not-running.sock'}, True, 'Start your Docker runtime'),
    ('engine-permission', {'DOCKER_HOST': 'unix:///root/inaccessible.sock'}, True, 'your user has access'),
    ('context-missing', {'DOCKER_CONTEXT': 'missing-test-context'}, True, 'docker context use'),
    ('cli-not-executable', {}, True, "executable's permissions"),
    ('compose-missing', {}, False, '2.20.0 or newer'),
]
for name, overrides, compose, expected in scenarios:
    directory, env = environment(name, docker=True, compose=compose)
    env.update(overrides)
    if 'DOCKER_CONTEXT' in overrides:
        env.pop('DOCKER_HOST', None)
    if name == 'cli-not-executable':
        executable = directory / 'tools/docker'
        executable.unlink()
        shutil.copyfile('/opt/docker/docker', executable)
        executable.chmod(0o644)
    for command in ['install', 'setup']:
        target = directory / command
        code, output = execute([str(cli), command, '--dir', str(target)], env)
        check(code == 2 and expected in ' '.join(output.split()), 'Bad diagnosis for ' + name, output)
        check(not target.exists(), 'Failed preflight wrote installation files')
        record(name + '-' + command, output)

# Existing, incomplete setup must check Docker before reading credentials or
# starting any Compose commands. Files are synthetic and never printed.
directory, env = environment('resume-missing-docker')
target = directory / 'installation'
target.mkdir()
files = {'installation.json': json.dumps({'schemaVersion': 1, 'repository': 'example/test', 'version': '0.0.1', 'composeUrl': 'https://example.test/compose.yaml', 'installedAt': '2026-01-01T00:00:00Z', 'updatedAt': '2026-01-01T00:00:00Z'}),
         'compose.yaml': 'name: openteam\nservices: {}\n', '.env': '# untouched fixture\n'}
for name, body in files.items(): (target / name).write_text(body)
code, output = execute([str(cli), 'setup', '--dir', str(target)], env)
check(code == 2 and 'Install Docker Engine' in ' '.join(output.split()), 'Resumed setup missed preflight', output)
check(all((target / name).read_text() == body for name, body in files.items()), 'Resumed setup changed files')
record('resume-missing-docker', output)

directory, env = environment('healthy-engine', docker=True, compose=True)
code, output = execute([str(cli), 'doctor', '--dir', str(directory / 'installation')], env)
check(code == 0 and 'SETUP NEEDED' in output, 'Fresh engine failed doctor', output)
record('fresh-engine-doctor', output)
code, output = execute([str(cli), 'setup', '--dir', str(directory / 'installation')], env)
check(code == 2 and 'interactive terminal' in output, 'Noninteractive setup was not actionable', output)
check(not (directory / 'installation').exists(), 'Noninteractive setup downloaded server configuration')
record('noninteractive-setup', output)

# The real CLI validates/downloads a test Compose bundle, pulls one tiny image
# into the isolated engine, and reaches its interactive first-run screen.
class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs): super().__init__(*args, directory='/fixtures/assets', **kwargs)
    def log_message(self, *_): pass
server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
threading.Thread(target=server.serve_forever, daemon=True).start()
url = f'http://127.0.0.1:{server.server_port}'
try:
    code, output = execute([str(cli), 'install', '--dir', str(directory / 'installation'),
        '--compose-url', url + '/openteam-compose.yaml', '--checksum-url', url + '/SHA256SUMS',
        '--allow-unsigned'], env, terminal=True, cancel_at='Username', timeout=120)
    check(code == 0 and 'cancelled' in output.lower(), 'Could not cancel fresh setup', output)
    check((directory / 'installation/installation.json').is_file(), 'Fresh setup did not install configuration', output)
    record('fresh-install-and-cancel', output)
    code, output = execute([str(cli), 'setup', '--dir', str(directory / 'installation')],
                          env, terminal=True, cancel_at='Username')
    check(code == 0 and 'cancelled' in output.lower(), 'Could not resume and cancel setup', output)
    record('resume-setup-and-cancel', output)
finally:
    server.shutdown()
code, output = execute(['/opt/docker/docker', 'ps', '-aq'], env)
check(code == 0 and not output.strip(), 'Setup started containers before confirmation', output)
record('no-services-started-before-confirmation', 'The isolated engine has no containers.')
print(f'\n{len(passed)} fresh installation checks passed.', flush=True)
