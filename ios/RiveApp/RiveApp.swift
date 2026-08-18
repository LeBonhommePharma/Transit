import SwiftUI
#if canImport(WebKit)
import WebKit
#endif
import RiveKit

/// Personal-team iPhone shell. The atlas is the live site; this app only pulses Watch + Live Activity.
@main
struct RiveApp: App {
  var body: some Scene {
    WindowGroup {
      AtlasWebView(url: URL(string: "https://thebonhomme.com/transit/")!)
        .ignoresSafeArea()
    }
  }
}

#if canImport(WebKit)
struct AtlasWebView: UIViewRepresentable {
  let url: URL

  func makeCoordinator() -> Coordinator {
    Coordinator()
  }

  func makeUIView(context: Context) -> WKWebView {
    let content = WKWebViewConfiguration()
    content.userContentController.add(context.coordinator, name: "riveLive")
    let view = WKWebView(frame: .zero, configuration: content)
    view.load(URLRequest(url: url))
    return view
  }

  func updateUIView(_ uiView: WKWebView, context: Context) {}

  final class Coordinator: NSObject, WKScriptMessageHandler {
    func userContentController(
      _ userContentController: WKUserContentController,
      didReceive message: WKScriptMessage
    ) {
      guard message.name == "riveLive" else { return }
      let body: [String: Any]
      if let dict = message.body as? [String: Any] {
        body = dict
      } else {
        body = ["action": "end"]
      }
      #if canImport(ActivityKit)
      LiveDeparturePusher.apply(command: body)
      #endif
    }
  }
}
#else
struct AtlasWebView: View {
  let url: URL
  var body: some View {
    Text(url.absoluteString)
  }
}
#endif
