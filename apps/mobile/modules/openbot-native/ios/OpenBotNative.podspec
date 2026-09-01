require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))

Pod::Spec.new do |s|
  s.name = 'OpenBotNative'
  s.version = package['version']
  s.summary = 'OpenBot iOS speech and document preview integration'
  s.description = package['description'] || s.summary
  s.license = 'MIT'
  s.author = 'OpenBot'
  s.homepage = 'https://github.com/openbot-dev/openbot'
  s.platforms = { :ios => '16.4' }
  s.swift_version = '5.9'
  s.source = { :path => '.' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  s.frameworks = 'AVFoundation', 'QuickLook', 'Speech'
  s.source_files = '**/*.{h,m,swift}'
  s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES' }
end
