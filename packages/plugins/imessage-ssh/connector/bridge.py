#!/usr/bin/env python3
"""Host-managed SSH bridge. Marketplace clients provide only a user@host target."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess
import threading

from gateway import Gateway, TOOLS, make_server
from reader import PROTOCOL


def validate_target(target):
    if not isinstance(target, str) or len(target) > 255 or not re.fullmatch(
        r"[A-Za-z0-9_][A-Za-z0-9_.-]*@[A-Za-z0-9][A-Za-z0-9.-]*", target
    ):
        raise ValueError("Enter an SSH destination such as yourname@100.64.0.10")
    return target


class TargetGateway(Gateway):
    def __init__(self, bridge, target):
        self.bridge, self.target = bridge, target

    def listed_tools(self):
        try:
            return self.bridge.connection(self.target).listed_tools()
        except (OSError, ValueError, subprocess.SubprocessError):
            return TOOLS

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
        self.current = set()

    def for_target(self, target):
        return TargetGateway(self, validate_target(target))

    def connection(self, target):
        validate_target(target)
        with self.lock:
            directory = self.root / "targets" / hashlib.sha256(target.encode()).hexdigest()
            connection = self.connections.get(target)
            if connection is None:
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
                    self.current.add(target)
                connection = Gateway(config)
                self.connections[target] = connection
            if target not in self.current:
                self.upgrade(target, connection)
            return connection

    def upgrade(self, target, connection):
        """Reinstall an older Mac helper once per bridge process so newer tools work.

        The restricted key can only run the installed reader, so this uses the host's own SSH access, exactly like the
        first connection. If the Mac is unreachable the check repeats on a later request; if reinstalling fails, older
        operations keep working and newer tools report helper_outdated.
        """
        status = connection.execute("status", {})
        if "error" in status:
            return
        if status.get("protocolVersion", status.get("protocol_version", 1)) < PROTOCOL:
            # Reuse this connection's own key and pinned host key: a migrated single-Mac profile keeps them elsewhere.
            config = connection.config
            try:
                self.install(target, Path(config["identity_file"] + ".pub"), Path(config["known_hosts_file"]),
                             allow_send=config.get("allow_send", False))
            except (OSError, ValueError, subprocess.SubprocessError):
                pass
        self.current.add(target)

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
        self.install(target, key.with_suffix(".pub"), pinned)
        return {"ssh_target": target, "identity_file": str(key),
                "known_hosts_file": str(pinned), "token_file": str(self.root / "token")}

    def enable_send(self, target):
        """Explicit administrator action; never invoked by an MCP request or automatic upgrade."""
        connection = self.connection(validate_target(target))
        config = dict(connection.config)
        directory = self.root / "targets" / hashlib.sha256(target.encode()).hexdigest()
        key = Path(config["identity_file"]) if config.get("allow_send") else directory / "id_ed25519_send"
        if not key.exists():
            subprocess.run(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", str(key)],
                           check=True, timeout=10, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        self.install(target, Path(str(key) + ".pub"), Path(config["known_hosts_file"]), allow_send=True)
        config.update(identity_file=str(key), allow_send=True)
        temporary = directory / "config.json.tmp"
        temporary.touch(mode=0o600, exist_ok=True)
        temporary.chmod(0o600)
        temporary.write_text(json.dumps(config))
        temporary.replace(directory / "config.json")
        self.connections.pop(target, None)

    def install(self, target, public_key, known_hosts, allow_send=False):
        """Install the packaged reader and authorize one restricted key, over the host's own SSH access."""
        source = Path(__file__).parent
        # Only packaged source and the PUBLIC key cross this connection.
        payload = {"reader": (source / "reader.py").read_text(),
                   "installer": (source / "install-reader.py").read_text(),
                   "public_key": public_key.read_text(), "allow_send": allow_send}
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
 installer.install(p['public_key'], allow_send=p['allow_send'])
 print('ready')
""".replace("PAYLOAD", repr(json.dumps(payload)))
        subprocess.run(["ssh", "-T", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes",
                        "-o", "UserKnownHostsFile=" + str(known_hosts), "-o", "ConnectTimeout=8",
                        "-o", "ForwardAgent=no", "-o", "ClearAllForwardings=yes",
                        target, "/usr/bin/python3 -"], input=script.encode(), check=True,
                       timeout=25, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--bind")
    parser.add_argument("--enable-send", metavar="USER@HOST", help="Explicitly authorize a new restricted sending key for one Mac")
    parser.add_argument("--port", type=int, default=8799)
    args = parser.parse_args()
    if args.enable_send:
        Bridge(args.root).enable_send(args.enable_send)
        print("SSH sending enabled for this target. Restart the host bridge, reconnect the plugin, and check IMessageSendStatus. No message was sent.")
    else:
        if not args.bind:
            parser.error("--bind is required when serving")
        server = make_server(Bridge(args.root), args.bind, args.port)
        try:
            server.serve_forever()
        finally:
            server.server_close()
