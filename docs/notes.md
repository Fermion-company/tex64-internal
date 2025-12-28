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
- 技術方針はElectron（殻）＋Web UI（TS/Monaco）。
- テーマは中立背景、紫はアクセントのみ。
- ショートカットは基本のみ（コピー/Undo等）。Command+K系は当面使わない。
- ノーコードのブロック編集は数式/表から始め、段階的に拡張する。
  - Monacoの既定ショートカットは無効化しない（追加カスタムのみ慎重に行う）。

## 初期設計依頼の記録（A〜E + 追加制約）
### A) アーキテクチャ設計（tex180全体像）
- モジュール境界: Electron/Node側（ウィンドウ/メニュー/PDF別窓/ファイル権限/ビルド/Indexer/安定性）、Web側（Monaco/Quick Insert/ゴースト挿入/ブロックUI/差分UI/補完UI）。
- データフロー: Editor ↔ Indexer ↔ Build ↔ PDF ↔ Issues。
- 非同期設計: Index/Buildは非同期でUIをブロックしない。入力はWeb側が唯一の真実で、ホスト側（Electron/Node）は自動書換えをしない。
- プロジェクト概念: ルートフォルダ単位のワークスペース、複数ファイル管理。

### B) ディレクトリ/ファイル構成案（初期）
- Electron/Node: `electron/main.cjs`, `electron/preload.cjs`, `electron/services/*`。
- Web: `Resources/web/index.html`, `web-src/main.ts`, `editor/monaco.ts`, `ui/sidebar.ts`, `ui/quickInsert.ts`, `ui/issues.ts`, `ui/diffPreview.ts`, `theme.css`。
- `.tex180/` 管理: `blocks.json`, `settings.json`, `cache/index.json`, `issues.json`。

### C) マイルストーン計画（DoD付き）
- Phase 0: Electronが`Resources/web/index.html`を表示（DoD: 起動でWeb UIが表示）。
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
- Electronで`Resources/web/index.html`を読み込み、表示確認できる状態にする。

### 追加制約
- 外部クラウド依存なし（完全ローカル）。
- MVPはAI機能（LLM呼び出し）なし。差分UIは将来拡張前提で可。
- PDFは別ウィンドウで、成功時のみ更新。
- 仕様外の機能追加は禁止（提案は分離して提示）。

## tex180 全体設計案（ユーザー追加）
### 0) 目的と前提
- 対象は論文/講義ノート。コード編集が主で、ノーコードは外付け。
- 安定性重視（特にIME/選択が壊れない設計）。
- UIはVSCode風を参考にしつつTeX向けに必要導線だけ洗練。

### 1) ウィンドウ構成
- 編集メイン: 右=エディタ、左=縦タブ（Files/Outline/Block/Git、必要ならSearch/Settings）、下=Issues。
- PDF: 別ウィンドウ、root単位で1つを使い回し、成功時のみ更新。

### 2) 編集体験の主線
- フォルダを開く/テンプレで新規作成 → root自動検出（不可なら手動指定）。
- 執筆→Block挿入→Build/Auto BuildでPDF更新→Issuesで修正→Gitで差分確認。

### 3) 挿入UXの共通ルール
- 位置可視化 / 事前プレビュー / Accept・Cancel（Undoも用意）。

### 4) ノーコード（Block）設計
- 本文DOMは触らず、外付けパネルで生成→TeX挿入。
- 数式/表/図を段階的に拡張。
- 再編集用メタ（blockID/内部JSON/deps）を `.tex180/blocks.json` に保存。

### 5) 参照・引用設計
- cite/ref/label の補完・プレビュー・定義ジャンプ。
- .bib は検索/プレビューで引用キー選択。
- 未解決参照はIssuesに集約。

### 6) Build / Issues / PDF更新
- 手動＋Auto Build。成功時だけPDF更新、失敗時はIssuesに集約。
- ログ全文は通常非表示。

### 7) レイアウト
- パネル比率の調整（左幅/Issues高さ）。
- 将来のミニOutline/パレットジャンプを想定。

### 8) 技術構成
- Electron（殻）＋TypeScript（Renderer）＋Node（サービス）。
- 編集/ビルドはオフライン前提（AIは将来拡張）。

### 9) 実装優先順位
- MVP: Open Folder/編集保存/root検出/Build+PDF/Issuesジャンプ。
- 次: Quick Insert、数式Block（プレビュー＋Accept/Cancel）。
- その次: cite/ref/label補完、Outline、SyncTeX（必要時）。

## 各フェーズの実装方針（簡易）
- Phase 0: Electronでバンドルの`Resources/web/index.html`を読み込み、失敗時のフォールバックUIを用意する。
- Phase 1: Monacoをローカル同梱、`file://`向けWorker起動、基本編集のみ。
- Phase 2: 左タブの選択状態/表示切替、上部ミニOutline枠の動的更新。
- Phase 3: Quick Insertはターゲット可視化→プレビュー→Accept/Cancelを必須にし、Undo導線をつける。
- Phase 4: Build/Indexerは非同期でキャンセル可能、成功時のみPDF更新、失敗はIssues要約。
- Phase 5: Indexerで参照抽出し、補完候補/定義ジャンプをWeb側へ通知。
- Phase 6: `.tex180/blocks.json`にメタ保存し、ブロック再編集UIで再利用。
- Phase 7: Auto Build/検索/Gitは最小スコープで導入。
- Phase 8: 署名/サンドボックス/配布の最終調整。

## 実装詳細（現状）
### Electron/Node
- `electron/main.cjs` がBrowserWindowを生成し、`Resources/web/index.html` を読み込む。
- `electron/preload.cjs` が `window.tex180Bridge` を公開し、Web側の `postMessage` をIPCへ中継する（`window.webkit.messageHandlers.tex180` は互換用）。
- `electron/services/workspace.cjs` がワークスペース選択/ファイル操作/メインTeX検出/設定保存を担当する。
- `electron/services/build.cjs` が `latexmk` をバックグラウンド実行し、Issuesを生成する（UIはブロックしない）。
- `electron/services/indexer.cjs` が `.tex`/`.bib` から `label/ref/cite` を抽出し、アウトライン/補完/ジャンプに渡す（非同期）。
- `electron/services/blocks.cjs` が `.tex180/blocks.json` の読み書きを行う（必要時のみ作成）。
- `electron/services/search.cjs` / `electron/services/git.cjs` が検索結果とGitステータスを非同期で取得する。
- `electron/services/pdf.cjs` が成功時のみPDFを別ウィンドウで表示し、同一rootの再ビルドで使い回す。
- テンプレート選択/新規プロジェクト作成はElectronのダイアログで行う。

### Web
- `Resources/web/index.html` はVSCode風スケルトン（トップバー/左タブ/エディタ/Issues）とMonacoのホスト要素（`#editor`）を定義する。
- `Resources/web/theme.css` はダーク寄りのフラットスタイル（細いボーダー/影なし/アクセント青）に統一し、エディタ領域を全面占有にする。
- `Resources/web/main.js` は初期表示のフェードインとMonacoの読み込みを担当し、読み込み失敗時はフォールバック文言を更新する。
- `web-src/main.ts` で左タブの選択状態を管理し、ミニアウトライン/ステータス/プレースホルダ文言をタブに応じて更新する。
- Quick Insertはトップバーのボタンで開き、ターゲット行をハイライト/ガター印/宛先表示し、エディタ内の挿入行「下」にプレビューを出してAccept/Cancelを行う。
- アウトラインに章節/図/表/TODO/ラベル/参考文献キーを表示し、クリックで定義行へジャンプする。
- `\ref{}` と `\cite{}` の補完候補をMonacoで提示する（定義元のラベル/参考文献を参照）。
- ブロックタブで数式/表のノーコード挿入を行い、プレビュー→確定/キャンセルで挿入する。
- 数式ブロックはMathLiveを組み込み、数式入力をリッチ化する（未読込時はテキスト入力にフォールバック）。
- 数式キーボードはMathLive直下に配置し、上段タブ + 下段固定の2段構成（Shiftで代替キー）にする。
- ブロックは `.tex180/blocks.json` にメタ保存し、一覧から再編集（該当箇所の置換）できる。
- 自動ビルドは保存後にのみ走る（編集時は予約して保存で実行）。
- 検索タブでワークスペース検索を行い、結果クリックでジャンプする。
- Gitタブで `git status --porcelain` の最小表示を行う。
- 設定タブに自動ビルド切替とワークスペース表示を追加する。
- 設定タブにメインTeXの自動検出/手動指定UIを追加する。
- ビルドボタンは `window.tex180Bridge.postMessage` で送信し、Issuesバーはネイティブからの結果で更新する（`window.webkit.messageHandlers.tex180` は互換用）。
- Issuesバーは成功/失敗/進行中で色味を切り替える（詳細ログは出さない）。
- Issuesパネルは必要時のみ展開し、エラー/警告の一覧と行番号ジャンプを提供する。
- サイドバーにエクスプローラーを追加し、フォルダ選択→ファイル一覧→クリックで開く流れを用意する。
- 保存は「保存ボタン/⌘S」で明示的に行い、保存前はファイル名に印を出す。
- ビルド時に編集中のファイルが`.tex`ならそのファイルを対象にする（未選択時は`main.tex`）。
- ファイル一覧は`.git`や`node_modules`などを除外し、ワークスペース配下のみ表示する。
- ファイルツリーの折りたたみ状態はワークスペース単位で保持する。
- 新規ファイル/フォルダは最小UI（prompt）で作成し、作成後に一覧を更新する。
- Web側の準備完了時にワークスペース情報を再送して、未選択表示を防ぐ。
- ワークスペースを開いた直後にメインTeX（未指定なら最初のTeX）を自動で開く。
- アプリ起動時に「新規プロジェクト作成 / 既存フォルダを開く」を選択し、エディタ画面ではフォルダ選択ボタンを出さない。
- 新規プロジェクトは `main.tex` のみ作成し、`.tex180` は必要時に作成する。
- 大きな変更を行ったら必ず `npm run web:build` とElectronの起動確認を行う。
- Monacoは `monaco-editor@0.55.1` の `min/vs` を `Resources/web/monaco/vs` に同梱し、`loader.js` からAMDロードする（バンドル内では `web/monaco/vs`）。
- `file://` でも動くよう `MonacoEnvironment.getWorkerUrl` でBlob URLを生成し、Workerを起動する。
- Monacoの初期設定は `vs-dark` / `automaticLayout` / `minimap: false` / `fontSize: 13` / `lineHeight: 20` など。
  - Monacoの既定ショートカットは維持（無効化しない）。
  - `web-src/main.ts` を `npm run web:build` で `Resources/web/main.js` に出力する。
  - ビルドは `package.json` の `web:build` スクリプトで行う。

### バンドル/リソース
- `Resources/web` をElectronアプリから `Resources/web/index.html` として読み込む。
- MathLiveは `Resources/web/mathlive` に同梱し、オフラインで数式入力を提供する。

- 旧Swift版の履歴（Electron移行前の記録）。
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
- 2025-12-25: 左タブの切替でミニアウトライン/ステータス/プレースホルダ文言が変わるようにした。
- 2025-12-25: Quick InsertのUI（挿入行の下にプレビュー/ターゲット可視化/Accept/Cancel）を実装した。
- 2025-12-25: Phase 4の土台として、ビルド要求のネイティブ連携とIssuesバー更新、成功時のみPDF表示を実装した。
- 2025-12-25: Issuesパネルに詳細一覧を追加し、クリックで該当行へジャンプできるようにした。
- 2025-12-25: エクスプローラー（フォルダ選択/ファイル一覧/保存/開く）を追加した。
- 2025-12-25: ファイルツリーの折りたたみ状態を保持し、新規ファイル/フォルダ作成を追加した。
- 2025-12-25: 起動時のプロジェクト選択でワークスペース未選択状態を解消した。
- 2025-12-25: 起動時のプロジェクト選択画面を追加し、エディタ内のフォルダ選択UIを削除した。
- 2025-12-25: 起動時のプロジェクト選択画面を洗練（背景グラデーション/グリッド、カード構成、ボタンスタイルを調整）。
- 2025-12-25: 起動画面の余計な補足UI（カプセルラベル）を削除して簡潔にした。
- 2025-12-25: Indexerでlabel/ref/citeを抽出し、アウトライン表示/補完/定義ジャンプを追加した。
- 2025-12-25: 数式/表ブロックの挿入UIとblocks.jsonの保存/再編集を追加した。
- 2025-12-25: Auto Build / Search / Git / Settings の最小実装を追加した。
- 2025-12-25: タブ切替時に各ファイルのカーソル/スクロール状態を保存し、戻ったときに復元する。
- 2025-12-25: IME変換中でもフォルダの開閉ができるようにし、入力中の状態を崩さない。
- 2025-12-25: `xcodebuild -scheme tex180 -configuration Debug -destination platform=macOS build` でビルド確認を実施（multiple destinations の警告のみ）。
- 2025-12-25: `.tex180` は必要時のみ作成する方針に変更（新規作成時は作らない）。
- 2025-12-25: メインTeXの自動検出/手動指定UIを追加し、設定ファイルに保存できるようにした。
- 2025-12-25: アウトラインに章節/図/表/TODOの抽出と表示を追加した。
- 2025-12-25: 新規プロジェクトにテンプレート選択（論文/講義ノート）を追加した。
- 2025-12-25: MathLiveを同梱して数式入力をリッチ化した。
- 2025-12-25: `xcodebuild -scheme tex180 -configuration Debug -destination platform=macOS build` を再実行（multiple destinations の警告のみ）。
- 2025-12-25: ワークスペースを開いた直後にメインTeXを自動で開くようにした。
- 2025-12-26: `xcodebuild -scheme tex180 -configuration Debug -destination platform=macOS build` を実行（multiple destinations の警告のみ）。
- 2025-12-26: 編集状態のドットは保存内容と一致したら消えるようにした。
- 2025-12-26: 新規ファイル/フォルダ作成をモーダル入力に変更し、選択中のフォルダ（またはアクティブファイルの親）を作成先にした。
- 2025-12-26: 空フォルダも表示できるように、ワークスペースのフォルダ一覧を送信してツリーに反映した。
- 2025-12-26: フォルダ選択時のツリー再描画を止めて、選択のちらつきを抑えた。
- 2025-12-26: フォルダの開閉を手動トグルにして、ネストされたフォルダでも確実に開閉できるようにした。
- 2025-12-26: フォルダ開閉時の三角表示を明示クラスで制御して、向きが確実に変わるようにした。
- 2025-12-26: 三角の回転判定を `details[open]` から `summary.is-open` のみに統一した。
- 2025-12-26: 新規作成モーダルの見た目を軽くして、設定タブのレイアウトをカード化した。
- 2025-12-26: ファイル/フォルダの右クリックメニュー（開く・Finder・ターミナル・パスコピー・名前変更・削除）を追加した。
- 2025-12-26: 右クリックメニュー用にリネーム/削除/Finder/Terminal操作を追加した。
- 2025-12-26: `xcodebuild -scheme tex180 -configuration Debug -destination platform=macOS build` を実行（multiple destinations の警告のみ）。
- 2025-12-26: エディタ上部にタブを追加し、アウトラインを表示中ファイルのみに絞った。
- 2025-12-26: `xcodebuild -scheme tex180 -configuration Debug -destination platform=macOS build` を実行（multiple destinations の警告のみ）。
- 2025-12-26: チェックリスト6以降の確認用に `test-workspace` を追加（章節/図表/TODO/ラベル/引用/複数ファイル/検索用データ）。
- 2025-12-26: TODO抽出は行頭の `TODO:`（コメント含む）と `\todo{...}` のみに限定し、通常文中の TODO は拾わないようにした。
- 2025-12-26: インデックスの行番号は空行も含めてカウントするように変更し、アウトラインジャンプのズレを解消した。
- 2025-12-26: アウトラインの行数/ファイル表示を廃止し、章節に番号（1章/1.1節…）と階層インデントを表示するようにした。
- 2025-12-26: インデックスの行分割は空行保持のまま、Swiftの `split` 呼び出しを正しい引数順に修正した。
- 2025-12-26: アウトラインジャンプで付く行ハイライトは、編集したら自動で解除するようにした。
- 2025-12-26: エクスプローラー上部の新規ファイル/新規フォルダボタンを削除した。
- 2025-12-26: 右クリックメニューから統合ターミナル/パスコピー項目を削除し、標準メニューが出ないように抑制した。
- 2025-12-26: ファイルツリーの文字選択を無効化し、ドラッグ&ドロップでファイル/フォルダ移動できるようにした。
- 2025-12-26: `xcodebuild -scheme tex180 -configuration Debug -destination platform=macOS build` を実行（multiple destinations の警告のみ）。
- 2025-12-26: ファイルツリーの右クリック標準メニューをWKWebView側で無効化した。
- 2025-12-26: 未保存でもタブ切替/閉じるができ、未保存状態をファイルツリーに表示するようにした。
- 2025-12-26: ファイル/フォルダのコピー・カット・貼り付け（⌘C/⌘X/⌘V）と、直前操作の取り消し（⌘Z）を追加した。
- 2025-12-26: アウトラインの各分類を折りたためるようにした。
- 2025-12-26: `xcodebuild -scheme tex180 -configuration Debug -destination platform=macOS build` を実行（multiple destinations の警告のみ）。
- 2025-12-26: 未保存の変更があるファイル/フォルダ削除時は警告確認の上で削除できるようにした。
- 2025-12-26: 削除時に macOS のゴミ箱移動に失敗した場合は `.tex180/.trash` へ退避して、Undoで復元できるようにした（サンドボックス対策）。
- 2025-12-27: ファイル行へのドラッグ&ドロップは、そのファイルと同じ階層への移動として扱うようにした。
- 2025-12-27: タブ切替後に `⌘Z` が効かない問題を避けるため、エディタにフォーカスした時はツリー側ショートカットの捕捉を解除するようにした。
- 2025-12-27: ビルド成功時のPDF検出は、メインTeXと同じ階層のPDFを参照するように修正した（サブフォルダ対応）。
- 2025-12-27: 新規作成モーダルの文言を整理し、見た目を軽く整えた。
- 2025-12-27: ファイル上へのドロップ時は、ファイルではなく同階層の領域をドロップ対象として強調するようにした。
- 2025-12-27: IME変換中のタブ切替/保存で入力が落ちないように、変換終了後に処理を実行するガードを追加した。
- 2025-12-27: ファイル右クリックから同階層への新規ファイル/フォルダ作成ができるようにした。
- 2025-12-27: サイドバー幅を詰め、検索UIをコンパクト化し、ミニアウトライン表示を廃止した。
- 2025-12-27: `latexmk` がGUIから見つかるよう、Build実行時に PATH を明示的に設定した。
- 2025-12-27: ドロップ対象の判定を厳密化し、ファイル間の隙間でルート全体が選択されないようにした。
- 2025-12-27: IME変換中にサイドバー操作で入力が消えないよう、サイドバー操作時は既定動作を抑止して変換確定を待つようにした。
- 2025-12-27: IME変換中にタブ切替/タブ閉じるを行う場合は、変換確定後に処理されるようにして入力消失を防いだ。
- 2025-12-27: タブ切替後もUndo履歴が残るように、Monacoをファイルごとのモデルで管理する方針に変更した。
- 2025-12-27: サイドバーのタブをアイコン表示にし、文字ラベルはスクリーンリーダー用に隠した。
- 2025-12-27: 新規作成モーダルの日本語文言とレイアウトを整理し、見た目を洗練させた。
- 2025-12-27: `xcodebuild -scheme tex180 -configuration Debug -destination platform=macOS build` を実行（multiple destinations の警告のみ）。
- 2025-12-27: MathLive内蔵キーボードを無効化し、エディタ下部にカスタム数式キーボード（分類タブ付き）を追加した。
- 2025-12-27: 数式ブロックのMathLive入力欄の見た目を調整した。
- 2025-12-27: カスタム数式キーボードを数式入力欄の直下に移動した。



## 既知の警告ログ（現時点で致命ではない）
- Modifying state during view update, this will cause undefined behavior.（修正: WebViewの状態更新はmain async）
- Could not create a sandbox extension for '/Users/wedd/Library/Fonts/APJapanesefont.ttf'
- AFIsDeviceGreymatterEligible Missing entitlements for os_eligibility lookup
- Unable to create bundle at URL ((null)): normalized URL null
- precondition failure: unable to load binary archive for shader library: /System/Library/PrivateFrameworks/IconRendering.framework/Resources/binary.metallib ...
- WebContent[...] Unable to hide query parameters from script (missing data)
- Error acquiring assertion: RBSServiceErrorDomain (runningboard.assertions.webkit のエンタイトルメント不足)
- Message from debugger: killed

## Electron移行メモ（WIP）
- Swiftの殻を置き換え、Electron（`electron/main.cjs`）でWeb UIを起動する方針に変更。
- Web→ネイティブ連携は `window.tex180Bridge.postMessage` を採用し、従来の `window.webkit.messageHandlers.tex180` も併存。
- Node側にWorkspace/Build/Indexer/Blocks/Search/Git/PDFの各サービスを移植（`electron/services/*`）。
- PDFはElectronの別ウィンドウで表示し、ビルド成功時のみ更新。
- 削除Undoの安定性を優先して `.tex180/.trash` に退避（OSゴミ箱直結は後で再検討）。
- TeX環境の導線（TinyTeX固定や不足パッケージの自動導入UI）は後で実装。
- 開発の起動手順: `npm run web:build` → `npm run electron:dev`。
