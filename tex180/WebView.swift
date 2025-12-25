//
//  WebView.swift
//  tex180
//
//  Created by Codex.
//

import SwiftUI
import WebKit

enum WebViewLoadState: Equatable {
    case idle
    case loading
    case loaded
    case failed(WebViewFailure)
}

enum WebViewFailure: Equatable {
    case loadFailed
    case processTerminated
}

struct WebView: NSViewRepresentable {
    let url: URL
    @Binding var state: WebViewLoadState

    func makeNSView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = context.coordinator
        webView.loadFileURL(url, allowingReadAccessTo: url.deletingLastPathComponent())
        return webView
    }

    func updateNSView(_ nsView: WKWebView, context: Context) {
        guard nsView.url != url else { return }
        nsView.loadFileURL(url, allowingReadAccessTo: url.deletingLastPathComponent())
    }

    func makeCoordinator() -> Coordinator {
        Coordinator(state: $state)
    }

    final class Coordinator: NSObject, WKNavigationDelegate {
        private var state: Binding<WebViewLoadState>

        init(state: Binding<WebViewLoadState>) {
            self.state = state
        }

        func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
            updateState(.loading)
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            updateState(.loaded)
        }

        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
            updateState(.failed(.loadFailed))
        }

        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
            updateState(.failed(.loadFailed))
        }

        func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
            updateState(.failed(.processTerminated))
        }

        private func updateState(_ newState: WebViewLoadState) {
            DispatchQueue.main.async {
                self.state.wrappedValue = newState
            }
        }
    }
}
