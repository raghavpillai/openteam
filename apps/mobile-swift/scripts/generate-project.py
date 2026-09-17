#!/usr/bin/env python3
"""Generate the small, dependency-free Xcode project; no XcodeGen or CocoaPods required."""
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
        if mode == 'Release' and name in ['app', 'extension']:
            build.update(PRODUCT_BUNDLE_IDENTIFIER=release['bundleIdentifier'] + ('.notifications' if name == 'extension' else ''), CURRENT_PROJECT_VERSION=release['buildNumber'], MARKETING_VERSION=release['version'], DEVELOPMENT_TEAM=release['teamIdentifier'], PROVISIONING_PROFILE_SPECIFIER='$(APP_PROVISIONING_PROFILE)' if name == 'app' else '$(EXTENSION_PROVISIONING_PROFILE)')
        if name == 'app': build['APNS_ENVIRONMENT'] = 'development' if mode == 'Debug' else 'production'
        build.update({'SWIFT_OPTIMIZATION_LEVEL': '-Onone' if mode == 'Debug' else '-O', 'SWIFT_ACTIVE_COMPILATION_CONDITIONS': 'DEBUG' if mode == 'Debug' else '', 'DEBUG_INFORMATION_FORMAT': 'dwarf' if mode == 'Debug' else 'dwarf-with-dsym'})
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
for filename, kind in [('NotificationService.swift', 'sourcecode.swift'), ('RobotNotificationAvatar.swift', 'sourcecode.swift'), ('RobotArtwork.json', 'text.json')]:
    ref = add('notification-'+filename, dict(isa='PBXFileReference', lastKnownFileType=kind, path='../mobile/notification-service/'+filename, sourceTree='<group>'))
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
proxy = add('proxy', dict(isa='PBXContainerItemProxy', containerPortal=uid('project'), proxyType=1, remoteGlobalIDString=app_target, remoteInfo='OpenTeamNative'))
dependency = add('dependency', dict(isa='PBXTargetDependency', target=app_target, targetProxy=proxy))
test_target = add('test-target', dict(isa='PBXNativeTarget', name='OpenTeamNativeUITests', buildConfigurationList=test_config, buildPhases=phases('test'), buildRules=[], dependencies=[dependency], fileSystemSynchronizedGroups=[ui_tests], productName='OpenTeamNativeUITests', productReference=test, productType='com.apple.product-type.bundle.ui-testing'))
project = add('project', dict(isa='PBXProject', attributes={'BuildIndependentTargetsInParallel':'YES', 'LastUpgradeCheck':'2660', 'TargetAttributes':{app_target:{'CreatedOnToolsVersion':'26.6','SystemCapabilities':{'com.apple.Push':{'enabled':1},'com.apple.BackgroundModes':{'enabled':1}}}, test_target:{'CreatedOnToolsVersion':'26.6','TestTargetID':app_target}}}, buildConfigurationList=project_config, compatibilityVersion='Xcode 16.0', developmentRegion='en', hasScannedForEncodings=0, knownRegions=['en', 'Base'], mainGroup=main, productRefGroup=products, projectDirPath='', projectRoot='', targets=[app_target, test_target, extension_target]))
directory = root / 'OpenTeamNative.xcodeproj'
directory.mkdir(exist_ok=True)
(directory / 'project.pbxproj').write_text('// !$*UTF8*$!\n' + quote(dict(archiveVersion=1, classes={}, objectVersion=77, objects=objects, rootObject=project)) + '\n')
schemes = directory / 'xcshareddata/xcschemes'; schemes.mkdir(parents=True, exist_ok=True)
def reference(target, name): return f'<BuildableReference BuildableIdentifier="primary" BlueprintIdentifier="{target}" BuildableName="{name}" BlueprintName="{name.split(".")[0]}" ReferencedContainer="container:OpenTeamNative.xcodeproj"/>'
app_ref = reference(app_target, 'OpenTeamNative.app'); test_ref = reference(test_target, 'OpenTeamNativeUITests.xctest')
(schemes / 'OpenTeamNative.xcscheme').write_text(f'''<?xml version="1.0" encoding="UTF-8"?>
<Scheme LastUpgradeVersion="2660" version="1.7">
<BuildAction parallelizeBuildables="YES" buildImplicitDependencies="YES"><BuildActionEntries><BuildActionEntry buildForTesting="YES" buildForRunning="YES" buildForProfiling="YES" buildForArchiving="YES" buildForAnalyzing="YES">{app_ref}</BuildActionEntry></BuildActionEntries></BuildAction>
<TestAction buildConfiguration="Debug" selectedDebuggerIdentifier="Xcode.DebuggerFoundation.Debugger.LLDB" selectedLauncherIdentifier="Xcode.IDEFoundation.Launcher.LLDB" shouldUseLaunchSchemeArgsEnv="YES"><Testables><TestableReference skipped="NO">{test_ref}<SkippedTests><Test Identifier="ReferenceCaptureTests"/><Test Identifier="GrokbotVisualTests"/><Test Identifier="LiveComputerUITests"/><Test Identifier="LiveBackendUITests"/><Test Identifier="DarkReferenceUITests"/><Test Identifier="QAAuditUITests"/><Test Identifier="SettingsPluginAuditUITests"/><Test Identifier="NativePushUITests"/></SkippedTests></TestableReference></Testables></TestAction>
<LaunchAction buildConfiguration="Debug" selectedDebuggerIdentifier="Xcode.DebuggerFoundation.Debugger.LLDB" selectedLauncherIdentifier="Xcode.IDEFoundation.Launcher.LLDB" launchStyle="0" useCustomWorkingDirectory="NO" ignoresPersistentStateOnLaunch="NO" debugDocumentVersioning="YES" debugServiceExtension="internal" allowLocationSimulation="YES"><BuildableProductRunnable runnableDebuggingMode="0">{app_ref}</BuildableProductRunnable></LaunchAction>
<ProfileAction buildConfiguration="Release" shouldUseLaunchSchemeArgsEnv="YES" savedToolIdentifier="" useCustomWorkingDirectory="NO" debugDocumentVersioning="YES"><BuildableProductRunnable runnableDebuggingMode="0">{app_ref}</BuildableProductRunnable></ProfileAction>
<AnalyzeAction buildConfiguration="Debug"/><ArchiveAction buildConfiguration="Release" revealArchiveInOrganizer="YES"/>
</Scheme>''')
print(directory)
reference_scheme = (schemes / 'OpenTeamNative.xcscheme').read_text().replace('shouldUseLaunchSchemeArgsEnv="YES"', 'shouldUseLaunchSchemeArgsEnv="NO"').replace('<Test Identifier="ReferenceCaptureTests"/>', '').replace('<Testables>', '<EnvironmentVariables><EnvironmentVariable key="OPENTEAM_CAPTURE_REFERENCE" value="1" isEnabled="YES"/></EnvironmentVariables><Testables>')
(schemes / 'OpenTeamReference.xcscheme').write_text(reference_scheme)

visual_scheme = (schemes / 'OpenTeamNative.xcscheme').read_text().replace('<SkippedTests><Test Identifier="ReferenceCaptureTests"/><Test Identifier="GrokbotVisualTests"/><Test Identifier="LiveComputerUITests"/><Test Identifier="LiveBackendUITests"/><Test Identifier="DarkReferenceUITests"/><Test Identifier="QAAuditUITests"/><Test Identifier="SettingsPluginAuditUITests"/><Test Identifier="NativePushUITests"/></SkippedTests>', '<SelectedTests><Test Identifier="GrokbotVisualTests"/></SelectedTests>')
(schemes / 'GrokbotVisual.xcscheme').write_text(visual_scheme)

(schemes / "LiveComputer.xcscheme").write_text(visual_scheme.replace("GrokbotVisualTests", "LiveComputerUITests"))

(schemes / "LiveBackend.xcscheme").write_text(visual_scheme.replace("GrokbotVisualTests", "LiveBackendUITests"))

(schemes / "DarkReference.xcscheme").write_text(visual_scheme.replace("GrokbotVisualTests", "DarkReferenceUITests"))

(schemes / "QAAudit.xcscheme").write_text(visual_scheme.replace("GrokbotVisualTests", "QAAuditUITests"))

(schemes / "SettingsPluginAudit.xcscheme").write_text(visual_scheme.replace("GrokbotVisualTests", "SettingsPluginAuditUITests"))

(schemes / "NativePush.xcscheme").write_text(visual_scheme.replace("GrokbotVisualTests", "NativePushUITests"))

(schemes / "RealServer.xcscheme").write_text(visual_scheme.replace("GrokbotVisualTests", "RealServerUITests"))
# Real inference is explicitly opt-in; regular UI verification stays deterministic.
(schemes / 'VNCValidation.xcscheme').write_text(visual_scheme.replace('GrokbotVisualTests', 'VNCValidationUITests'))
(schemes / 'SevenReference.xcscheme').write_text(visual_scheme.replace('GrokbotVisualTests', 'SevenReferenceUITests'))
(schemes / 'LaunchRobot.xcscheme').write_text(visual_scheme.replace('GrokbotVisualTests', 'LaunchRobotUITests'))
(schemes / 'Palette.xcscheme').write_text(visual_scheme.replace('GrokbotVisualTests', 'PaletteUITests'))
(schemes / 'Haptics.xcscheme').write_text(visual_scheme.replace('GrokbotVisualTests', 'HapticsUITests'))
(schemes / 'RoutineSchedule.xcscheme').write_text(visual_scheme.replace('GrokbotVisualTests', 'RoutineScheduleUITests'))
for scheme in ['OpenTeamNative.xcscheme', 'OpenTeamReference.xcscheme']:
    path = schemes / scheme
    path.write_text(path.read_text().replace('</SkippedTests>', '<Test Identifier="RoutineScheduleUITests"/></SkippedTests>'))
    path.write_text(path.read_text().replace('</SkippedTests>', '<Test Identifier="RealServerUITests"/><Test Identifier="VNCValidationUITests"/><Test Identifier="SevenReferenceUITests"/><Test Identifier="LaunchRobotUITests"/><Test Identifier="PaletteUITests"/><Test Identifier="HapticsUITests"/></SkippedTests>'))

# A real Tailscale address is required to catch HTTP policy bugs hidden by loopback fixtures.
(schemes / 'LiveHTTP.xcscheme').write_text(visual_scheme.replace('GrokbotVisualTests', 'LiveHTTPUITests'))
for scheme in ['OpenTeamNative.xcscheme', 'OpenTeamReference.xcscheme']:
    path = schemes / scheme
    path.write_text(path.read_text().replace('</SkippedTests>', '<Test Identifier="LiveHTTPUITests"/></SkippedTests>'))

(schemes / 'GlassSections.xcscheme').write_text(visual_scheme.replace('GrokbotVisualTests', 'GlassSectionsUITests'))
(schemes / 'AttachmentReference.xcscheme').write_text(visual_scheme.replace('GrokbotVisualTests', 'AttachmentReferenceUITests'))
for scheme in ['OpenTeamNative.xcscheme', 'OpenTeamReference.xcscheme']:
    path = schemes / scheme
    path.write_text(path.read_text().replace('</SkippedTests>', '<Test Identifier="GlassSectionsUITests"/><Test Identifier="AttachmentReferenceUITests"/></SkippedTests>'))
