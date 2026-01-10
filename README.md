# tex64

Electron ベースの LaTeX エディタ（開発中）。

## この README の役割

- 設計/運用/タスクの単一ソース。詳細仕様は `map.md` / `test.md` / `docs/test-checklist.md` を補助資料として参照する。
- 旧メモ類は参照せず、この README を更新する。

## 開発

1. `npm install`（初回のみ）
2. `npm run web:build`
3. `npm run electron:dev`

AI（開発）:
- デフォルトは `https://tex64.vercel.app/api/ai-chat`。別のプロキシを使う場合だけ `TEX64_AI_PROXY_URL` を指定する。

E2E:

- `npm run e2e:install`
- `npm run e2e`
- `TEX180_E2E=1` で E2E モード（contextIsolation を無効化 / `?e2e=1` を付与）。
- `TEX180_E2E_WORKSPACE` / `TEX180_E2E_USERDATA` でワークスペース/ユーザーデータを指定。

## 編集ルール（重要）

- ロジック変更は `web-src/**/*.ts` と `electron/**/*.cjs`。
- `Resources/web/main.js` と `Resources/web/app/*.js` は `npm run web:build` の生成物なので直接編集しない。
- UI の見た目は `Resources/web/index.html` / `Resources/web/theme.css` / `Resources/web/pdf-viewer.*` を編集（ロジックは `web-src` 側）。
- 整形のベースは `Resources/latexindent.yaml`。実際の上書き設定は `.tex64/.format/` に生成される。
- `.tex64/` はワークスペースの内部状態（settings/blocks/trash）。手で編集しない。

## 安全な変更ガイド（AI/自動化向け）

目的: JS の誤編集や HTML/CSS の崩壊を防ぎ、変更の入口を固定する。

### 変更タイプと編集先（必ず守る）

| 変更内容 | 編集先 | 触ってはいけない |
| --- | --- | --- |
| メイン UI の見た目/レイアウト | `Resources/web/index.html`, `Resources/web/theme.css` | `Resources/web/main.js`, `Resources/web/app/*.js` |
| PDF ビューアの見た目 | `Resources/web/pdf-viewer.html`, `Resources/web/pdf-viewer.css` | `Resources/web/pdf-viewer.js`（見た目変更のみなら触らない） |
| UI の挙動/ロジック | `web-src/**/*.ts` | `Resources/web/app/*.js`, `Resources/web/main.js` |
| ブロック/MathLive の挙動 | `web-src/app/blocks/*.ts` | `Resources/web/app/blocks/*.js`, `Resources/web/mathlive/**` |
| Electron 側の挙動 | `electron/**/*.cjs` | - |
| Vendor 資産 | `Resources/web/monaco`, `Resources/web/mathlive`, `Resources/web/pdfjs`, `Resources/web/tesseract` | 直接編集しない |

### HTML/CSS 変更ルール（デザイン作業の安全策）

- `index.html` は「構造のみ」。見た目は `theme.css` に寄せ、`style` 属性や `<style>` を増やさない。
- `id` / `data-*` は UI の契約（JS から参照）。削除・改名が必要なら `web-src` の参照も同時に修正する。
- 新規 UI を追加する場合は `class` を追加し、CSS は `theme.css` で定義する。
- 色/影/角丸/サイズは `:root` の CSS 変数を優先し、ハードコードを増やさない。

### JS/TS 変更ルール（誤編集防止の仕組み）

- `Resources/web/main.js` / `Resources/web/app/*.js` は生成物。触る必要が出たら **必ず** `web-src` 側に戻す。
- `Resources/web/app/blocks/mathlive.js` の元は `web-src/app/blocks/mathlive.ts`。
- `Resources/web/pdf-viewer.js` は例外的に手書き。PDF ビューアの挙動変更時のみ編集する。
- `web-src` を編集したら `npm run web:build` で生成物を更新する（手書きで同期しない）。

### 変更フロー（最低限の手順）

1. 変更タイプを決めて「編集先」を固定する（上の表）。
2. 変更は最小差分で行う（不要な整形やリネームは禁止）。
3. `web-src` を触った場合のみ `npm run web:build` を実行。
4. 生成物を直接触っていないことを確認する。

## 構成

- Electron メイン: `electron/main.cjs` がウィンドウ/IPC/サービスを統括。
- Bridge: `electron/preload.cjs` が `window.tex64Bridge` を公開。PDF 窓は `electron/pdf-preload.cjs`。
- Services: `electron/services/*` (build/formatter/indexer/search/git/synctex/pdf/env/workspace/blocks)。
- Web UI ソース: `web-src/main.ts`（エントリ） + `web-src/app/**`。
- Web UI 生成物: `Resources/web/main.js` + `Resources/web/app/*.js`。
- Web UI 手書き: `Resources/web/index.html` / `Resources/web/theme.css` / `Resources/web/pdf-viewer.*`。
- Vendor assets: `Resources/web/monaco` / `Resources/web/mathlive` / `Resources/web/pdfjs` / `Resources/web/tesseract`。
- ドキュメント: `map.md`（ユーザーマップ）, `test.md`（E2Eタスク）, `docs/test-checklist.md`（手動チェック）。

## UI マップ（主要 ID）

- Top actions: `#editor-split-button`, `#format-button`, `#build-button`
- Tabs: `data-tab="files|outline|blocks|alchemy|issues|git|project|search|settings"`
- Files: `#workspace-label`, `#file-tree`
- Editor: `#editor`, `#editor-tabs-list`, `#editor-viewer`（secondary: `#editor-secondary`, `#editor-tabs-list-secondary`, `#editor-viewer-secondary`）
- Issues: `#issues-list`, `#issues-log`, `#issues-log-content`
- Blocks: `#block-math-input-container`, `#block-mode-toggle`, `#block-insert-button`, `#math-keyboard-dock`
- Diff modal: `#diff-modal`, `#diff-modal-submit`, `#diff-modal-cancel`
- Git: `#git-commit-message`, `#git-commit-button`, `#git-history`, `#git-pull`, `#git-push`, `#git-remote-url`, `#git-remote-save`
- Project/Settings: `#settings-root-select`, `#settings-root-auto`, `#settings-compile-engine`, `#editor-auto-synctex-build`, `#editor-pdf-window`

## 現行仕様（要点）

### プロジェクト/ワークスペース

- 起動時はランチャーのみ表示。新規作成はテンプレート（論文/講義ノート）で `main.tex` を生成。
- メイン TeX は自動検出 + 手動指定（`.tex64/settings.json`）に対応。
- ファイルツリーは `.git` / `.tex64` / `node_modules` / `Resources` などを除外し、フォルダ優先・名前順で表示。
- ツリー操作: 右クリックの独自メニュー、ドラッグ&ドロップ移動、`⌘C/⌘X/⌘V/⌘Z` でコピー/カット/ペースト/Undo。削除は即時で `.tex64/.trash` に移動。

### エディタ/ビューア

- Monaco で `.tex`/`.bib` を編集。`\\ref{`/`\\cite{` 補完はインデックスから供給。
- 編集後の短い遅延で自動保存。タブ切替/閉じるは確認なし。未保存内容はセッション内のみ保持。
- 分割ビュー（primary/secondary）を持ち、各グループでタブ/ビューアを独立表示。
- PDF/画像はプレビュー、非対応ファイルはメッセージ表示。

### ビルド/整形/SyncTeX

- ビルドは `latexmk` を使用。エンジンは `lualatex` / `pdflatex` / `xelatex` / `uplatex` から選択。
- 成功時のみ PDF を更新し、失敗時は前回成功 PDF を保持。ビルドログは Issues に表示。
- 整形は `latexindent` を使用し、インデント/Begin-End/align/空行/カスタム verbatim を設定可能。未導入/失敗時は簡易インデントでフォールバック。数式環境内の空行は削除する。
- SyncTeX は「ビルド時のみ forward」。手動ボタンは無効。エラーは Issues に集約。
- PDF の表示先はタブ/別ウィンドウを設定で切り替える。

### アウトライン/検索/Issues

- インデックスは章節/ラベル/引用/TODO/図表を収集。UI に表示するのは章節/TODO/ラベル/参考文献。
- 検索は `.tex` のみ、大小無視、最大 200 件。
- Issues は操作/ビルドの結果を集約し、クリックで該当行へジャンプ。

### ブロック/差分プレビュー

- 数式/表をブロックとして検出・編集。MathLive が使えない場合はテキスト入力にフォールバック。
- 自動検出はカーソル位置に追従し、`verbatim` 系は除外。
- 挿入/変更は共通の差分プレビューで確定。変更対象がズレた場合はエラー。
- ブロック履歴は `.tex64/blocks.json` に保存。

### 履歴/同期 (Git)

- Git の init/commit/restore/pull/push/remote 設定に対応。
- 保存/復元は差分プレビュー経由。同期失敗時はヒントを表示。

### 設定

- プロジェクトタブ: メイン TeX 選択と環境登録（数式/表の検出対象）。
- 設定タブ: コンパイルエンジン、SyncTeX、PDF 表示モード、整形設定、環境チェック/インストール。

## 方針（UX/安定性）

- 安定性最優先（入力が壊れない/落ちない/状態が迷子にならない）。
- 自動確定は禁止（提案は OK、確定はユーザー操作のみ）。
- 重い処理は非同期（Index/Build は UI をブロックしない）。
- PDF 更新はビルド成功時のみ、失敗時は前回成功 PDF を保持。
- ログ洪水禁止（Issues が一次窓口）。
- UI 構成は VSCode 風（左タブ/右エディタ/下部ステータス）。
- 設計方針に変更があったら `README.md` / `map.md` / `test.md` を更新する。

## 設計指針（コード構成）

- `web-src/main.ts` は配線に徹し、機能追加はモジュール化して import する。

## 取り込み機能（現行仕様）: Paste Alchemy / Magic Capture

### 入口 / 画面構成

- サイドバーに「取り込み」タブ（`data-tab="alchemy"`）が追加済み。ここで入力・変換・挿入まで完結する。
- パネル上部に「貼り付け」「ファイル」「カメラ（スクリーンショット）」の入口がある。
- 「取り込み」実行でLaTeX出力がリストに追加され、自動で取り込みタブに切り替わる。
- 「閉じる」は取り込みタブから元のタブに戻る動作（取り込みリスト自体は保持）。

### Paste Alchemy（貼り付け/ファイル取り込み）

#### 起動条件

- 取り込みタブ内の「貼り付け」欄に貼り付け → 「取り込み」を実行。
- 「クリップボードから取り込み」を押す（HTML/画像/PDF を一括取得）。
- 「ファイル」欄でファイルを選択 → 「取り込み」を実行。

#### 取り込み対象ごとの挙動

- HTML
  - `table` を検出すると「表アイテム」を生成（1テーブル=1アイテム）。
  - 残りの本文は「テキストアイテム」として生成（HTML→LaTeX 変換を保持）。
  - 変換の対応タグ: `p/div/section/article/br/strong/b/em/i/code/pre/a/ul/ol/li/table`。
- プレーンテキスト
  - HTMLが無い場合に「テキストアイテム」として生成。
  - 貼り付け欄のテキスト / テキストファイルの取り込みに対応。
- 画像
  - 画像は常に「図アイテム」として生成（数式/表/本文への自動分類はまだ無し）。
  - 画像はプレビューとして表示され、挿入形式を選べる。
- PDF
  - クリップボードの PDF バッファを取得し、pdf.js で全ページ解析。
  - 1ページ = 1アイテム（「テキストアイテム」扱い）として生成。
  - 解析中は「PDFを解析中...」のプレースホルダが出る。

#### 混在パターン（複合）

- HTML + 画像: 表アイテム + テキストアイテム + 図アイテムがまとめて追加される。
- HTML + PDF / 画像 + PDF など複数フォーマットが同時に入っている場合は、それぞれのアイテムが併存する。
- 取り込みは「上書きではなく追加」。連続貼り付けでアイテムがリストに蓄積される。

#### プレビュー / 操作

- アイテムごとにプレビュー（テキスト/表/画像）と LaTeX 出力が表示される。
- クリックでアクティブ項目を切り替えられる。
- 各アイテムに「挿入」「編集して挿入」「破棄」ボタン。
- パネル下部に「挿入（アクティブ）」「破棄」「全件挿入」ボタン。
- 「閉じる」を押したときのみ元のタブに戻る。

#### 挿入の中身（生成される LaTeX）

- テキスト
  - `plain`: HTML由来なら HTML→LaTeX 変換結果をそのまま挿入。
  - `quote`: `\begin{quote}...\end{quote}`。
  - `itemize`: 各行を `\item` に変換。
  - いずれも `\{}` や `%` などはエスケープされる。
- 表
  - `tabular` / `tabularx` / `longtable` に対応。
  - 列は最大列数に合わせて自動生成。空セルは空文字で埋める。
  - `tabularx` は `\linewidth` を使用。
- 図
  - `includegraphics`: `\includegraphics[width=\linewidth]{path}`。
  - `figure`: `figure` 環境 + `\caption{}` + `\label{}` を追加。
- 挿入位置
  - カーソル位置、または選択範囲を置換して挿入。
  - `.tex` 以外のファイルでは挿入できず、Issues にエラー表示。

#### 画像保存

- 図アイテムの LaTeX 出力生成時に、画像は `images/` フォルダに保存。
- フォルダが無い場合は自動作成。
- ファイル名は `capture-<timestamp>-<rand>.png` / `.jpg`。
- 挿入されるパスはワークスペース相対パス。

### PDF（ページ単位取り込みの詳細）

- 各ページで「モード」切替が可能（`Auto` / `PDFテキスト` / `OCR`）。
- `Auto` はテキスト長が十分（空白除外で24文字以上）ならPDFテキスト、足りなければOCR。
- `PDFテキスト` はページのテキストレイヤーから抽出した文を使用。
- `OCR` はページ画像を Tesseract.js で認識。
- OCR言語は設定の `OCR言語` が使われる（`jpn+eng` / `eng` / `jpn`）。
- OCRが失敗/空の場合はアイテムがエラー表示になり、挿入できない。
- OCR言語を変更した場合、同じページで「OCR」に切り替え直すと再OCRされる。

### Magic Capture（ウィンドウ選択 → 範囲切り取り）

- 取り込みパネルの「カメラ」ボタン、または設定したショートカットで起動（デフォルト `Ctrl+Shift+2`）。
- アプリウィンドウが存在する間のみ有効。閉じるとショートカットは無効。
- 起動するとウィンドウ一覧モーダルが出る。
  - ウィンドウのサムネイル・タイトル・アプリ名が一覧表示。
  - 検索ボックスでフィルタ可能。
- ウィンドウを選ぶと切り取りモーダルへ。
  - サムネイル画像上でドラッグして範囲指定。
  - 初期選択は中央60%。
  - 「やり直す」はウィンドウ選択に戻る。
  - 「キャンセル」は終了。
  - 「切り取る」で確定。
- 確定した画像は「図アイテム（タグ: キャプチャ）」として取り込みリストに追加され、LaTeX出力が生成される。
- キャプチャはウィンドウのサムネイル画像（最大 1600×900）を使うため、解像度はその範囲に制限される。

### 取り込み設定（パネル内の設定）

- デフォルト挿入形式
  - 数式（未使用だが設定は存在）: `inline` / `display` / `align*` / `gather*`
  - 表: `tabular` / `tabularx` / `longtable`
  - 図: `includegraphics` / `figure`
- OCR言語: `jpn+eng` / `eng` / `jpn`
- PDFモード（新規PDFアイテムの初期値）: `Auto` / `PDFテキスト` / `OCR`
- ショートカット: Magic Capture の起動キー
- これらは「新規アイテムの初期値」に影響。既存アイテムは個別に変更可能。

### 現状の範囲（できること／まだ無いこと）

- できること
  - HTMLのテーブルと本文を分離して取り込む。
  - PDFを全ページ取り込みし、ページ単位でPDFテキスト/OCRを切り替える。
  - 画像/キャプチャを図として保存・挿入する。
- まだ無いこと
  - 画像から数式/表/本文を自動分類する処理。
  - 画像から本文OCRや数式OCRを直接生成する処理。
  - レイアウト分解（画像+本文の自動分解）。

## タスク

現在: 未登録（追加する場合はこのセクションに追記）。
