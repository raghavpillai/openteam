#!/usr/bin/env python3
"""Run the actual legacy reset against an isolated iOS simulator Keychain."""
import argparse
from pathlib import Path
import plistlib
import subprocess
import time

parser = argparse.ArgumentParser()
parser.add_argument('--simulator', required=True)
parser.add_argument('--output', required=True)
args = parser.parse_args()
root = Path(__file__).resolve().parents[3]
out = Path(args.output).resolve()
app = out / 'KeychainAudit.app'
app.mkdir(parents=True, exist_ok=True)
identifier = 'dev.openteam.keychain-reset-audit'

def run(*command, **kwargs):
    return subprocess.run(command, check=True, **kwargs)

sdk = subprocess.check_output(['xcrun', '--sdk', 'iphonesimulator', '--show-sdk-path'], text=True).strip()
# Only the error wrapper is substituted; all Security queries use the production helper.
stub = out / 'KeychainErrorStub.swift'
stub.write_text('struct APIError: Error { let message: String; init(_ message: String) { self.message = message } }\n')
entitlements = out / 'KeychainAudit.entitlements'
entitlements.write_bytes(plistlib.dumps({'application-identifier': 'LZWN2FF7YB.' + identifier, 'keychain-access-groups': ['LZWN2FF7YB.' + identifier], 'get-task-allow': True}))
command = ['xcrun', '--sdk', 'iphonesimulator', 'swiftc', '-sdk', sdk, '-target', 'arm64-apple-ios18.0-simulator', '-parse-as-library', str(root / 'apps/ios/Sources/Core/LegacySecureStorage.swift'), str(root / 'apps/ios/scripts/audit-legacy-keychain.swift'), str(stub), '-o', str(app / 'KeychainAudit')]
# Like Xcode, simulator entitlements are embedded in the executable, not its ad-hoc signature.
for value in ['-sectcreate', '__TEXT', '__entitlements', str(entitlements)]:
    command.extend(['-Xlinker', value])
run(*command)
(app / 'Info.plist').write_bytes(plistlib.dumps({'CFBundleExecutable': 'KeychainAudit', 'CFBundleIdentifier': identifier, 'CFBundleName': 'Keychain Audit', 'CFBundlePackageType': 'APPL', 'CFBundleVersion': '1', 'CFBundleShortVersionString': '1.0', 'LSRequiresIPhoneOS': True, 'MinimumOSVersion': '18.0', 'UIDeviceFamily': [1, 2], 'UILaunchScreen': {}}))
run('codesign', '--force', '--sign', '-', str(app))
run('xcrun', 'simctl', 'install', args.simulator, str(app))
try:
    container = Path(subprocess.check_output(['xcrun', 'simctl', 'get_app_container', args.simulator, identifier, 'data'], text=True).strip())
    result = container / 'Documents/result.txt'
    result.unlink(missing_ok=True)
    run('xcrun', 'simctl', 'launch', args.simulator, identifier)
    for _ in range(40):
        if result.exists():
            break
        time.sleep(0.25)
    value = result.read_text() if result.exists() else 'FAIL: audit did not complete'
    (out / 'keychain-audit-accepted.log').write_text(value + '\n')
    assert value == 'PASS', value
    print('PASS: legacy Keychain reset preserves unrelated namespaces')
finally:
    subprocess.run(['xcrun', 'simctl', 'terminate', args.simulator, identifier], capture_output=True)
    run('xcrun', 'simctl', 'uninstall', args.simulator, identifier)
