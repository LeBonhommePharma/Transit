import Foundation
import RiveKit

/// Personal, no-store entry: parse a query, print the live URL, or open it on this Mac.
@main
enum RiveCLI {
  static let liveURL = "https://thebonhomme.com/transit/"

  static func main() throws {
    let args = Array(CommandLine.arguments.dropFirst())
    let command = args.first ?? "use"
    switch command {
    case "parse":
      let text = args.dropFirst().joined(separator: " ")
      let intent = FoundationAssist.parseLocally(text)
      let encoder = JSONEncoder()
      encoder.outputFormatting = [.sortedKeys]
      let data = try encoder.encode(intent)
      FileHandle.standardOutput.write(data)
      FileHandle.standardOutput.write(Data("\n".utf8))
    case "open", "use":
      FileHandle.standardOutput.write(Data("\(liveURL)\n".utf8))
      let process = Process()
      process.executableURL = URL(fileURLWithPath: "/usr/bin/open")
      process.arguments = [liveURL]
      try? process.run()
      process.waitUntilExit()
    case "url":
      FileHandle.standardOutput.write(Data("\(liveURL)\n".utf8))
    default:
      FileHandle.standardError.write(
        Data("usage: RiveCLI [use|open|url|parse <text>]\n".utf8)
      )
      exit(2)
    }
  }
}
