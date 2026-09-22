#!/usr/bin/env bash
# Native release job on an ephemeral macOS runner. Never prints signing secrets.
set -euo pipefail
[[ "${CI:-}" == "true" ]] || { echo 'Run this signing setup only on an ephemeral CI runner.' >&2; exit 1; }
repo_root="$(cd "$(dirname "$0")/../../.." && pwd)"
cd "$repo_root"
required=(IOS_DISTRIBUTION_P12_BASE64 IOS_DISTRIBUTION_P12_PASSWORD IOS_APP_PROFILE_BASE64 IOS_EXTENSION_PROFILE_BASE64 APP_STORE_CONNECT_KEY_ID APP_STORE_CONNECT_ISSUER_ID APP_STORE_CONNECT_PRIVATE_KEY)
for name in "${required[@]}"; do
  [[ -n "${!name:-}" ]] || { echo "Missing CI secret: $name" >&2; exit 1; }
done
signing_dir="$(mktemp -d "${RUNNER_TEMP:?}/openteam-ios-signing.XXXXXX")"
export SIGNING_DIR="$signing_dir"
keychain="$signing_dir/signing.keychain-db"
keychain_password="$(openssl rand -hex 24)"
cleanup() {
  security delete-keychain "$keychain" >/dev/null 2>&1 || true
  if [[ -f "$signing_dir/profile-paths" ]]; then
    while IFS= read -r profile; do rm -f "$profile"; done < "$signing_dir/profile-paths"
  fi
  rm -rf "$signing_dir"
}
trap cleanup EXIT
python3 - <<'PY'
import base64, os
from pathlib import Path
root = Path(os.environ['SIGNING_DIR'])
for variable, filename in [('IOS_DISTRIBUTION_P12_BASE64', 'distribution.p12'), ('IOS_APP_PROFILE_BASE64', 'app.mobileprovision'), ('IOS_EXTENSION_PROFILE_BASE64', 'extension.mobileprovision')]:
    (root / filename).write_bytes(base64.b64decode(os.environ[variable], validate=True))
(root / 'AuthKey.p8').write_text(os.environ['APP_STORE_CONNECT_PRIVATE_KEY'])
for path in root.iterdir(): path.chmod(0o600)
PY
security create-keychain -p "$keychain_password" "$keychain"
security set-keychain-settings -lut 21600 "$keychain"
security unlock-keychain -p "$keychain_password" "$keychain"
security import "$signing_dir/distribution.p12" -P "$IOS_DISTRIBUTION_P12_PASSWORD" -A -t cert -f pkcs12 -k "$keychain" >/dev/null
security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$keychain_password" "$keychain" >/dev/null
security list-keychains -d user -s "$keychain"
security cms -D -i "$signing_dir/app.mobileprovision" > "$signing_dir/app.plist"
security cms -D -i "$signing_dir/extension.mobileprovision" > "$signing_dir/extension.plist"
python3 - <<'PY'
import json, os, plistlib, shutil
from pathlib import Path
root = Path(os.environ['SIGNING_DIR'])
release = json.loads(Path('apps/ios/release.json').read_text())
profiles = {}
installed = []
destination = Path.home() / 'Library/MobileDevice/Provisioning Profiles'
destination.mkdir(parents=True, exist_ok=True)
for name, suffix in [('app', ''), ('extension', '.notifications')]:
    profile = plistlib.loads((root / (name + '.plist')).read_bytes())
    bundle = release['bundleIdentifier'] + suffix
    assert profile['TeamIdentifier'] == [release['teamIdentifier']], 'Profile signing team mismatch'
    assert profile['Entitlements']['application-identifier'].endswith('.' + bundle), 'Profile bundle mismatch'
    identifier = profile['UUID']
    target = destination / (identifier + '.mobileprovision')
    assert not target.exists(), 'Refusing to replace an existing provisioning profile'
    shutil.copy2(root / (name + '.mobileprovision'), target)
    installed.append(str(target))
    (root / 'profile-paths').write_text('\n'.join(installed) + '\n')
    profiles[bundle] = identifier
    (root / (name + '.uuid')).write_text(identifier)
options = dict(method='app-store-connect', destination='upload', signingStyle='manual',
               signingCertificate='Apple Distribution', teamID=release['teamIdentifier'],
               provisioningProfiles=profiles, manageAppVersionAndBuildNumber=False,
               uploadSymbols=True)
(root / 'ExportOptions.plist').write_bytes(plistlib.dumps(options))
PY
output="${RUNNER_TEMP}/openteam-ios-release"
mkdir -p "$output"
xcodebuild -project apps/ios/OpenTeamNative.xcodeproj -scheme OpenTeamNative \
  -configuration Release -destination 'generic/platform=iOS' \
  -archivePath "$output/OpenTeam.xcarchive" \
  CODE_SIGN_STYLE=Manual CODE_SIGN_IDENTITY='Apple Distribution' \
  APP_PROVISIONING_PROFILE="$(cat "$signing_dir/app.uuid")" \
  EXTENSION_PROVISIONING_PROFILE="$(cat "$signing_dir/extension.uuid")" archive
xcodebuild -exportArchive -archivePath "$output/OpenTeam.xcarchive" \
  -exportPath "$output/export" -exportOptionsPlist "$signing_dir/ExportOptions.plist" \
  -authenticationKeyPath "$signing_dir/AuthKey.p8" \
  -authenticationKeyID "$APP_STORE_CONNECT_KEY_ID" \
  -authenticationKeyIssuerID "$APP_STORE_CONNECT_ISSUER_ID"
echo 'Native iOS archive uploaded to App Store Connect. Processing and tester availability must be checked separately.'
