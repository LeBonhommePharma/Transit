// swift-tools-version: 6.2
import PackageDescription

let package = Package(
  name: "RiveKit",
  platforms: [
    .iOS(.v17),
    .macOS(.v14),
    .watchOS(.v10),
  ],
  products: [
    .library(name: "RiveKit", targets: ["RiveKit"]),
    .executable(name: "RiveCLI", targets: ["RiveCLI"]),
    .executable(name: "RiveKitCheck", targets: ["RiveKitCheck"]),
  ],
  targets: [
    .target(name: "RiveKit"),
    .executableTarget(
      name: "RiveCLI",
      dependencies: ["RiveKit"]
    ),
    .executableTarget(
      name: "RiveKitCheck",
      dependencies: ["RiveKit"]
    ),
  ]
)
