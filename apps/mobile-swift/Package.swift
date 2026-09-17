// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "OpenTeamCore",
    platforms: [.macOS(.v14), .iOS(.v18)],
    products: [.library(name: "OpenTeamCore", targets: ["OpenTeamCore"])],
    targets: [
        .target(name: "OpenTeamCore", path: "Sources/Core", resources: [.process("Resources")]),
        .testTarget(name: "OpenTeamCoreTests", dependencies: ["OpenTeamCore"], path: "Tests/CoreTests", resources: [.copy("Fixtures")])
    ]
)
