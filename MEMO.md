# tex180 統合メモ
このファイルが設計・運用・課題の単一ソースです。旧メモ類は参照のみ（内容は本ファイルに統合）。

## 0. 目的
- UIや機能の「どこを指しているか」を正確に共有する。
- 方針・設計・課題・運用ルールを1本化する。
- 仕様変更時はここを更新して整合性を保つ。

## 1. 現在の構成（概要）
- Electron殻: `electron/main.cjs` がメインUIのみを起動（別ウィンドウのブロック編集は廃止）。
- Bridge: `electron/preload.cjs` が `window.tex180Bridge` を公開しIPCを中継。
- Web UI: `Resources/web/index.html` + `Resources/web/main.js`。
- Monaco: メイン編集体験の中心（`web-src/main.ts`）。
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
  - `web-src/block-editor-app/*` → `Resources/web/block-editor.js` / `Resources/web/block-editor.css`（現状未使用だが生成物は残る）

## 8. 主要ファイルマップ
- `Resources/web/index.html` — メインUI構造
- `Resources/web/theme.css` — メインUIスタイル
- `Resources/web/main.js` — メインUIロジック（ビルド成果物）
- `web-src/main.ts` — メインUIロジック（ソース）
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

ユーザーメモ（設計指針）以下はタスクでもあります

プロジェクトごとの設定と、エディタで共通の設定は分ける　プロジェクト設定はサイドバーの一番下　エディタの設定は現在の設定欄
pdfファイルや画像等のファイルもエディタで開けるようにする(latexのプロジェクトに標準のファイルは入れる)それ以外は、非対応ファイルですという表示にして、検索除外
検索のUIおかしい
自動ビルド周りの機能を考える
ファイルツリーの保存ボタン何
ブロック編集の問題
git

