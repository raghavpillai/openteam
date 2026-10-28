#!/usr/bin/env python3
"""Generate the small Xcode project; no XcodeGen or CocoaPods required. Its only dependencies are
revision-pinned Swift packages (see `packages` below)."""
from pathlib import Path
import hashlib
import json
import plistlib

root = Path(__file__).resolve().parent.parent
release = json.loads((root / 'release.json').read_text())
objects = {}
def uid(name): return hashlib.sha256(name.encode()).hexdigest()[:24].upper()
def add(name, value): objects[uid(name)] = value; return uid(name)
def quote(value):
    if isinstance(value, dict): return '{ ' + ' '.join(f'{k} = {quote(v)};' for k,v in value.items()) + ' }'
    if isinstance(value, list): return '( ' + ', '.join(quote(v) for v in value) + (',' if value else '') + ' )'
    return json.dumps(str(value))

extension = add('extension-ref', dict(isa='PBXFileReference', explicitFileType='wrapper.app-extension', path='OpenTeamNotifications.appex', sourceTree='BUILT_PRODUCTS_DIR'))
app = add('app-ref', dict(isa='PBXFileReference', explicitFileType='wrapper.application', path='OpenTeamNative.app', sourceTree='BUILT_PRODUCTS_DIR'))
test = add('test-ref', dict(isa='PBXFileReference', explicitFileType='wrapper.cfbundle', path='OpenTeamNativeUITests.xctest', sourceTree='BUILT_PRODUCTS_DIR'))
sources = add('sources', dict(isa='PBXFileSystemSynchronizedRootGroup', path='Sources', sourceTree='<group>'))
ui_tests = add('ui-tests', dict(isa='PBXFileSystemSynchronizedRootGroup', path='Tests/UITests', sourceTree='<group>'))
resources = []
resource_refs = []
for path, kind in [('Resources/Assets.xcassets', 'folder.assetcatalog'), ('Resources/PrivacyInfo.xcprivacy', 'text.xml')]:
    ref = add(path, dict(isa='PBXFileReference', lastKnownFileType=kind, path=path, sourceTree='<group>'))
    resources.append(add(path+'-build', dict(isa='PBXBuildFile', fileRef=ref))); resource_refs.append(ref)
products = add('products', dict(isa='PBXGroup', children=[app, test, extension], name='Products', sourceTree='<group>'))
main = add('main', dict(isa='PBXGroup', children=[sources, ui_tests, *resource_refs, products], sourceTree='<group>'))

def configs(name, settings):
    refs = []
    for mode in ['Debug', 'Release']:
        build = dict(settings)
        if name == 'app':
            build.update(APP_DISPLAY_NAME='OpenTeam Swift' if mode == 'Debug' else 'OpenTeam', APP_URL_SCHEME='openteam-swift' if mode == 'Debug' else 'openteam')
            build['ENABLE_TESTABILITY'] = 'YES' if mode == 'Debug' else 'NO'
        if name == 'share':
            build.update(APP_DISPLAY_NAME='OpenTeam Swift' if mode == 'Debug' else 'OpenTeam', APP_BUNDLE_IDENTIFIER='dev.openteam.mobile.swift' if mode == 'Debug' else release['bundleIdentifier'])
        if mode == 'Release' and name in ['app', 'extension', 'share']:
            build.update(PRODUCT_BUNDLE_IDENTIFIER=release['bundleIdentifier'] + {'app': '', 'extension': '.notifications', 'share': '.share'}[name], CURRENT_PROJECT_VERSION=release['buildNumber'], MARKETING_VERSION=release['version'], DEVELOPMENT_TEAM=release['teamIdentifier'], PROVISIONING_PROFILE_SPECIFIER={'app': '$(APP_PROVISIONING_PROFILE)', 'extension': '$(EXTENSION_PROVISIONING_PROFILE)', 'share': '$(SHARE_PROVISIONING_PROFILE)'}[name])
        if name == 'app': build['APNS_ENVIRONMENT'] = 'development' if mode == 'Debug' else 'production'
        build.update({'SWIFT_OPTIMIZATION_LEVEL': '-Onone' if mode == 'Debug' else '-O', 'SWIFT_ACTIVE_COMPILATION_CONDITIONS': 'DEBUG' if mode == 'Debug' else '', 'DEBUG_INFORMATION_FORMAT': 'dwarf' if mode == 'Debug' else 'dwarf-with-dsym'})
        # Swift packages build only the active architecture in Debug; the targets that import them must match.
        if mode == 'Debug': build['ONLY_ACTIVE_ARCH'] = 'YES'
        if name == 'share': build['SWIFT_ACTIVE_COMPILATION_CONDITIONS'] = ('DEBUG ' if mode == 'Debug' else '') + 'SHARE_EXTENSION'
        refs.append(add(name+mode, dict(isa='XCBuildConfiguration', buildSettings=build, name=mode)))
    return add(name+'-config', dict(isa='XCConfigurationList', buildConfigurations=refs, defaultConfigurationIsVisible=0, defaultConfigurationName='Release'))
common = dict(SWIFT_VERSION='6.0', IPHONEOS_DEPLOYMENT_TARGET='18.0', SDKROOT='iphoneos', TARGETED_DEVICE_FAMILY='1,2', CLANG_ENABLE_MODULES='YES', CODE_SIGN_STYLE='Automatic')
project_config = configs('project', common)
app_config = configs('app', dict(CODE_SIGN_ENTITLEMENTS='Resources/OpenTeam.entitlements', PRODUCT_NAME='OpenTeamNative', PRODUCT_BUNDLE_IDENTIFIER='dev.openteam.mobile.swift', INFOPLIST_FILE='Resources/Info.plist', GENERATE_INFOPLIST_FILE='NO', ASSETCATALOG_COMPILER_APPICON_NAME='AppIcon', CURRENT_PROJECT_VERSION='1', MARKETING_VERSION='0.1.0', SWIFT_EMIT_LOC_STRINGS='YES', LD_RUNPATH_SEARCH_PATHS=['$(inherited)', '@executable_path/Frameworks']))
test_config = configs('test', dict(PRODUCT_NAME='$(TARGET_NAME)', PRODUCT_BUNDLE_IDENTIFIER='dev.openteam.mobile.swift.uitests', GENERATE_INFOPLIST_FILE='YES', TEST_TARGET_NAME='OpenTeamNative', LD_RUNPATH_SEARCH_PATHS=['$(inherited)', '@executable_path/Frameworks', '@loader_path/Frameworks']))

def phases(name, resources=[]):
    return [add(name+'-sources', dict(isa='PBXSourcesBuildPhase', buildActionMask=2147483647, files=[], runOnlyForDeploymentPostprocessing=0)), add(name+'-frameworks', dict(isa='PBXFrameworksBuildPhase', buildActionMask=2147483647, files=[], runOnlyForDeploymentPostprocessing=0)), add(name+'-resources', dict(isa='PBXResourcesBuildPhase', buildActionMask=2147483647, files=resources, runOnlyForDeploymentPostprocessing=0))]
app_target = add('app-target', dict(isa='PBXNativeTarget', name='OpenTeamNative', buildConfigurationList=app_config, buildPhases=phases('app', resources), buildRules=[], dependencies=[], fileSystemSynchronizedGroups=[sources], productName='OpenTeamNative', productReference=app, productType='com.apple.product-type.application'))
# Reuse the existing native communication-notification renderer and our desktop
# robot artwork. This extension contains no React Native or Expo runtime.
extension_sources = []
extension_resources = []
for filename, kind in [('NotificationService.swift', 'sourcecode.swift'), ('RobotNotificationAvatar.swift', 'sourcecode.swift'), ('RobotNotificationArtwork.json', 'text.json')]:
    ref = add('notification-'+filename, dict(isa='PBXFileReference', lastKnownFileType=kind, path='NotificationService/'+filename, sourceTree='<group>'))
    objects[main]['children'].append(ref)
    build = add('notification-build-'+filename, dict(isa='PBXBuildFile', fileRef=ref))
    (extension_sources if filename.endswith('.swift') else extension_resources).append(build)
extension_config = configs('extension', dict(PRODUCT_NAME='OpenTeamNotifications', PRODUCT_BUNDLE_IDENTIFIER='dev.openteam.mobile.swift.notifications', INFOPLIST_FILE='NotificationService/Info.plist', GENERATE_INFOPLIST_FILE='NO', CODE_SIGN_ENTITLEMENTS='NotificationService/NotificationService.entitlements', CURRENT_PROJECT_VERSION='1', MARKETING_VERSION='0.1.0', APPLICATION_EXTENSION_API_ONLY='YES', SKIP_INSTALL='YES', SWIFT_VERSION='5.0', LD_RUNPATH_SEARCH_PATHS=['$(inherited)', '@executable_path/Frameworks', '@executable_path/../../Frameworks']))
extension_phases = phases('extension', extension_resources)
objects[uid('extension-sources')]['files'] = extension_sources
extension_target = add('extension-target', dict(isa='PBXNativeTarget', name='OpenTeamNotifications', buildConfigurationList=extension_config, buildPhases=extension_phases, buildRules=[], dependencies=[], productName='OpenTeamNotifications', productReference=extension, productType='com.apple.product-type.app-extension'))
extension_proxy = add('extension-proxy', dict(isa='PBXContainerItemProxy', containerPortal=uid('project'), proxyType=1, remoteGlobalIDString=extension_target, remoteInfo='OpenTeamNotifications'))
extension_dependency = add('extension-dependency', dict(isa='PBXTargetDependency', target=extension_target, targetProxy=extension_proxy))
objects[app_target]['dependencies'].append(extension_dependency)
embed = add('embed-extension-build', dict(isa='PBXBuildFile', fileRef=extension, settings={'ATTRIBUTES':['RemoveHeadersOnCopy']}))
objects[app_target]['buildPhases'].append(add('embed-extensions', dict(isa='PBXCopyFilesBuildPhase', buildActionMask=2147483647, files=[embed], dstPath='', dstSubfolderSpec=13, name='Embed App Extensions', runOnlyForDeploymentPostprocessing=0)))
# Share extension: Bot conversation suggestions in the system share sheet. It reads the app's
# Keychain session (shared access group, no App Group) and posts through the same API client.
share = add('share-ref', dict(isa='PBXFileReference', explicitFileType='wrapper.app-extension', path='OpenTeamShare.appex', sourceTree='BUILT_PRODUCTS_DIR'))
objects[products]['children'].append(share)
share_sources, share_resources = [], []
def share_file(path, kind, ref=None, app_too=False):
    if ref is None:
        ref = add('share-'+path, dict(isa='PBXFileReference', lastKnownFileType=kind, path=path, sourceTree='<group>'))
        objects[main]['children'].append(ref)
    swift = path.endswith('.swift')
    (share_sources if swift else share_resources).append(add('share-build-'+path, dict(isa='PBXBuildFile', fileRef=ref)))
    if app_too:
        objects[uid('app-sources' if swift else 'app-resources')]['files'].append(add('app-build-'+path, dict(isa='PBXBuildFile', fileRef=ref)))
share_file('ShareExtension/ShareViewController.swift', 'sourcecode.swift')
share_file('ShareExtension/ConversationDonation.swift', 'sourcecode.swift', app_too=True)
share_file('NotificationService/RobotNotificationArtwork.json', 'text.json', ref=uid('notification-RobotNotificationArtwork.json'), app_too=True)
share_file('NotificationService/RobotNotificationAvatar.swift', 'sourcecode.swift', ref=uid('notification-RobotNotificationAvatar.swift'), app_too=True)
for path in ['Sources/Core/API.swift', 'Sources/Core/Models.swift', 'Sources/Core/ShareDirectory.swift', 'Sources/Core/UserFacingError.swift', 'Sources/Core/SessionRecord.swift', 'Sources/App/SecureSession.swift', 'Sources/App/NativeDesign.swift']:
    share_file(path, 'sourcecode.swift')
share_config = configs('share', dict(PRODUCT_NAME='OpenTeamShare', PRODUCT_BUNDLE_IDENTIFIER='dev.openteam.mobile.swift.share', INFOPLIST_FILE='ShareExtension/Info.plist', GENERATE_INFOPLIST_FILE='NO', CODE_SIGN_ENTITLEMENTS='ShareExtension/ShareExtension.entitlements', CURRENT_PROJECT_VERSION='1', MARKETING_VERSION='0.1.0', APPLICATION_EXTENSION_API_ONLY='YES', SKIP_INSTALL='YES', SWIFT_VERSION='5.0', LD_RUNPATH_SEARCH_PATHS=['$(inherited)', '@executable_path/Frameworks', '@executable_path/../../Frameworks']))
share_phases = phases('share', share_resources)
objects[uid('share-sources')]['files'] = share_sources
share_target = add('share-target', dict(isa='PBXNativeTarget', name='OpenTeamShare', buildConfigurationList=share_config, buildPhases=share_phases, buildRules=[], dependencies=[], productName='OpenTeamShare', productReference=share, productType='com.apple.product-type.app-extension'))
share_proxy = add('share-proxy', dict(isa='PBXContainerItemProxy', containerPortal=uid('project'), proxyType=1, remoteGlobalIDString=share_target, remoteInfo='OpenTeamShare'))
objects[app_target]['dependencies'].append(add('share-dependency', dict(isa='PBXTargetDependency', target=share_target, targetProxy=share_proxy)))
objects[uid('embed-extensions')]['files'].append(add('embed-share-build', dict(isa='PBXBuildFile', fileRef=share, settings={'ATTRIBUTES':['RemoveHeadersOnCopy']})))
# Remote Swift packages, pinned to an exact revision so a regenerated project never tracks a branch.
# Each product gets one XCSwiftPackageProductDependency per target (as Xcode itself writes them)
# plus a PBXBuildFile in that target's Frameworks phase; SwiftPM links them statically.
packages = {
    'libraries-dev': dict(url='https://github.com/Jakubantalik/Libraries.dev', revision='bfcb86329da15235a5ee2dcdb6417c8a80f82bb1'),
}
package_refs = {name: add('package-'+name, dict(isa='XCRemoteSwiftPackageReference', repositoryURL=spec['url'], requirement=dict(kind='revision', revision=spec['revision']))) for name, spec in packages.items()}
def link_package(target_name, target, package, product):
    dependency = add(f'package-product-{target_name}-{product}', dict(isa='XCSwiftPackageProductDependency', package=package_refs[package], productName=product))
    objects[target].setdefault('packageProductDependencies', []).append(dependency)
    objects[uid(target_name+'-frameworks')]['files'].append(add(f'package-build-{target_name}-{product}', dict(isa='PBXBuildFile', productRef=dependency)))
# ThinkingOrbsKit replaces indeterminate spinners; VoiceGlowKit lights the composer while recording.
link_package('app', app_target, 'libraries-dev', 'ThinkingOrbsKit')
link_package('app', app_target, 'libraries-dev', 'VoiceGlowKit')
link_package('share', share_target, 'libraries-dev', 'ThinkingOrbsKit')
proxy = add('proxy', dict(isa='PBXContainerItemProxy', containerPortal=uid('project'), proxyType=1, remoteGlobalIDString=app_target, remoteInfo='OpenTeamNative'))
dependency = add('dependency', dict(isa='PBXTargetDependency', target=app_target, targetProxy=proxy))
test_target = add('test-target', dict(isa='PBXNativeTarget', name='OpenTeamNativeUITests', buildConfigurationList=test_config, buildPhases=phases('test'), buildRules=[], dependencies=[dependency], fileSystemSynchronizedGroups=[ui_tests], productName='OpenTeamNativeUITests', productReference=test, productType='com.apple.product-type.bundle.ui-testing'))
# Hosted tests exercise App Intents, Keychain identity checks, and Spotlight
# against deterministic loopback fixtures without Siri language-model access.
system_test_ref = add('system-test-ref', dict(isa='PBXFileReference', explicitFileType='wrapper.cfbundle', path='OpenTeamSystemTests.xctest', sourceTree='BUILT_PRODUCTS_DIR'))
objects[products]['children'].append(system_test_ref)
system_tests = add('system-tests', dict(isa='PBXFileSystemSynchronizedRootGroup', path='Tests/SystemTests', sourceTree='<group>'))
objects[main]['children'].append(system_tests)
system_config = configs('system-tests', dict(PRODUCT_NAME='OpenTeamSystemTests', PRODUCT_BUNDLE_IDENTIFIER='dev.openteam.mobile.swift.system-tests', GENERATE_INFOPLIST_FILE='YES', SWIFT_VERSION='6.0', TEST_HOST='$(BUILT_PRODUCTS_DIR)/OpenTeamNative.app/$(BUNDLE_EXECUTABLE_FOLDER_PATH)/OpenTeamNative', BUNDLE_LOADER='$(TEST_HOST)'))
system_target = add('system-test-target', dict(isa='PBXNativeTarget', name='OpenTeamSystemTests', buildConfigurationList=system_config, buildPhases=phases('system-tests'), buildRules=[], dependencies=[dependency], fileSystemSynchronizedGroups=[system_tests], productName='OpenTeamSystemTests', productReference=system_test_ref, productType='com.apple.product-type.bundle.unit-test'))
project = add('project', dict(isa='PBXProject', attributes={'BuildIndependentTargetsInParallel':'YES', 'LastUpgradeCheck':'2660', 'TargetAttributes':{app_target:{'CreatedOnToolsVersion':'26.6','SystemCapabilities':{'com.apple.Push':{'enabled':1},'com.apple.BackgroundModes':{'enabled':1}}}, test_target:{'CreatedOnToolsVersion':'26.6','TestTargetID':app_target}}}, buildConfigurationList=project_config, compatibilityVersion='Xcode 16.0', developmentRegion='en', hasScannedForEncodings=0, knownRegions=['en', 'Base'], mainGroup=main, packageReferences=list(package_refs.values()), productRefGroup=products, projectDirPath='', projectRoot='', targets=[app_target, test_target, extension_target, share_target]))
objects[project]['targets'].append(system_target)

directory = root / 'OpenTeamNative.xcodeproj'
directory.mkdir(exist_ok=True)
(directory / 'project.pbxproj').write_text('// !$*UTF8*$!\n' + quote(dict(archiveVersion=1, classes={}, objectVersion=77, objects=objects, rootObject=project)) + '\n')
schemes = directory / 'xcshareddata/xcschemes'; schemes.mkdir(parents=True, exist_ok=True)
def reference(target, name): return f'<BuildableReference BuildableIdentifier="primary" BlueprintIdentifier="{target}" BuildableName="{name}" BlueprintName="{name.split(".")[0]}" ReferencedContainer="container:OpenTeamNative.xcodeproj"/>'
app_ref = reference(app_target, 'OpenTeamNative.app'); test_ref = reference(test_target, 'OpenTeamNativeUITests.xctest')
(schemes / 'OpenTeamNative.xcscheme').write_text(f'''<?xml version="1.0" encoding="UTF-8"?>
<Scheme LastUpgradeVersion="2660" version="1.7">
<BuildAction parallelizeBuildables="YES" buildImplicitDependencies="YES"><BuildActionEntries><BuildActionEntry buildForTesting="YES" buildForRunning="YES" buildForProfiling="YES" buildForArchiving="YES" buildForAnalyzing="YES">{app_ref}</BuildActionEntry></BuildActionEntries></BuildAction>
<TestAction buildConfiguration="Debug" selectedDebuggerIdentifier="Xcode.DebuggerFoundation.Debugger.LLDB" selectedLauncherIdentifier="Xcode.IDEFoundation.Launcher.LLDB" shouldUseLaunchSchemeArgsEnv="YES"><Testables><TestableReference skipped="NO">{test_ref}<SkippedTests><Test Identifier="LiveBackendUITests"/><Test Identifier="QAAuditUITests"/><Test Identifier="SettingsPluginAuditUITests"/><Test Identifier="NativePushUITests"/></SkippedTests></TestableReference></Testables></TestAction>
<LaunchAction buildConfiguration="Debug" selectedDebuggerIdentifier="Xcode.DebuggerFoundation.Debugger.LLDB" selectedLauncherIdentifier="Xcode.IDEFoundation.Launcher.LLDB" launchStyle="0" useCustomWorkingDirectory="NO" ignoresPersistentStateOnLaunch="NO" debugDocumentVersioning="YES" debugServiceExtension="internal" allowLocationSimulation="YES"><BuildableProductRunnable runnableDebuggingMode="0">{app_ref}</BuildableProductRunnable></LaunchAction>
<ProfileAction buildConfiguration="Release" shouldUseLaunchSchemeArgsEnv="YES" savedToolIdentifier="" useCustomWorkingDirectory="NO" debugDocumentVersioning="YES"><BuildableProductRunnable runnableDebuggingMode="0">{app_ref}</BuildableProductRunnable></ProfileAction>
<AnalyzeAction buildConfiguration="Debug"/><ArchiveAction buildConfiguration="Release" revealArchiveInOrganizer="YES"/>
</Scheme>''')
print(directory)

system_ref = reference(system_target, 'OpenTeamSystemTests.xctest')
system_scheme = (schemes / 'OpenTeamNative.xcscheme').read_text()
system_scheme = system_scheme.replace(f'{test_ref}<SkippedTests>', f'{system_ref}<SkippedTests>')
system_scheme = system_scheme.replace('shouldUseLaunchSchemeArgsEnv="YES"', 'shouldUseLaunchSchemeArgsEnv="NO"', 1)
system_scheme = system_scheme.replace('</Testables></TestAction>', '</Testables><EnvironmentVariables><EnvironmentVariable key="OPENTEAM_SYSTEM_TEST_HOST" value="1" isEnabled="YES"/></EnvironmentVariables></TestAction>')
(schemes / 'SystemIntents.xcscheme').write_text(system_scheme)

visual_scheme = (schemes / 'OpenTeamNative.xcscheme').read_text().replace('<SkippedTests><Test Identifier="LiveBackendUITests"/><Test Identifier="QAAuditUITests"/><Test Identifier="SettingsPluginAuditUITests"/><Test Identifier="NativePushUITests"/></SkippedTests>', '<SelectedTests><Test Identifier="SelectedUITests"/></SelectedTests>')


(schemes / "LiveBackend.xcscheme").write_text(visual_scheme.replace("SelectedUITests", "LiveBackendUITests"))


(schemes / "QAAudit.xcscheme").write_text(visual_scheme.replace("SelectedUITests", "QAAuditUITests"))

(schemes / "SettingsPluginAudit.xcscheme").write_text(visual_scheme.replace("SelectedUITests", "SettingsPluginAuditUITests"))

(schemes / "NativePush.xcscheme").write_text(visual_scheme.replace("SelectedUITests", "NativePushUITests"))

(schemes / "RealServer.xcscheme").write_text(visual_scheme.replace("SelectedUITests", "RealServerUITests"))
# Real inference is explicitly opt-in; regular UI verification stays deterministic.
(schemes / 'VNCValidation.xcscheme').write_text(visual_scheme.replace('SelectedUITests', 'VNCValidationUITests'))
(schemes / 'LaunchRobot.xcscheme').write_text(visual_scheme.replace('SelectedUITests', 'LaunchRobotUITests'))
(schemes / 'Palette.xcscheme').write_text(visual_scheme.replace('SelectedUITests', 'PaletteUITests'))
(schemes / 'Haptics.xcscheme').write_text(visual_scheme.replace('SelectedUITests', 'HapticsUITests'))
(schemes / 'RoutineSchedule.xcscheme').write_text(visual_scheme.replace('SelectedUITests', 'RoutineScheduleUITests'))
for scheme in ['OpenTeamNative.xcscheme']:
    path = schemes / scheme
    path.write_text(path.read_text().replace('</SkippedTests>', '<Test Identifier="RoutineScheduleUITests"/></SkippedTests>'))
    path.write_text(path.read_text().replace('</SkippedTests>', '<Test Identifier="RealServerUITests"/><Test Identifier="VNCValidationUITests"/><Test Identifier="LaunchRobotUITests"/><Test Identifier="PaletteUITests"/><Test Identifier="HapticsUITests"/></SkippedTests>'))

# A real Tailscale address is required to catch HTTP policy bugs hidden by loopback fixtures.
(schemes / 'LiveHTTP.xcscheme').write_text(visual_scheme.replace('SelectedUITests', 'LiveHTTPUITests'))
for scheme in ['OpenTeamNative.xcscheme']:
    path = schemes / scheme
    path.write_text(path.read_text().replace('</SkippedTests>', '<Test Identifier="LiveHTTPUITests"/></SkippedTests>'))

(schemes / 'GlassSections.xcscheme').write_text(visual_scheme.replace('SelectedUITests', 'GlassSectionsUITests'))
(schemes / 'EdgeBack.xcscheme').write_text(visual_scheme.replace('SelectedUITests', 'EdgeBackUITests'))
(schemes / 'MessagePerformance.xcscheme').write_text(visual_scheme.replace('SelectedUITests', 'MessagePerformanceUITests'))
(schemes / 'ChatMotion.xcscheme').write_text(visual_scheme.replace('SelectedUITests', 'ChatMotionUITests'))
for scheme in ['OpenTeamNative.xcscheme']:
    path = schemes / scheme
    path.write_text(path.read_text().replace('</SkippedTests>', '<Test Identifier="GlassSectionsUITests"/><Test Identifier="EdgeBackUITests"/><Test Identifier="MessagePerformanceUITests"/><Test Identifier="ChatMotionUITests"/></SkippedTests>'))

# Broader acceptance: routines, edge gestures and local installation (fixture ports 20032/20043/20039).
(schemes / 'Acceptance.xcscheme').write_text(visual_scheme.replace('<Test Identifier="SelectedUITests"/>', ''.join(f'<Test Identifier="{name}"/>' for name in ['RoutineScheduleUITests', 'EdgeBackUITests', 'LiveHTTPUITests'])))

(schemes / 'MotionPerformance.xcscheme').write_text(visual_scheme.replace('<Test Identifier="SelectedUITests"/>', '<Test Identifier="ChatMotionUITests"/><Test Identifier="MessagePerformanceUITests"/>'))
