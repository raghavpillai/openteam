#!/usr/bin/env python3
"""Host-managed SSH bridge. Marketplace clients provide only a user@host target."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess
import threading

from gateway import Gateway, make_server


def validate_target(target):
    if not isinstance(target, str) or len(target) > 255 or not re.fullmatch(
        r"[A-Za-z0-9_][A-Za-z0-9_.-]*@[A-Za-z0-9][A-Za-z0-9.-]*", target
    ):
        raise ValueError("Enter an SSH destination such as yourname@100.64.0.10")
    return target


class TargetGateway(Gateway):
    def __init__(self, bridge, target):
        self.bridge, self.target = bridge, target

    def execute(self, operation, arguments):
        try:
            return self.bridge.connection(self.target).execute(operation, arguments)
        except (OSError, ValueError, subprocess.SubprocessError):
            return {"error": "ssh_setup_required", "message":
                    "The OpenTeam host could not set up this Mac. Check passwordless SSH, "
                    "the verified host key in the host user's ~/.ssh/known_hosts, Python 3, "
                    "and Messages disk access. No password or SSH key belongs in Marketplace."}


class Bridge:
    def __init__(self, root):
        self.root = Path(root).resolve()
        token_file = self.root / "token"
        if token_file.stat().st_mode & 0o077:
            raise ValueError("Bridge token must be private")
        self.token = token_file.read_text().strip()
        if len(self.token) < 32 or not self.token.isascii() or any(c.isspace() for c in self.token):
            raise ValueError("Invalid bridge token")
        self.lock = threading.Lock()
        self.connections = {}

    def for_target(self, target):
        return TargetGateway(self, validate_target(target))

    def connection(self, target):
        validate_target(target)
        with self.lock:
            if target in self.connections:
                return self.connections[target]
            directory = self.root / "targets" / hashlib.sha256(target.encode()).hexdigest()
            directory.mkdir(parents=True, exist_ok=True, mode=0o700)
            config_file = directory / "config.json"
            if config_file.exists():
                config = json.loads(config_file.read_text())
                if config.get("ssh_target") != target:
                    raise ValueError("Target mismatch")
            else:
                config = self.provision(target, directory)
                config_file.write_text(json.dumps(config))
                config_file.chmod(0o600)
            connection = Gateway(config)
            self.connections[target] = connection
            return connection

    def provision(self, target, directory):
        """Use existing host SSH access once, then use a restricted per-target key."""
        key = directory / "id_ed25519"
        if not key.exists():
            subprocess.run(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", str(key)],
                           check=True, timeout=10, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        host = target.split("@", 1)[1]
        known_hosts = Path.home() / ".ssh/known_hosts"
        pin = subprocess.run(["ssh-keygen", "-F", host, "-f", str(known_hosts)],
                             capture_output=True, check=True, timeout=5).stdout
        if not pin:
            raise ValueError("Verify the Mac host key on the VM first")
        pinned = directory / "known_hosts"
        pinned.write_bytes(pin)
        pinned.chmod(0o600)
        source = Path(__file__).parent
        # Only packaged source and the generated PUBLIC key cross this connection.
        payload = {"reader": (source / "reader.py").read_text(),
                   "installer": (source / "install-reader.py").read_text(),
                   "public_key": key.with_suffix(".pub").read_text()}
        script = """import json,tempfile,pathlib,importlib.util
p=json.loads(PAYLOAD)
with tempfile.TemporaryDirectory() as temp:
 root=pathlib.Path(temp)
 (root/'reader.py').write_text(p['reader'])
 (root/'install-reader.py').write_text(p['installer'])
 spec=importlib.util.spec_from_file_location('reader',root/'reader.py')
 reader=importlib.util.module_from_spec(spec); spec.loader.exec_module(reader)
 reader.execute({'operation':'status','arguments':{}})
 spec=importlib.util.spec_from_file_location('installer',root/'install-reader.py')
 installer=importlib.util.module_from_spec(spec); spec.loader.exec_module(installer)
 installer.install(p['public_key'])
 print('ready')
""".replace("PAYLOAD", repr(json.dumps(payload)))
        subprocess.run(["ssh", "-T", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes",
                        "-o", "UserKnownHostsFile=" + str(pinned), "-o", "ConnectTimeout=8",
                        "-o", "ForwardAgent=no", "-o", "ClearAllForwardings=yes",
                        target, "/usr/bin/python3 -"], input=script.encode(), check=True,
                       timeout=25, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        return {"ssh_target": target, "identity_file": str(key),
                "known_hosts_file": str(pinned), "token_file": str(self.root / "token")}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--bind", required=True)
    parser.add_argument("--port", type=int, default=8799)
    args = parser.parse_args()
    server = make_server(Bridge(args.root), args.bind, args.port)
    try:
        server.serve_forever()
    finally:
        server.server_close()
