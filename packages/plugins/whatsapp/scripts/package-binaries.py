#!/usr/bin/env python3
"""Restore the pinned packaged binaries; never called during plugin installation."""
import hashlib
import io
import json
from pathlib import Path, PurePosixPath
import tarfile
import subprocess
from urllib.request import urlopen

root = Path(__file__).resolve().parents[1]
release = json.loads((root / "connector/release.json").read_text())
for key, item in release["binaries"].items():
    archive = urlopen(item["releaseArchive"], timeout=60).read()
    if hashlib.sha256(archive).hexdigest() != item["releaseArchiveSha256"]:
        raise SystemExit(f"Release archive checksum mismatch: {key}")
    with tarfile.open(fileobj=io.BytesIO(archive), mode="r:gz") as tar:
        member = next(m for m in tar if m.isfile() and PurePosixPath(m.name).name == "wacli")
        binary = tar.extractfile(member).read()
    if len(binary) != item["size"] or hashlib.sha256(binary).hexdigest() != item["sha256"]:
        raise SystemExit(f"Executable checksum mismatch: {key}")
    compressed = subprocess.check_output(["bun", "-e", "import {brotliCompressSync,constants} from 'node:zlib'; const binary=await Bun.stdin.arrayBuffer(); await Bun.write(Bun.stdout,brotliCompressSync(Buffer.from(binary),{params:{[constants.BROTLI_PARAM_QUALITY]:10}}));"], input=binary)
    if hashlib.sha256(compressed).hexdigest() != item["compressedSha256"]:
        raise SystemExit(f"Compressed bytes differ for {key}; use the original Bun/Brotli version or deliberately review a compression-only manifest update.")
    destination = root / item["path"]
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_bytes(compressed)
    print(f"Verified and restored {key}")
