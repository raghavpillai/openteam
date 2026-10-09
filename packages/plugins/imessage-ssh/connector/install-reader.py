#!/usr/bin/env python3
"""Install the reader and authorize one dedicated Ed25519 key to run only that reader."""
import argparse
import base64
from pathlib import Path
import shlex
import shutil


def install(public_key, home=None):
    home = Path(home or Path.home())
    fields = public_key.strip().split()
    if len(fields) < 2 or fields[0] != "ssh-ed25519":
        raise ValueError("Supply a dedicated OpenSSH Ed25519 public key")
    decoded = base64.b64decode(fields[1], validate=True)
    if len(decoded) != 51 or decoded[:19] != b"\x00\x00\x00\x0bssh-ed25519\x00\x00\x00\x20":
        raise ValueError("Invalid Ed25519 public key")
    directory = home / ".local/share/openteam-imessage"
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    target = directory / "reader.py"
    shutil.copyfile(Path(__file__).with_name("reader.py"), target)
    target.chmod(0o700)
    ssh = home / ".ssh"
    ssh.mkdir(mode=0o700, exist_ok=True)
    authorized = ssh / "authorized_keys"
    before = authorized.read_text() if authorized.exists() else ""
    command = "/usr/bin/python3 " + shlex.quote(str(target))
    escaped = command.replace("\\", "\\\\").replace('"', '\\"')
    entry = 'restrict,command="' + escaped + '" ssh-ed25519 ' + fields[1] + " openteam-imessage-readonly"
    matching = [line for line in before.splitlines() if fields[1] in line.split()]
    if matching and matching != [entry]:
        raise ValueError("Key already exists with different restrictions; use a new dedicated key")
    if not matching:
        with authorized.open("a") as output:
            if before and not before.endswith("\n"):
                output.write("\n")
            output.write(entry + "\n")
        authorized.chmod(0o600)
    return target


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--public-key", type=Path, required=True)
    args = parser.parse_args()
    print("Installed restricted reader:", install(args.public_key.read_text()))
