require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))

Pod::Spec.new do |s|
  s.name = 'OpenTeamNative'
  s.version = package['version']
  s.summary = 'OpenTeam iOS speech and document preview integration'
  s.description = package['description'] || s.summary
  s.license = 'MIT'
  s.author = 'OpenTeam'
  s.homepage = 'https://github.com/openteam-dev/openteam'
  s.platforms = { :ios => '16.4' }
  s.swift_version = '5.9'
  s.source = { :path => '.' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  s.frameworks = 'AVFoundation', 'QuickLook', 'Speech'
  s.source_files = '**/*.{h,m,swift}'
  s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES' }
end
