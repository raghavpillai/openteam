#!/usr/bin/env python3
"""Portable source checks for native iOS signing, transport, and extension wiring."""
import json
import plistlib
from pathlib import Path

root = Path(__file__).resolve().parent.parent
release = json.loads((root / 'release.json').read_text())
package = json.loads((root / 'package.json').read_text())
project = (root / 'OpenTeamNative.xcodeproj/project.pbxproj').read_text()
info = plistlib.loads((root / 'Resources/Info.plist').read_bytes())
entitlements = plistlib.loads((root / 'Resources/OpenTeam.entitlements').read_bytes())
extension = plistlib.loads((root / 'NotificationService/Info.plist').read_bytes())
assert package['version'] == release['version'], 'iOS package and release versions differ'
assert release['buildNumber'].isdigit(), 'Release build number must be numeric'
for value in [release['bundleIdentifier'], release['bundleIdentifier'] + '.notifications', release['teamIdentifier']]:
    assert value in project, f'Missing signing identity: {value}'
assert f'MARKETING_VERSION = "{release["version"]}"' in project
assert f'CURRENT_PROJECT_VERSION = "{release["buildNumber"]}"' in project
assert info['NSAppTransportSecurity'] == {'NSAllowsArbitraryLoads': True}, 'Preserve user-selected HTTP support'
assert 'remote-notification' in info['UIBackgroundModes']
assert entitlements['aps-environment'] == '$(APNS_ENVIRONMENT)'
assert entitlements['keychain-access-groups'] == ['$(AppIdentifierPrefix)$(PRODUCT_BUNDLE_IDENTIFIER)']
assert entitlements['com.apple.developer.usernotifications.communication'] is True
assert extension['NSExtension']['NSExtensionPointIdentifier'] == 'com.apple.usernotifications.service'
for name in ['NotificationService.swift', 'RobotNotificationAvatar.swift', 'RobotArtwork.json']:
    assert (root / 'NotificationService' / name).is_file()
    assert 'NotificationService/' + name in project
for key in ['NSCameraUsageDescription', 'NSMicrophoneUsageDescription', 'NSLocalNetworkUsageDescription', 'NSPhotoLibraryAddUsageDescription']:
    assert info.get(key), f'Missing usage description: {key}'
assert 'NSSpeechRecognitionUsageDescription' not in info
assert '../mobile/' not in project and 'mobile-swift' not in project
for name in ['MessageRenderer.html', 'TextDocumentRenderer.html', 'ComputerVNC.html']:
    assert (root / 'Sources/App/Resources' / name).is_file(), f'Missing generated renderer: {name}'
print(f'iOS native configuration passes (version {release["version"]}, build {release["buildNumber"]}).')
