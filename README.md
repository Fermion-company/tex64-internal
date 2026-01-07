# tex180

Electron ベースの TeX エディタ（開発中）。

## この README の役割

- 設計/運用/タスクの単一ソース。
- 旧メモ類は参照せず、この README を更新する。

## 開発

1. `npm install`（初回のみ）
2. `npm run web:build`
3. `npm run electron:dev`

## 編集ルール（重要）

- ロジック変更は `web-src/**/*.ts` で行う。`Resources/web/**/*.js` は生成物のため直接編集しない。
- `npm run web:build` で `Resources/web/main.js` と `Resources/web/app/*.js` を更新する。
- UI 見た目のみの調整は `Resources/web/index.html` / `Resources/web/theme.css` を使う（ロジックは触らない）。

## 構成

- Electron 殻: `electron/main.cjs` がメイン UI を起動（別ウィンドウのブロック編集は廃止）。
- Bridge: `electron/preload.cjs` が `window.tex180Bridge` を公開し IPC を中継。
- Web UI: `Resources/web/index.html` + `Resources/web/main.js` + `Resources/web/app/*.js`（生成物）。
- PDF ビューア: `Resources/web/pdf-viewer.html` / `Resources/web/pdf-viewer.js` / `Resources/web/pdf-viewer.css`。
- Monaco: `web-src/main.ts`（エントリ） + `web-src/app/*`。
- Services: `electron/services/*` がワークスペース/ビルド/検索/Git/Indexer/PDF を担当。

## UI マップ（主要パーツ）

- Sidebar tabs: files / outline / blocks / issues / git / search / settings。
- File explorer: `#workspace-label`, `#file-tree`, `#save-file-button`。
- Editor: `#editor`, `#editor-tabs`, `#build-button`, `#editor-viewer`。
- Issues: `#issues-panel`, `#issues-list`, `#issues-log`。
- Quick insert: `#quick-insert`, `#quick-input`, `#quick-accept`, `#quick-cancel`。
- Modals: `#create-modal`, `#rename-modal`, `#diff-modal`。

## 方針（UX/安定性）

- 安定性最優先（入力が壊れない/落ちない/状態が迷子にならない）。
- 自動確定は禁止（提案は OK、確定はユーザー操作のみ）。
- 重い処理は非同期（Index/Build は UI をブロックしない）。
- PDF 更新はビルド成功時のみ、失敗時は前回成功 PDF を保持。
- ログ洪水禁止（Issues が一次窓口）。
- UI 構成は VSCode 風（左タブ/右エディタ/下部ステータス）。

## 現行仕様（要点）

- ブロック編集: 数式/表を自動検出 → 差分プレビュー → 確定挿入。`verbatim` 系は対象外。
- SyncTeX:
  - ビルド成功時のみ forward（設定: 「ビルド時 SyncTeX」）。
  - PDF 側クリックで「ソースにジャンプ」ボタンを表示し、押下時のみ reverse。
  - PDF ビューアの操作 UI は「再読み込み」のみ。
- Issues:
  - `IssueItem` に path/line/column を保持し、クリックで該当ファイルにジャンプ。

## タスク
現在:
インデント documentはインテンドしない 文中の環境も強制インデント


5. 数式挿入関連
11. 予測
1. git
7. AI
4. issue
画面分割およびウィンドウ


順番 
6. 差分プレビュー
1.それぞれの設定のUI