# tex180 メモ

## 設計指針（ユーザー要件）
- 安定性最優先（入力が壊れない/落ちない/状態が迷子にならない）。
- 編集の自動確定は禁止（提案はOK、確定はユーザー操作のAccept/Cancelのみ、Undo導線も用意）。
- 重い処理は非同期（Index/BuildはUIをブロックしない）。
- PDF更新はビルド成功時のみ、失敗時は前回成功PDFを保持。
- ログ洪水禁止（ログは隠し、Issuesが一次窓口）。
- 挿入UIの鉄則: 1) ターゲット可視化 2) 事前プレビュー 3) Accept/Cancel + Undo導線。
- ブロック再編集のために blockID + internal JSON + deps を保持（`.tex180/blocks.json`）。
- UI構成はVSCode風（左タブ/右エディタ/下Issues/上ビルド）。PDFは別ウィンドウでroot単位に使い回し。
- Outlineは左タブ＋エディタ上部ミニOutline＋ジャンプ導線。
- 技術方針はSwift（殻）＋WKWebView（中身TS/Monaco）。
- テーマは中立背景、紫はアクセントのみ。
- ショートカットは基本のみ（コピー/Undo等）。Command+K系は当面使わない。
- ノーコードのブロック編集は数式/表から始め、段階的に拡張する。
  - Monacoの既定ショートカットは無効化しない（追加カスタムのみ慎重に行う）。

## 初期設計依頼の記録（A〜E + 追加制約）
### A) アーキテクチャ設計（tex180全体像）
- モジュール境界: Swift側（ウィンドウ/メニュー/PDF別窓/ファイル権限/ビルド/Indexer/安定性）、Web側（Monaco/Quick Insert/ゴースト挿入/ブロックUI/差分UI/補完UI）。
- データフロー: Editor ↔ Indexer ↔ Build ↔ PDF ↔ Issues。
- 非同期設計: Index/Buildは非同期でUIをブロックしない。入力はWeb側が唯一の真実で、Swiftは自動書換えをしない。
- プロジェクト概念: ルートフォルダ単位のワークスペース、複数ファイル管理。

### B) ディレクトリ/ファイル構成案（初期）
- Swift: AppShell, WorkspaceManager, BuildService, IndexerService, PDFWindowController, Bridge。
- Web: `web/index.html`, `web/main.ts`, `editor/monaco.ts`, `ui/sidebar.ts`, `ui/quickInsert.ts`, `ui/issues.ts`, `ui/diffPreview.ts`, `theme.css`。
- `.tex180/` 管理: `blocks.json`, `settings.json`, `cache/index.json`, `issues.json`。

### C) マイルストーン計画（DoD付き）
- Phase 0: WKWebViewがbundleのindex.htmlを表示（DoD: 起動でWeb UIが表示）。
- Phase 1: Monaco表示＋基本編集（DoD: 編集/Undo/Redoが動作）。
- Phase 2: 左サイドバー＋タブ切替＋ミニOutline枠（DoD: UI切替が動作）。
- Phase 3: Quick Insert（⌘K）→ プレビュー → Accept/Cancel（DoD: 挿入UIの鉄則を満たす）。
- Phase 4: Build（pdflatex/latexmk）＋成功時PDF更新＋失敗時Issues（DoD: 成功時のみPDF更新）。
- Phase 5: Indexer（label/ref/cite抽出）＋補完＋定義ジャンプ（DoD: ジャンプ/補完が非同期で動作）。
- Phase 6: Blocksメタ（`.tex180/blocks.json`）＋再編集UI（DoD: blockID/JSON/depsが保持される）。
- Phase 7: Auto Build・設定・Search・Git（最小）（DoD: 最小機能が安定動作）。
- Phase 8: パッケージング/署名/App Store向け仕上げ（DoD: 提出要件を満たす）。

### D) Codex CLI運用ルール（初期案）
- 変更は「変更対象ファイル一覧→各ファイル全文」を出力。
- 1ステップ = 小さなPR単位。通ったらコミット前提。
- エラーは貼り付けログを根拠に修正。
- 既存コード破壊は禁止（必要なら移行手順を提示）。

### D-2) Codex CLI運用ルール（更新）
- 変更の裁量は任される（無駄な全文出力は不要）。
- 説明は日本語で行う。
- 不明瞭な点は必ず質問して確認する。

### E) 最初の実装タスク
- SwiftUIにWKWebViewを埋め込み、bundleの`index.html`を読み、表示確認できる状態にする。

### 追加制約
- 外部クラウド依存なし（完全ローカル）。
- MVPはAI機能（LLM呼び出し）なし。差分UIは将来拡張前提で可。
- PDFは別ウィンドウで、成功時のみ更新。
- 仕様外の機能追加は禁止（提案は分離して提示）。

## 各フェーズの実装方針（簡易）
- Phase 0: WKWebView + バンドルリソース読み込み、失敗時のフォールバックUI。
- Phase 1: Monacoをローカル同梱、`file://`向けWorker起動、基本編集のみ。
- Phase 2: 左タブの選択状態/表示切替、上部ミニOutline枠の動的更新。
- Phase 3: Quick Insertはターゲット可視化→プレビュー→Accept/Cancelを必須にし、Undo導線をつける。
- Phase 4: Build/Indexerは非同期でキャンセル可能、成功時のみPDF更新、失敗はIssues要約。
- Phase 5: Indexerで参照抽出し、補完候補/定義ジャンプをWeb側へ通知。
- Phase 6: `.tex180/blocks.json`にメタ保存し、ブロック再編集UIで再利用。
- Phase 7: Auto Build/検索/Gitは最小スコープで導入。
- Phase 8: 署名/サンドボックス/配布の最終調整。

## 実装詳細（現状）
### Swift
- `ContentView` は `Bundle.main.url(forResource: "index", withExtension: "html", subdirectory: "web")` でWeb UIを取得し、見つからない場合は案内を表示する。
- `WebView` は `WKWebView` を `NSViewRepresentable` で保持し、`WKNavigationDelegate` でロード状態を監視する。
- `WebViewLoadState` / `WebViewFailure` でロード成功・失敗・プロセス終了を表現し、失敗時は再読み込みUIを表示する。
- SwiftUIの更新中に状態を変えないため、WebView状態更新は `DispatchQueue.main.async` で遅延送信する。
- 再読み込みは `reloadToken` を更新してWebViewを再生成する。

### Web
- `web/index.html` はVSCode風スケルトン（トップバー/左タブ/エディタ/Issues）とMonacoのホスト要素（`#editor`）を定義する。
- `web/theme.css` はダーク寄りのフラットスタイル（細いボーダー/影なし/アクセント青）に統一し、エディタ領域を全面占有にする。
- `web/main.js` は初期表示のフェードインとMonacoの読み込みを担当し、読み込み失敗時はフォールバック文言を更新する。
- Monacoは `monaco-editor@0.55.1` の `min/vs` を `Resources/web/monaco/vs` に同梱し、`loader.js` からAMDロードする（バンドル内では `web/monaco/vs`）。
- `file://` でも動くよう `MonacoEnvironment.getWorkerUrl` でBlob URLを生成し、Workerを起動する。
- Monacoの初期設定は `vs-dark` / `automaticLayout` / `minimap: false` / `fontSize: 13` / `lineHeight: 20` など。
  - Monacoの既定ショートカットは維持（無効化しない）。

### バンドル/リソース
- `Resources/web` を `Copy Bundle Resources` に追加し、アプリバンドル内では `web` として参照する。

- 2025-12-25: Phase 0はWKWebViewでアプリバンドル内の`web/index.html`を読み込み表示する。
- 2025-12-25: バンドルリソースが見つからない場合はクラッシュせず案内表示にする。
- 2025-12-25: Command+K系のショートカットは実装しない。基本ショートカット（コピー/Undo等）のみ。
- 2025-12-25: ノーコードのブロック編集は数式・表から着手し、順次拡張する。
- 2025-12-25: Web UIは段階的に整備し、まずVSCode風レイアウトの骨組みを用意する（Monacoは後続）。
- 2025-12-25: UI表記は日本語を基本とし、英語は必要最小限に留める。
- 2025-12-25: WKWebViewの読み込み失敗やプロセス終了に備えて、再読み込みできるフォールバック表示を用意する。
- 2025-12-25: SwiftUIの更新中に状態変更しないよう、WKWebViewの状態更新はメインキューへ遅延送信する。
- 2025-12-25: VSCode風の見た目に寄せるため、影を減らしフラットな面構成と細いボーダーを基本にする。
- 2025-12-25: Monaco Editor 0.55.1 を `Resources/web/monaco/vs` に同梱し、AMDローダーで読み込む。
- 2025-12-25: MonacoのWorkerは`file://`でも動くようBlob URLで起動する。
- 2025-12-25: `web` フォルダを `Resources/web` に移動し、File System Synchronized Groupの重複コピーを避ける。

## 既知の警告ログ（現時点で致命ではない）
- Modifying state during view update, this will cause undefined behavior.（修正: WebViewの状態更新はmain async）
- Could not create a sandbox extension for '/Users/wedd/Library/Fonts/APJapanesefont.ttf'
- AFIsDeviceGreymatterEligible Missing entitlements for os_eligibility lookup
- Unable to create bundle at URL ((null)): normalized URL null
- precondition failure: unable to load binary archive for shader library: /System/Library/PrivateFrameworks/IconRendering.framework/Resources/binary.metallib ...
- WebContent[...] Unable to hide query parameters from script (missing data)
- Error acquiring assertion: RBSServiceErrorDomain (runningboard.assertions.webkit のエンタイトルメント不足)
- Message from debugger: killed
