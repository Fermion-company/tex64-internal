//
//  ContentView.swift
//  tex180
//
//  Created by 幸川 on 2025/12/25.
//

import SwiftUI

struct ContentView: View {
    @State private var webState: WebViewLoadState = .idle
    @State private var reloadToken = UUID()

    private var webIndexURL: URL? {
        Bundle.main.url(forResource: "index", withExtension: "html", subdirectory: "web")
    }

    var body: some View {
        if let url = webIndexURL {
            ZStack {
                WebView(url: url, state: $webState)
                    .id(reloadToken)

                if case let .failed(failure) = webState {
                    VStack(spacing: 10) {
                        Text("Webコンテンツの表示に失敗しました。")
                            .font(.headline)
                        Text(failureMessage(failure))
                            .foregroundStyle(.secondary)
                        Button("再読み込み") {
                            reloadToken = UUID()
                            webState = .loading
                        }
                    }
                    .padding(20)
                    .background(.ultraThinMaterial)
                    .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                }
            }
        } else {
            VStack(spacing: 8) {
                Text("web/index.html がアプリバンドルに見つかりません。")
                    .font(.headline)
                Text("web リソースがターゲットに含まれているか確認してください。")
                    .foregroundStyle(.secondary)
            }
        }
    }

    private func failureMessage(_ failure: WebViewFailure) -> String {
        switch failure {
        case .loadFailed:
            return "読み込みに失敗しました。再読み込みをお試しください。"
        case .processTerminated:
            return "Webプロセスが終了しました。再読み込みで復旧する場合があります。"
        }
    }
}

#Preview {
    ContentView()
}
