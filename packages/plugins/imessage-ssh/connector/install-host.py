#!/usr/bin/env python3
"""One-time Linux deployment provisioning, not Marketplace account configuration."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import secrets
import shutil
import subprocess


def run(args, **kwargs):
    return subprocess.run(args, check=True, timeout=30, **kwargs)


def install(container):
    root = Path.home() / ".config/openteam-imessage"
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    root.chmod(0o700)
    token_file = root / "token"
    if not token_file.exists():
        with os.fdopen(os.open(token_file, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "w") as file:
            file.write(secrets.token_urlsafe(32))
    token_file.chmod(0o600)
    # Preserve an already provisioned restricted Mac connection during upgrade.
    legacy = root / "config.json"
    if legacy.exists():
        config = json.loads(legacy.read_text())
        target = config["ssh_target"]
        profile = root / "targets" / hashlib.sha256(target.encode()).hexdigest()
        profile.mkdir(parents=True, exist_ok=True, mode=0o700)
        profile_config = profile / "config.json"
        if not profile_config.exists():
            profile_config.write_text(json.dumps(config))
            profile_config.chmod(0o600)
    details = json.loads(run(["docker", "inspect", container], capture_output=True, text=True).stdout)[0]
    gateways = {network["Gateway"] for network in details["NetworkSettings"]["Networks"].values() if network.get("Gateway")}
    if len(gateways) != 1:
        raise ValueError("Expected one private Docker bridge network for the OpenTeam computer")
    bind = gateways.pop()
    source = Path(__file__).parent
    destination = Path.home() / ".local/share/openteam-imessage"
    destination.mkdir(parents=True, exist_ok=True, mode=0o700)
    for name in ("bridge.py", "gateway.py", "reader.py", "install-reader.py"):
        if (source / name).resolve() != (destination / name).resolve():
            shutil.copyfile(source / name, destination / name)
    # Store internal bridge credentials in the persistent computer home, never in
    # the account configuration, plugin archive, command arguments, or tool output.
    config = json.dumps({"endpoint": "http://" + bind + ":8799/mcp", "token": token_file.read_text().strip()})
    program = """import pathlib,sys,os
p=pathlib.Path('/home/box/.config/openteam')
p.mkdir(parents=True,exist_ok=True,mode=0o700)
target=p/'imessage-bridge.json'
with os.fdopen(os.open(target,os.O_WRONLY|os.O_CREAT|os.O_TRUNC,0o600),'w') as f: f.write(sys.stdin.read())
target.chmod(0o600)
"""
    run(["docker", "exec", "-i", "-u", "1000:1000", container, "python3", "-c", program], input=config, text=True)
    unit = Path.home() / ".config/systemd/user/openteam-imessage.service"
    unit.parent.mkdir(parents=True, exist_ok=True)
    unit.write_text("\n".join([
        "[Unit]", "Description=OpenTeam internal Messages SSH bridge", "After=network-online.target",
        "[Service]", "ExecStart=/usr/bin/python3 " + json.dumps(str(destination / "bridge.py")) +
        " --root " + json.dumps(str(root)) + " --bind " + bind,
        "Restart=on-failure", "RestartSec=3", "UMask=0077", "NoNewPrivileges=true",
        "[Install]", "WantedBy=default.target", "",
    ]))
    run(["systemctl", "--user", "daemon-reload"])
    run(["systemctl", "--user", "enable", "openteam-imessage.service"], stdout=subprocess.DEVNULL)
    run(["systemctl", "--user", "restart", "openteam-imessage.service"])
    run(["systemctl", "--user", "is-active", "--quiet", "openteam-imessage.service"])
    print("Internal Messages bridge installed. Marketplace needs only the Mac's user@host.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--computer-container", default="openteam-computer-1")
    install(parser.parse_args().computer_container)
