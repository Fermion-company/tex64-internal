# tex180
ElectronベースのTeXエディタ（開発中）。

## このREADMEの役割
- 設計/運用/タスクの単一ソース。
- 旧メモ類は参照せず、このREADMEを更新する。

## 開発
1. `npm install`（初回のみ）
2. `npm run web:build`
3. `npm run electron:dev`

## 編集ルール（重要）
- ロジック変更は `web-src/**/*.ts` で行う。`Resources/web/**/*.js` は生成物のため直接編集しない。
- `npm run web:build` で `Resources/web/main.js` と `Resources/web/app/*.js` を更新する。
- UI見た目のみの調整は `Resources/web/index.html` / `Resources/web/theme.css` を使う（ロジックは触らない）。

## 構成
- Electron殻: `electron/main.cjs` がメインUIを起動（別ウィンドウのブロック編集は廃止）。
- Bridge: `electron/preload.cjs` が `window.tex180Bridge` を公開しIPCを中継。
- Web UI: `Resources/web/index.html` + `Resources/web/main.js` + `Resources/web/app/*.js`（生成物）。
- PDFビューア: `Resources/web/pdf-viewer.html` / `Resources/web/pdf-viewer.js` / `Resources/web/pdf-viewer.css`。
- Monaco: `web-src/main.ts`（エントリ） + `web-src/app/*`。
- Services: `electron/services/*` がワークスペース/ビルド/検索/Git/Indexer/PDFを担当。

## UIマップ（主要パーツ）
- Sidebar tabs: files / outline / blocks / issues / git / search / settings。
- File explorer: `#workspace-label`, `#file-tree`。
- Editor: `#editor`, `#editor-tabs`, `#build-button`, `#editor-viewer`。
- Issues: `#issues-panel`, `#issues-list`, `#issues-log`。
- Quick insert: `#quick-insert`, `#quick-input`, `#quick-accept`, `#quick-cancel`。
- Modals: `#create-modal`, `#rename-modal`, `#diff-modal`。

## 方針（UX/安定性）
- 安定性最優先（入力が壊れない/落ちない/状態が迷子にならない）。
- 自動確定は禁止（提案はOK、確定はユーザー操作のみ）。
- 重い処理は非同期（Index/BuildはUIをブロックしない）。
- PDF更新はビルド成功時のみ、失敗時は前回成功PDFを保持。
- ログ洪水禁止（Issuesが一次窓口）。
- UI構成はVSCode風（左タブ/右エディタ/下部ステータス）。

## 現行仕様（要点）
- ブロック編集: 数式/表を自動検出 → 差分プレビュー → 確定挿入。`verbatim` 系は対象外。
- SyncTeX:
  - ビルド成功時のみ forward（設定: 「ビルド時SyncTeX」）。
  - PDF側クリックで「ソースにジャンプ」ボタンを表示し、押下時のみ reverse。
  - PDFビューアの操作UIは「再読み込み」のみ。
- Issues:
  - `IssueItem` に path/line/column を保持し、クリックで該当ファイルにジャンプ。
- 自動保存:
  - テキスト編集はアイドル後に自動保存（保存ボタンは廃止、Cmd+Sは利用可）。

## タスク
### 残タスク（優先度順）
#### P0（最優先）
1. git
2. synctex
3. pdf viewer
4. issue
5. 数式挿入関連
6. 差分プレビュー
7. AI
8. インテンド
9. 
