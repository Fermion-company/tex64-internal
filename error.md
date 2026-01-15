# エラー発生ポイント一覧
エラーメッセージではなく、「どこでエラーが出うるか」を整理した一覧です。

## Web: Issues (updateIssues)
- `web-src/app/bridge-sender.ts`: `postToNative` でブリッジ未接続のとき (非E2E)。
- `web-src/app/editor-session-file-ops.ts`: `requestOpenFile` の postToNative 失敗 / `saveCurrentFileInternal` が非テキスト or 未選択 / `handleOpenFileResult` の `payload.error` / `handleSaveResult` の `payload.ok === false`。
- `web-src/app/ui-events.ts`: `saveCurrentFile` の reject を受けたとき。
- `web-src/app/file-tree-ui.ts`: ワークスペース未選択での作成/移動 / `validatePath` エラー / 移動先不正 / 未保存が含まれるリネーム・移動。
- `web-src/app/file-tree-utils.ts`: `validatePath` のバリデーション失敗。
- `web-src/app/root-selector-ui.ts`: ルート設定/検出でワークスペース未選択。
- `web-src/app/build-ops-ui.ts`: SyncTeX 対象が .tex 以外 / format 요청の postToNative 失敗 / format 結果が `ok=false` / SyncTeX 結果が `ok=false`。
- `web-src/app/blocks/insert-flow.ts`: ブロック挿入時に .tex 以外。
- `web-src/app/alchemy-convert.ts`: 取り込みの挿入先が .tex 以外 / Monaco未準備。
- `web-src/main.ts`: 数式キャプチャ画像なし / OCR結果が空 / OCR 例外 / MathLive 初期化例外。
- `web-src/app/math-capture.ts`: キャプチャAPI未提供 / listSources 失敗 / 取得件数0 / crop 失敗。
- `web-src/app/math-ocr.ts`: 画像ロード失敗 / canvas 初期化失敗 / 数式OCRブリッジ未提供 / OCR結果空。
- `web-src/app/ocr.ts`: 画像なし / Tesseract 例外。

## Web: Fallback / Inline / Status (Issues 以外)
- `web-src/app/monaco-setup.ts`: editor host/loader/monaco 初期化失敗 → フォールバック表示。
- `web-src/app/editor-session-file-ops.ts`: Monaco 未準備 → フォールバック表示。
- `web-src/app/blocks/insert-flow.ts`: Monaco 未準備 → フォールバック表示。
- `web-src/app/blocks/mathlive.ts`: MathLive 未ロード/タイムアウト → UI エラー表示。
- `web-src/app/file-tree-ui.ts`: リネーム入力が空/`/`を含む → モーダル内ヘルプのみ。
- `web-src/app/alchemy-convert.ts`: OCR失敗/容量/入力不正 → ステータス行。
- `web-src/app/magic-capture.ts`: キャプチャ失敗 → Alchemy のステータス行。
- `web-src/app/ai-chat-ui.ts`: 提案適用失敗/handleError → チャット内表示。

## Native: Build / SyncTeX / Format
- `electron/services/build.cjs`: main.tex 不在 / latexmk 未検出 / latexmk 実行失敗 / LaTeXログ解析で error/warning。
- `electron/handlers/build.cjs`: ワークスペース未選択でビルド中断 / ビルド中多重実行 / PDF未生成 / format の失敗。
- `electron/services/synctex.cjs`: synctex 未検出 / PDF/TeX 不在 / 解析失敗 / 位置情報なし。
- `electron/handlers/build.cjs`: Synctex forward で workspace/path/pdf 不備 → `synctex:forwardResult` 失敗。
- `electron/services/formatter.cjs`: root/path 不正 / latexindent 未検出 / 設定テンプレート読み込み失敗 / latexindent 実行失敗。
- `electron/handlers/workspace.cjs`: formatFile/formatContent の失敗/警告。

## Native: Workspace / File Ops
- `electron/handlers/workspace.cjs`: open/save/create/rename/move/copy/delete/undo で workspace 未選択 or fs 例外。
- `electron/handlers/workspace.cjs`: reveal/open terminal の実行失敗。
- `electron/services/workspace.cjs`: パス/名前/文字コード/存在/空でない/移動先不正/キャンセルの検出。

## AI Agent
- `electron/services/agent.cjs`: `applyProposal` で proposal 未検出 / workspace 未選択 / fs 例外。
- `electron/services/agent.cjs`: `executeToolCall` の入力検証 (path/paths/command/edits/oldPath/newPath)。
- `electron/services/agent.cjs`: パス制限 (read/write/edit/delete/rename/mkdir)。
- `electron/services/agent.cjs`: サイズ制限/バイナリ制限/見つからない/変更なし/検索不一致。
- `electron/services/agent.cjs`: AI 実行中の Abort/例外/空応答/反復上限。
