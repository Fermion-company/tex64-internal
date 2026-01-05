# tex180 統合メモ
このファイルが設計・運用・課題の単一ソースです。旧メモ類は参照のみ（内容は本ファイルに統合）。

## 0. 目的
- UIや機能の「どこを指しているか」を正確に共有する。
- 方針・設計・課題・運用ルールを1本化する。
- 仕様変更時はここを更新して整合性を保つ。

## 1. 現在の構成（概要）
- Electron殻: `electron/main.cjs` がメインUIのみを起動（別ウィンドウのブロック編集は廃止）。
- Bridge: `electron/preload.cjs` が `window.tex180Bridge` を公開しIPCを中継。
- Web UI: `Resources/web/index.html` + `Resources/web/main.js`（エントリ）+ `Resources/web/app/*.js`（分割モジュール）。
- Monaco: メイン編集体験の中心（`web-src/main.ts` エントリ + `web-src/app/*`）。
- Services: `electron/services/*` がワークスペース/ビルド/検索/Git/Indexer/PDFを担当。

## 2. UI名付けマップ（メインウィンドウ）
- UI-Launcher: 起動直後のプロジェクト選択画面。`#launcher` / `.launcher-*`。
- UI-Topbar: 上部ヘッダ枠。`.topbar`（現在は空）。
- UI-SidebarRail: 左の縦アイコン列。`.sidebar` 内の `.tab-group` / `.tab[data-tab]`。
- UI-SidebarPanels: サイドバー詳細。`.sidebar-panel` と `.panel[data-panel=...]`。
  - パネルキー: files / outline / blocks / git / search / settings
- UI-FileExplorer: ファイルツリー。`#workspace-label`, `#file-tree`, `#save-file-button`。
- UI-OutlinePanel: アウトライン一覧。`#outline-sections`, `#outline-todos`, `#outline-labels`, `#outline-citations`。
- UI-BlocksPanel: 数式/表の簡易編集UI。`#block-math-input-container`, `#block-table-rows`, `#block-table-cols`, `#block-insert-button`。
- UI-MathKeyboardDock: 数式キーボード。`#math-keyboard-dock`, `#math-keyboard-grid`, `#math-keyboard-fixed-grid`。
- UI-GitPanel: Gitステータス。`#git-status`, `#git-refresh`。
- UI-SearchPanel: 検索UI。`#search-input`, `#search-button`, `#search-results`。
- UI-SettingsPanel: 設定UI。`#settings-auto-build`, `#settings-root-select`, `#settings-root-auto`, `#settings-workspace`。
- UI-EditorTabs: 開いているファイルタブ。`#editor-tabs`, `#editor-tabs-list`。
- UI-EditorActions: エディタ右上の操作。`#build-button`。
- UI-EditorSurface: Monacoホスト。`#editor` / `.editor-host`。
- UI-EditorFallback: Monaco未読込時のプレースホルダ。`#editor-fallback`。
- UI-QuickInsert: クイック挿入パネル。`#quick-insert`, `#quick-input`, `#quick-hint`, `#quick-accept`, `#quick-cancel`。
- UI-IssuesBar: 画面下部のIssuesバー。`#issues-bar`, `#issues-count`, `#issues-hint`。
- UI-IssuesPanel: Issues詳細。`#issues-panel`, `#issues-list`, `#issues-close`。
- UI-Resizer: サイドバーとエディタ間の分割バー。`#resizer`。
- UI-ModalCreate: 新規作成モーダル。`#create-modal` / `#create-modal-input`。
- UI-ModalRename: リネームモーダル。`#rename-modal` / `#rename-modal-input`。
- UI-ModalDiff: 差分確認モーダル。`#diff-modal` / `#block-diff-container`。
- UI-ContextMenu: 右クリックメニュー。`#context-menu` / `#context-menu-panel`。

## 3. 主要フロー / IPC
Renderer → Main（postMessage type）:
- ready / openWorkspace / requestWorkspace / createProject
- build / openFile / saveFile
- createFile / createFolder / renameItem / deleteItem / moveItem / copyItem / undoFileOperation
- revealInFinder / openInTerminal / setRoot / detectRoot
- requestIndex / search / gitStatus

Main → Renderer（tex180:message type）:
- setBuildState / updateIssues / updateWorkspace / updateIndex
- updateSearch / updateGit / openFileResult / saveResult / renameResult / launcherStatus

## 4. 数式/表編集（サイドバーの現行仕様）
- 目的: Monaco上の最小単位の数式/表を自動検出し、右側入力欄で編集→差分プレビュー→確定挿入。
- UI: Blocksタブのみ。数式/表の種類選択は内部判定、UI上は「形式: 自動判定」程度の弱い表示。
- 自動検出: カーソル位置から最小単位の数式/表を検出し、スナップショット（start/end/snippet/version）を保持。
- 差分プレビュー: 差分モーダルで確認（インライン差分）。
- 挿入: 確定時にスナップショットを検証し、Monacoの範囲置換で適用。

### 4-1. 検出ロジック（実装詳細）
- 走査: 1パスで全文スキャン（`collectLatexBlocks`）。`%` コメント行はスキップ。
- raw環境: `verbatim` / `Verbatim` / `lstlisting` / `minted` 内は検出対象外。
- 対応ラッパー: `$...$` / `$$...$$` / `\(...\)` / `\[...\]` を検出。
- 環境: `\begin{...}...\end{...}` をスタックで検出し、レジストリで math/table を判定。
- 最小単位: 候補の長さで最小を採用（同サイズは math を優先）。
- 未知環境: 名前に `math/eqn/align/gather/matrix/cases/split/subeq/array/formula` を含めば math 扱いのフォールバック。
- 可視化: 検出対象のブロックは Monaco 上で全行ハイライト＋左ガイドで強調表示。

### 4-2. 環境レジストリ（パッケージ由来）
- 既定レジストリ: LaTeX/amsmath/周辺（mathtools/breqn/IEEE/mathpartir/empheq）を収録。
- *版: `equation*` などはベース名で判定するため自動対応。
- discouraged: `eqnarray` は「読むが推奨しない」扱いとして内部フラグ化。
- 追加登録: `localStorage` の `tex180.custom-env-registry` から追加読み込み。
  - `window.__tex180SetCustomEnvRegistry(...)` で runtime 追加/更新可能。
  - `window.__tex180GetEnvRegistry()` で現在の一覧を取得可能。
- UI: 設定タブで環境の追加/有効・無効切替が可能（数式/表別リスト）。

### 4-3. 数式入力/UI
- MathLive: 右側の数式欄は `<math-field>` を使用。`input/change` で内部値を同期。
- フォールバック: MathLive が使えない場合は `value` の文字列を採用。
- キーボード: 固定キー＋タブ切替、Shift状態で別挿入が可能。

### 4-4. 差分プレビュー/挿入
- 差分は内側だけ比較: `prefix/suffix` を保持し、差分は中身のみで表示。
- 行番号: 内側の開始行を基準にオフセットをかける。
- 挿入安全策: スナップショット一致チェックでズレを防止（不一致時は再検出を促す）。
- 置換方式: `prefix + 新しい中身 + suffix` の注入。中身が同じなら元スニペットを保持。
- 新規挿入: ラッパーが無い場合は `\[...\]` がデフォルト。

### 4-5. E2Eテスト（数式）
- 1: 検出カバレッジ（`$...$`/`$$...$$`/`\(...\)`/`\[...\]`/主要環境 + raw/コメント除外）。
- 2: 差分/挿入（内側差分 + ラッパー保持 + 取り違え防止 + 新規挿入）。

## 5. 方針（UX/安定性）
- 安定性最優先（入力が壊れない/落ちない/状態が迷子にならない）。
- 自動確定は禁止（提案はOK、確定はユーザー操作のみ）。
- 重い処理は非同期（Index/BuildはUIをブロックしない）。
- PDF更新はビルド成功時のみ、失敗時は前回成功PDFを保持。
- ログ洪水禁止（ログは隠し、Issuesが一次窓口）。
- 挿入UIの鉄則: 1) ターゲット可視化 2) 事前プレビュー 3) Accept/Cancel + Undo導線。
- UI構成はVSCode風（左タブ/右エディタ/下Issues/上ビルド）。
- 外部クラウド依存なし（完全ローカル）。
- 新機能追加時は必ずテストを実行（最低でも `npm run e2e`）。

## 6. 既知課題（現行）
### 6-1. 数式挿入（サイドバー）の差分ズレ/自動判定
- 状態: 検出/差分/挿入は改善済みだが、検出精度と多パターン検証は継続課題。
- 範囲: Blocksタブでの数式/表の自動検出と挿入。
- チェック項目:
  - [ ] `$...$` / `\(...\)` / `\[...\]` / `$$...$$` / `\begin{equation|align|gather|multline}` の自動切替が安定している。
  - [ ] `tabular` を検出したとき表編集が自動で開く。
  - [ ] 差分プレビューと確定後の挿入結果が一致する。
  - [ ] 検出対象が途中で変わった場合、誤適用せず再検出を促す。

### 6-2. アウトライン/参照抽出の誤検出・取りこぼし
- 範囲: Indexer/Outline（参照・図表・TODO抽出）。
- 期待: コメント/複数行/派生コマンドを含めて正確に抽出される。
- チェック項目:
  - [ ] `% TODO:` のコメントがアウトラインに出る。
  - [ ] コメントアウトされた `\label{}` が拾われない。
  - [ ] 複数行の `\section{...}` / `\caption{...}` が拾われる。
  - [ ] `\citep{}`/`\citet{}` が候補に出る。

## 7. ビルド/生成物
- `npm run web:build`:
  - `web-src/main.ts` → `Resources/web/main.js`
  - `web-src/app/*.ts` → `Resources/web/app/*.js`

## 8. 主要ファイルマップ
- `Resources/web/index.html` — メインUI構造
- `Resources/web/theme.css` — メインUIスタイル
- `Resources/web/main.js` — メインUIロジック（ビルド成果物/エントリ）
- `Resources/web/app/*.js` — 分割されたUIロジック（ビルド成果物）
- `web-src/main.ts` — メインUIロジック（エントリ）
- `web-src/app/config.ts` — タブ/ラベルの定義
- `web-src/app/dom.ts` — DOM参照の収集
- `web-src/app/env-registry.ts` — LaTeX環境レジストリ
- `web-src/app/math-keyboard.ts` — 数式キーボード定義
- `web-src/app/files.ts` — 拡張子/ファイル判定
- `web-src/app/diff.ts` — 差分ユーティリティ
- `web-src/app/viewer.ts` — PDF/画像ビューア
- `web-src/app/types.ts` — UI共通型定義
- `electron/main.cjs` — Electronメインプロセス
- `electron/preload.cjs` — Bridge公開
- `electron/services/*` — Build/Index/Search/Git/Workspace/PDF

## 9. レガシー/アーカイブ（再導入する場合の設計メモ）
### 9-1. 別ウィンドウのブロック編集（廃止）
- 安定性の観点で別ウィンドウのノーコード編集は廃止。
- 再導入する場合は、差分適用の安全性を最優先で設計すること。

### 9-2. ブロック編集の設計アイデア（要約）
- ロスレスAST + ブロック投影 + 最小差分パッチが最も安全。
- 未対応部分は Raw Block に落として「壊れない」編集を担保する。
- ブロックIDは `\label` 優先、無い場合はハッシュ + 周辺文脈。
- 変換・正規化は最小限に抑え、未編集ブロックは原文を維持。

#### タスク処理（統一フォーマット・優先度順）
- ユーザーメモ（設計指針）以下はタスクでもあります。
- UI調整の共通ルール:
  - 目的: 見た目/配置の整理のみ。機能ロジックは変更しない。
- 触ってよいファイル: `Resources/web/theme.css` と `Resources/web/index.html` が基本。
  - `web-src/main.ts` または `web-src/app/*.ts` を触った場合は必ず `npm run web:build` を実行して `Resources/web/main.js` を更新する。
  - 変更禁止: 色味やテーマ変数（`:root`）の変更、既存のID/クラス名の削除。
  - 検証: UIを開いて崩れがないこと、クリック不能になっていないことを確認。

##### P0-1. コンパイルエンジン選択（最重要）
- 目的: 投稿先やテンプレに合わせてエンジンを切替可能にする。
- 現状:
  - `electron/services/build.cjs` の `runLatexmk()` が `-lualatex` 固定。
  - `electron/main.cjs` の `handleBuild()` はエンジン指定を受け取らない。
  - `Resources/web/index.html` の設定UIにエンジン選択がない。
  - `.tex180/settings.json` は `rootFile` しか保存していない。
- 実装方針:
  - エディタ設定（グローバル）でビルド方法を保存し、UIで切替。
  - `postToNative({ type: "build", engine })` でエンジンを渡し、`latexmk` 引数を切替。
- 具体タスク:
  1. `Resources/web/index.html` のエディタ設定にエンジン選択UI（`select` or segmented）を追加。
  2. `web-src/main.ts` に `buildEngine` 状態を追加し、エディタ設定から読み書きする。
  3. `web-src/main.ts` の `startBuild()` で `postToNative` に `engine` を追加。
  4. `electron/main.cjs` の `handleBuild()` で `engine` を受け取り `buildService.build()` に渡す。
  5. `electron/services/build.cjs` の `runLatexmk()` を `engine` に応じて引数切替。
  6. 不正値は `lualatex` にフォールバックし、UIに注意を出す。
- 完了条件:
  - エディタ設定として保存され、再起動後も維持される。
  - `pdflatex`/`lualatex` などを切替えてビルドが成功する。
- 要確認:
  - 対応エンジンの範囲（pdflatex / lualatex / xelatex / uplatex など）
  - 初期デフォルト（今の LuaLaTeX を維持？）
  - エンジン未検出時の挙動（エラー表示 or 自動フォールバック）

##### P0-2. SyncTeX（相互ジャンプ）
- 目的: PDF⇔エディタの行き来を高速化し、大量ページの修正を楽にする。
- 現状:
  - `electron/services/build.cjs` は `-synctex=1` を付けていない。
  - `electron/services/pdf.cjs` は単純な PDF 表示のみで、ジャンプ用のIPCがない。
  - `web-src/main.ts` に forward/reverse の導線がない。
- 実装方針:
  - `latexmk` に `-synctex=1` を付け、`synctex` CLI を使って位置解決する。
  - forward を最低ラインで先に対応、reverse は PDF ビューア方式と相談して対応。
- 具体タスク:
  1. `electron/services/build.cjs` に SyncTeX 有効化フラグ（`-synctex=1`）を追加。
  2. `electron/services/synctex.cjs`（新規）で `synctex view/edit` をラップ。
  3. `electron/main.cjs` に `synctexForward`/`synctexReverse` のIPCハンドラを追加。
  4. `web-src/main.ts` に「forward search」（エディタ位置→PDF）用のUI/ショートカットを追加。
  5. reverse search が必要なら PDF ビューア側（`editor-viewer` or 専用Window）にクリック検知を実装。
- 完了条件:
  - forward search で該当ページに移動できる。
  - reverse search を入れる場合はクリック位置から行が開ける。
- 要確認:
  - forward/reverse の優先度（まずは forward のみでOKか）
  - PDF表示は「別ウィンドウ維持」か「アプリ内ビューア強化」か
  - ショートカット/導線（コマンド or ボタン）

##### P0-3. スペルチェック
- 目的: 英語論文の Typo を減らし品質を上げる。
- 現状:
  - Monaco 標準のみでスペルチェックがない。
- 実装方針:
  - cspell / hunspell などを導入し、LaTeXコマンドや数式は除外。
  - Monaco の装飾 or Issues パネルに表示。
  - エディタ設定で ON/OFF を切替できるようにする。
- 具体タスク:
  1. スペルチェック用ライブラリの選定（cspell or hunspell）。
  2. LaTeX 向けの除外ルール（コマンド、数式、ラベル、URL）。
  3. `Resources/web/index.html` のエディタ設定に ON/OFF トグルを追加。
  4. `web-src/main.ts` にチェック結果の表示（下線/Issues/パネル）と ON/OFF 制御を実装。
  5. 辞書の追加/無視語の保存（ローカル or どこに保存するかを決める）。
- 完了条件:
  - 英文の Typo が下線またはIssuesに出る。
  - LaTeXコマンドや数式が誤検知されない。
- 要確認:
  - 対応言語（英語のみ/日英混在/日本語不要）
  - 辞書追加のUX（プロジェクト単位 or 全体）
  - 表示方法（下線だけ/Issuesにも出す）

##### P1-1. コンパイル体験（ビルド周り全般）
- 目的: 日常運用でのビルド体験を安定・分かりやすくする。
- 現状:
  - `web-src/main.ts` の `startBuild()` で `rootFilePath` or 現在ファイルをビルド。
  - `Resources/web/index.html` に `#build-button`、Issuesバーのみ。
  - `electron/main.cjs` の `handleBuild()` はログ全文をUIに出さない。
- 実装方針:
  - ビルド状態/対象ファイル/ログの見え方を整理。
- 具体タスク:
  1. ビルド対象（メインTeX）をUI上で明確化（設定パネルの表示強化 or ビルドボタン周辺に表示）。
  2. ビルド結果の詳細ログ表示の導線を追加（Issuesパネル内の展開領域など）。
  3. ビルド中/完了/失敗の状態表示を一貫させる（ボタン/ステータス/通知）。
- 完了条件:
  - 何をビルドしているかが常に分かる。
  - 失敗時にログの詳細に辿れる。
- 要確認:
  - ログ表示の粒度（全文表示/最初のN行/重要行のみ）
  - ビルド対象の表示場所（設定/ヘッダー/ボタン横）

##### P1-2. エラー処理（Issuesの精度）
- 目的: 失敗箇所に最短で辿れるようにする。
- 現状:
  - `IssueItem` は `severity/message/line` のみ（`web-src/app/types.ts`）。
  - `electron/services/build.cjs` の `parseIssues()` は行番号中心でファイル情報を持たない。
- 実装方針:
  - ファイルパス/行/列を保持し、クリックで該当ファイルを開く。
- 具体タスク:
  1. `electron/services/build.cjs` で `file:line` を抽出して `path` を追加。
  2. `IssueItem` 型に `path`（必要なら `column`）を追加。
  3. `web-src/main.ts` の `renderIssues()` でパス表示＋クリック時にファイルを開く。
  4. `focusIssue()` で別ファイルの場合は `openFile` してからジャンプ。
- 完了条件:
  - Issuesクリックで該当ファイル/行に移動できる。
  - 複数ファイルのエラーが混ざっても迷わない。
- 要確認:
  - エラー一覧に「ファイル名だけ表示」か「パス全表示」か
  - 警告の扱い（非表示/別セクション/色分け強調）

##### P1-3. ブロック編集の問題
- 目的: ブロック挿入や差分プレビューの不安定さを解消。
- 現状:
  - `Resources/web/index.html` の `.panel[data-panel="blocks"]` にブロックUI。
  - `web-src/main.ts` に MathLive/テーブル挿入/差分プレビュー処理が混在。
- 実装方針:
  - 問題点を洗い出し、再現ケース単位で修正する。
- 具体タスク:
  1. 問題の再現条件を整理（例: どのブロックで崩れるか）。
  2. 対応箇所（`syncDetectedBlockAtPosition` / `buildDiffPreview` / 挿入処理）を特定。
  3. 修正後に差分プレビューと挿入結果の一致を確認。
- 完了条件:
  - 再現ケースが全て解消する。
- 要確認:
  - 具体的に「壊れる」挙動の内容（操作手順/スクショ/再現ファイル）

##### P1-4. 長い数式の見た目調整（UI）
- 目的: 長い数式が切れず、入力中にレイアウトが崩れないようにする。
- 現状:
  - ブロック編集の数式入力は `math-field.block-math-field` 等で表示。
- 実装方針:
  - CSSで折り返し or 横スクロールを整理（ロジックは触らない）。
- 具体タスク:
  1. 対象: `Resources/web/index.html` のブロック編集パネル。
  2. 対象CSS: `Resources/web/theme.css` の `math-field.block-math-field` / `.block-math-preview-*` / `.block-math-input-container`。
  3. 長い数式がはみ出さないように折り返し or 横スクロールを調整。
  4. プレビュー側も同様に見切れないことを確認。
- 完了条件:
  - 長い数式が切れずに表示される。
  - 入力中にガタつかない。
- 要確認:
  - 望む挙動は「折り返し」か「横スクロール」か
  - どの画面が一番困るか（エディタ本文/ブロックパネル/プレビュー）

##### P1-5. 式挿入時の整理（UI）
- 目的: 数式キーボードから目的の記号に最短で辿れるようにする。
- 現状:
  - `web-src/app/math-keyboard.ts` の `mathKeyboardSets` に並びが定義。
  - UIは `Resources/web/index.html` のブロック編集パネルに出る。
- 実装方針:
  - 配列順序/ラベル整理で迷いを減らす（必要ならUI文言も整理）。
- 具体タスク:
  1. `web-src/app/math-keyboard.ts` の `mathKeyboardSets` とラベル順を整理。
  2. UI側ラベル/見出しの整合を取る（必要なら `Resources/web/index.html`）。
  3. `web-src/main.ts` または `web-src/app/*.ts` を触ったら `npm run web:build` 実行。
- 完了条件:
  - よく使う記号が上段/左側に集約される。
  - 文言が統一され、探しやすい。
- 要確認:
  - 探しづらいカテゴリ/記号
  - 優先して上段に置きたいカテゴリ

##### P1-6. 検索UIの見た目・レイアウト調整
- 目的: 検索が「おかしい」状態を解消し、結果が読みやすい表示にする。
- 現状:
  - `Resources/web/index.html` の検索パネル（`.panel[data-panel="search"]`）。
  - `Resources/web/theme.css` の検索関連クラスで表示。
- 実装方針:
  - UIのみ整理（ロジック変更なし）。
- 具体タスク:
  1. 対象: `.search-panel`, `.search-input-row`, `.search-input`, `#search-button`。
  2. 結果リスト `.search-results`, `.search-item`, `.search-item-meta` の余白/行高/折返しを整える。
  3. 空状態メッセージの見え方も確認。
- 完了条件:
  - 入力欄とボタンがずれず、結果が読みやすい。
  - 結果が長くてもスクロールで崩れない。
- 要確認:
  - どの点が「おかしい」のか（配置/余白/文字/スクロール/検索結果の見え方）

##### P1-7. ファイルツリーの保存ボタン整理
- 目的: 「保存」ボタンの役割を明確にし、迷いをなくす。
- 現状:
  - `Resources/web/index.html` の `#save-file-button` は `saveCurrentFile()` を呼ぶ。
  - Cmd+S と役割が重複している可能性がある。
- 実装方針:
  - 役割を再定義し、必要なら文言/位置/表示を整理する。
- 具体タスク:
  1. `#save-file-button` の文言/位置/表示を整理。
  2. 必要なら補助テキストを追加（見た目のみ）。
- 完了条件:
  - 何のボタンかが一目で分かる。
- 要確認:
  - ボタンは「残す/隠す/削除/別場所へ移動」のどれが希望か
  - 文言を「保存」から変えるなら、何にするか

##### P2-1. PDF/画像ビューアのUI外観
- 目的: PDF/画像/非対応表示の統一感を上げる。
- 現状:
  - `Resources/web/index.html` の `#editor-viewer` に画像/iframe/メッセージがある。
  - `web-src/app/viewer.ts` の `showImageViewer()` / `showPdfViewer()` で切替。
- 実装方針:
  - 見た目だけ整理（動作ロジックは変更しない）。
- 具体タスク:
  1. 対象: `#editor-viewer` と `.editor-viewer*`。
  2. 余白/枠線/影/角丸を整理し、アプリ全体と統一。
  3. 非対応表示の見え方を整理。
- 完了条件:
  - ビューア領域がアプリ全体と統一される。
- 要確認:
  - 目標の雰囲気（ミニマル/重厚/軽め）

##### P2-2. 設定充実（項目設計・保存方式）
- 目的: プロジェクト/編集設定を整理し、ユーザーが迷わない設計にする。
- 現状:
  - `Resources/web/index.html` に設定グループ（メインTeX/ワークスペース/整形/環境/自動ビルド/自動整形）がある。
  - 保存先は `localStorage` と `.tex180/settings.json` が混在。
- 実装方針:
  - 追加する設定を明確化し、保存場所（プロジェクト/グローバル）を整理。
- 具体タスク:
  1. 追加すべき設定項目の洗い出し（エンジン/SyncTeX/スペル等）。
  2. 保存先の方針決定（`.tex180/settings.json` or localStorage）。
  3. UIのグルーピング整理。
- 完了条件:
  - 設定の置き場と意味が明確になる。
- 要確認:
  - 追加したい設定の優先順
  - どれをプロジェクト単位にするか

##### P2-3. Git機能拡張
- 目的: アプリ内で簡易的に完結できるようにする。
- 現状:
  - `electron/services/git.cjs` は status のみ。
  - UIは `Resources/web/index.html` のGitパネルで一覧表示のみ。
- 実装方針:
  - まずは stage/commit の最小機能、必要なら push まで段階的に。
- 具体タスク:
  1. `electron/services/git.cjs` に stage/commit を追加。
  2. `electron/main.cjs` にIPC追加。
  3. `web-src/main.ts` にUI追加（チェック/コミット入力）。
- 完了条件:
  - アプリ内で最低限のコミットができる。
- 要確認:
  - push/pull まで必要か
  - 認証は「外部gitに任せる」か「アプリ内で対応」か

##### P2-4. 補完機能の拡張
- 目的: 入力補助を増やして執筆効率を上げる。
- 現状:
  - `web-src/main.ts` で `\\ref` / `\\cite` の補完のみ。
- 実装方針:
  - LaTeX標準コマンドや環境の補完を追加する。
- 具体タスク:
  1. `mathKeyboardSets` とは別に、テキスト用補完リストを追加。
  2. `\\section`, `\\begin{}` などのスニペット化。
  3. 既存の `registerCompletionProvider()` に統合。
- 完了条件:
  - よく使うコマンドが補完候補に出る。
- 要確認:
  - 優先して入れたいコマンド/環境

##### P3-1. MathLiveによる数式ブロック編集（維持）
- 目的: 強みである視覚的数式編集を維持。
- 現状:
- MathLive UIは `web-src/main.ts`（エントリ） + `web-src/app/math-keyboard.ts` で構成。
- 実装方針:
  - 回帰しないように周辺変更時に確認。
- 具体タスク:
  1. ブロックUI変更時に数式入力が動くか確認。
- 完了条件:
  - MathLive入力が壊れていない。

##### P3-2. 自動整形（latexindent）維持
- 目的: 保存時の整形品質を維持。
- 現状:
  - `electron/services/formatter.cjs` で latexindent を実行。
  - `web-src/main.ts` の `editor-auto-format` トグルで制御。
- 実装方針:
  - 変更時に既存の挙動が壊れていないことを確認。
- 具体タスク:
  1. 保存/ビルド時に整形が走るか確認。
- 完了条件:
  - 自動整形が動作し、エラー時に警告が出る。

##### P3-3. ビルドエラー解析の維持
- 目的: エラー行の抽出が壊れないようにする。
- 現状:
  - `electron/services/build.cjs` の `parseIssues()` で抽出。
- 実装方針:
  - 改修時にエラー抽出精度を落とさない。
- 具体タスク:
  1. 典型的なLaTeXエラーでライン抽出を確認。
- 完了条件:
  - エラー行がIssuesに出る。
