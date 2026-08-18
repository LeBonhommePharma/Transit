// swift-tools-version: 6.2
import PackageDescription

let package = Package(
  name: "RiveKit",
  platforms: [
    .iOS(.v26),
    .macOS(.v26),
    .watchOS(.v26),
  ],
  products: [
    .library(name: "RiveKit", targets: ["RiveKit"]),
  ],
  targets: [
    .target(name: "RiveKit"),
  ]
)
