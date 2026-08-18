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

  func makeUIView(context: Context) -> WKWebView {
    let view = WKWebView()
    view.load(URLRequest(url: url))
    return view
  }

  func updateUIView(_ uiView: WKWebView, context: Context) {}
}
#else
struct AtlasWebView: View {
  let url: URL
  var body: some View {
    Text(url.absoluteString)
  }
}
#endif
